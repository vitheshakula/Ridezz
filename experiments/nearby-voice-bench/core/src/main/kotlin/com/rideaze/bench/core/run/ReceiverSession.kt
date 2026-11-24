package com.rideaze.bench.core.run

import com.rideaze.bench.core.MonotonicClock
import com.rideaze.bench.core.clock.ClockEstimator
import com.rideaze.bench.core.clock.Latency
import com.rideaze.bench.core.clock.LatencyStatus
import com.rideaze.bench.core.link.LinkHandler
import com.rideaze.bench.core.link.LinkNode
import com.rideaze.bench.core.measure.Recorder
import com.rideaze.bench.core.measure.ReceiverLedger
import com.rideaze.bench.core.measure.RxClass
import com.rideaze.bench.core.measure.RxRecord
import com.rideaze.bench.core.protocol.CorruptPayloadFrame
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.protocol.FrameHeader
import com.rideaze.bench.core.protocol.Prbs
import com.rideaze.bench.core.protocol.ValidFrame
import com.rideaze.bench.core.protocol.Wire
import com.rideaze.bench.core.transport.SubmitCallback
import com.rideaze.bench.core.transport.TransferStatus

/**
 * Receives, validates and classifies frames. REALTIME mode compares offset-corrected one-way latency
 * (with its uncertainty) to the playout deadline; a frame is never counted as useful speech unless it is
 * provably on time. RAW mode records latency but applies no deadline.
 *
 * Completion: END received + grace period elapsed => "complete", whether or not the sender has already
 * disconnected (a disconnect AFTER END is the sender's normal teardown). A disconnect BEFORE END is a genuine
 * failure; no END at all ends as "unterminated_idle". On finishing, DONE is sent so the sender may hang up.
 * Callback-thread entry points only record state; finalisation happens in [tick].
 */
class ReceiverSession(
    private val spec: ScenarioSpec,
    private val clock: MonotonicClock,
    private val link: LinkNode,
    private val recorder: Recorder,
    private val epoch: Int,
    private val runIndex: Int,
    private val ctx: RunContext = NoContext,
) : LinkHandler {
    val ledger = ReceiverLedger()
    var finished = false; private set
    var status = "not_started"; private set

    private val lock get() = link.lock
    private var started = false
    private var endGenerated: Long? = null
    private var endRxMs = 0L
    /** Diagnostic: local time END was first received, null if never. */
    val endReceivedAtMs: Long? get() = if (endGenerated != null) endRxMs else null
    private var lastIntactRxMs: Long? = null
    private var lastAnyRxMs: Long? = null
    private var stallCount = 0L
    private var stallTotalMs = 0L
    private var stallMaxMs = 0L
    private var prbsMismatch = 0L
    private var lostPeer = false
    private var lostBeforeEnd = false
    private var peerLostHandled = false
    private val faults = LinkedHashSet<String>()
    private val apiFailures = LinkedHashSet<String>()

    init { link.handler = this }

    fun start() = synchronized(lock) {
        check(!started)
        started = true; status = "armed"
        recorder.runStart(
            linkedMapOf("id" to spec.id, "mode" to spec.mode.code, "transport" to spec.transport, "encoded_kbps" to spec.encodedKbps,
                "payload_bytes" to spec.payloadBytes, "wire_bytes_per_frame" to spec.wireBytesPerFrame, "wire_kbps" to spec.wireKbps,
                "window_release" to spec.windowRelease, "frame_rate_hz" to spec.frameRateHz, "duration_s" to spec.durationS, "repeats" to spec.repeats,
                "playout_deadline_ms" to spec.playoutDeadlineMs, "stall_threshold_ms" to spec.stallThresholdMs),
            runIndex, epoch, spec.fingerprint(runIndex), ctx.deviceInfo(), AcceptanceProposal.toMap(), Wire.FIXED_OVERHEAD,
        )
        link.startProbing(clock.nowMs())
    }

    fun tick(nowMs: Long) = synchronized(lock) {
        if (!started || finished) return@synchronized
        link.tick(nowMs)
        // Decided here, not in the callback: if END arrived by the time the disconnect is processed it counts as received,
        // whichever of the two callbacks the platform delivered first.
        if (lostPeer && !peerLostHandled) {
            peerLostHandled = true
            if (endGenerated == null) { lostBeforeEnd = true; finish("aborted:peer_disconnected"); return@synchronized }
        }
        val e = endGenerated
        if (e != null && nowMs - endRxMs >= spec.receiverFinalizeGraceMs) finish("complete")
        else if (e == null && lastAnyRxMs != null && nowMs - lastAnyRxMs!! > spec.receiverIdleTimeoutMs) finish("unterminated_idle")
    }

    /** Operator stop. */
    fun stop(reason: String = "operator_stop") = synchronized(lock) { if (started && !finished) finish("aborted:$reason") }

    fun recordFault(msg: String) = synchronized(lock) { if (faults.size < 10) faults.add(msg) }
    fun recordApiFailure(msg: String) = synchronized(lock) { if (apiFailures.size < 10) apiFailures.add(msg) }

    // ---- callback-thread entry points ------------------------------------------------------------------------
    override fun onPeerLost() {
        lostPeer = true // record only; tick() decides whether this was before or after END
    }
    override fun onScenarioMismatch() {}
    override fun onDone() {}

    override fun onAudio(frame: ValidFrame) {
        if (!started) { link.countUnhandledAudio(); return }
        if (finished) return
        val h = frame.header
        val rx = frame.rxMs
        lastAnyRxMs = rx
        val intact = Prbs.verify(h.stream, h.seq, frame.payload)
        if (!intact) {
            prbsMismatch++
            ledger.record(RxRecord(h.seq, h.txms, rx, RxClass.CORRUPT_PAYLOAD, null, null, frame.payload.size))
            return
        }
        val est = Latency.forReceivedFrame(link.estimator, h.txms, rx, clock.nowMs())
        val cls: RxClass = when (spec.mode) {
            Mode.RAW -> RxClass.VALID
            Mode.REALTIME -> {
                val d = spec.playoutDeadlineMs!!.toDouble()
                if (est.status != LatencyStatus.OK) RxClass.UNCLASSIFIED
                else {
                    val l = est.latencyMs!!; val u = est.uncertaintyMs!!
                    when {
                        l + u <= d -> RxClass.ON_TIME
                        l - u > d -> RxClass.LATE
                        else -> RxClass.UNCERTAIN
                    }
                }
            }
        }
        val isNew = ledger.record(RxRecord(h.seq, h.txms, rx, cls, est.latencyMs, est.uncertaintyMs, frame.payload.size))
        if (isNew) {
            lastIntactRxMs?.let { prev ->
                val gap = rx - prev
                if (gap > spec.stallThresholdMs) { stallCount++; stallTotalMs += gap; if (gap > stallMaxMs) stallMaxMs = gap }
            }
            lastIntactRxMs = rx
        }
    }

    override fun onCorrupt(frame: CorruptPayloadFrame) {
        if (!started) { link.countUnhandledAudio(); return }
        if (finished) return
        val h = frame.header
        lastAnyRxMs = frame.rxMs
        ledger.record(RxRecord(h.seq, h.txms, frame.rxMs, RxClass.CORRUPT_PAYLOAD, null, null, h.len))
    }

    override fun onEnd(header: FrameHeader, payload: ByteArray, rxMs: Long) {
        if (!started || finished || payload.size != 4 || endGenerated != null) return // re-sent ENDs are ignored
        endGenerated = FrameCodec.getU32(payload, 0); endRxMs = rxMs
        lastAnyRxMs = rxMs
    }

    private fun finish(st: String) {
        if (finished) return
        finished = true; status = st
        link.stopProbing()
        if (!lostPeer) link.parser.endOfStream()
        for (r in ledger.all().sortedBy { it.seq }) recorder.frameRx(r)
        val inv = ledger.violations() + faults + (if (prbsMismatch > 0) listOf("R2: $prbsMismatch CRC-valid frames failed PRBS verification (CRC collision or implementation defect)") else emptyList())
        val c = ledger.counts()
        val expected = endGenerated
        val flags = ctx.deviceFlags() + (if (lostBeforeEnd) setOf(DeviceFlag.PEER_DISCONNECTED) else emptySet())
        val cfg = ArrayList<String>()
        cfg.addAll(ctx.configErrors())
        if (link.wrongEpochFrames > 0) cfg.add("${link.wrongEpochFrames} frames carried a different run epoch (phones use different run indexes, or a stale run)")
        if (link.unhandledAudioFrames > 0) cfg.add("${link.unhandledAudioFrames} audio frames arrived before this receiver was armed: start the receiver BEFORE the sender")
        val api = LinkedHashSet<String>(apiFailures); api.addAll(ctx.apiFailures())
        val verdict = RunClassifier.classify(ClassifierInput(
            configErrors = cfg, isolationBreaches = ctx.isolationBreaches(), scenarioMismatch = link.scenarioMismatch,
            invariantViolations = inv, apiFailures = api.toList(), deviceFlags = flags,
        ))
        val est = link.estimator.estimate(clock.nowMs())
        val probes = LinkedHashMap(link.probeStats())
        if (est is ClockEstimator.Result.Ok) {
            probes["final_theta_peer_minus_self_ms"] = est.estimate.peerMinusSelfMs
            probes["final_uncertainty_ms"] = est.estimate.uncertaintyMs
            probes["final_best_delay_ms"] = est.estimate.bestDelayMs
            probes["drift_ppm"] = est.estimate.driftPpm
        } else probes["final_estimate"] = "unavailable"
        recorder.runEnd(linkedMapOf(
            "status" to st,
            "counts" to linkedMapOf(
                "received_distinct" to c.distinct, "received_intact" to c.intact,
                "by_class" to c.byClass, "after_deadline" to c.afterDeadline, "duplicates" to c.duplicates,
            ),
            "bytes" to linkedMapOf("received_valid_app_bytes" to c.intactBytes),
            "invariants" to inv,
            "parser" to link.parser.counters.toMap(),
            "probes" to probes,
            "stalls" to linkedMapOf("count" to stallCount, "total_ms" to stallTotalMs, "max_ms" to stallMaxMs, "threshold_ms" to spec.stallThresholdMs, "source" to "receiver_arrival_gap"),
            "expected_frames" to expected,
            "never_received_upper_bound" to expected?.let { maxOf(0L, it - c.distinct) },
            "unterminated" to (expected == null),
            "prbs_mismatch" to prbsMismatch,
            "wrong_epoch_frames" to link.wrongEpochFrames,
            "unhandled_audio_frames" to link.unhandledAudioFrames,
            "peer_lost" to lostPeer,
            "verdict" to verdict.toMap(),
        ))
        recorder.flush()
        if (!lostPeer) link.sendDone(object : SubmitCallback { // best effort: tells the sender it may hang up
            override fun onAccepted() {}
            override fun onRejected(code: Int, message: String) {}
            override fun onTransferResult(status: TransferStatus) {}
        })
    }
}
