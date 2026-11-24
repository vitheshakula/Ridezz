package com.rideaze.bench.core.run

import com.rideaze.bench.core.MonotonicClock
import com.rideaze.bench.core.U32
import com.rideaze.bench.core.link.LinkHandler
import com.rideaze.bench.core.link.LinkNode
import com.rideaze.bench.core.measure.DropCode
import com.rideaze.bench.core.measure.Recorder
import com.rideaze.bench.core.measure.SenderLedger
import com.rideaze.bench.core.protocol.CorruptPayloadFrame
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.protocol.FrameHeader
import com.rideaze.bench.core.protocol.Prbs
import com.rideaze.bench.core.protocol.ValidFrame
import com.rideaze.bench.core.protocol.Wire
import com.rideaze.bench.core.queue.BoundedFrameQueue
import com.rideaze.bench.core.queue.QueuedFrame
import com.rideaze.bench.core.transport.SubmitCallback
import com.rideaze.bench.core.transport.TransferStatus

enum class Phase { IDLE, RUNNING, DRAINING, ENDING, FINISHED }

/**
 * Generates synthetic 20 ms frames, queues them in a bounded queue, and submits them to the transport.
 * Drive with [tick] every few ms. Never blocks; every frame ends in exactly one ledger state.
 *
 * Completion lifecycle: after the last frame the sender sends END (re-sent until acknowledged) and KEEPS THE
 * CONNECTION until the receiver's DONE arrives or [ScenarioSpec.senderEndWaitMs] expires. A peer that closes
 * after END was sent is a normal completion; a peer that disappears earlier is a genuine failure.
 * Callback-thread entry points ([onPeerLost] etc.) only record state; all finalisation happens in [tick].
 */
class SenderSession(
    private val spec: ScenarioSpec,
    private val clock: MonotonicClock,
    private val link: LinkNode,
    private val recorder: Recorder,
    private val epoch: Int,
    private val runIndex: Int,
    private val ctx: RunContext = NoContext,
) : LinkHandler {
    val ledger = SenderLedger()
    var phase = Phase.IDLE; private set
    var status = "not_started"; private set

    private val lock get() = link.lock
    private val queue = BoundedFrameQueue(spec.queueCapacity, spec.overflowPolicy, spec.sendExpiryMs)
    private val slots = LinkedHashMap<Long, Long>() // seq -> submit time, frames awaiting release
    private var startMs = 0L
    private var nextSeq = 0L
    private var drainStartMs = 0L
    private var endSentMs = 0L
    private var lastEndMs = 0L
    private var pumping = false
    private var blockedSinceMs: Long? = null
    private var stallCount = 0L
    private var stallTotalMs = 0L
    private var stallMaxMs = 0L
    private var inflightTimeouts = 0L
    private val apiFailures = LinkedHashSet<String>()
    private val extraFlags = LinkedHashSet<DeviceFlag>()
    private val faults = LinkedHashSet<String>()
    private var peerLostSeen = false
    private var peerLostHandled = false
    private var doneReceived = false
    /** Set BEFORE END is first submitted: a DONE can only be a reply to an END, so one that arrives earlier is stale or foreign. */
    private var endSent = false
    private var prematureDone = 0L
    private var endRejected = 0L
    private val endRejectNotes = ArrayList<String>()

    init { link.handler = this }

    fun start() = synchronized(lock) {
        check(phase == Phase.IDLE) { "already started" }
        val errs = spec.validate()
        startMs = clock.nowMs()
        recorder.runStart(specMap(), runIndex, epoch, spec.fingerprint(runIndex), ctx.deviceInfo(), AcceptanceProposal.toMap(), Wire.FIXED_OVERHEAD)
        if (errs.isNotEmpty()) { finish("config_error", errs); return@synchronized }
        phase = Phase.RUNNING; status = "running"
    }

    fun tick(nowMs: Long) = synchronized(lock) {
        if (phase == Phase.IDLE || phase == Phase.FINISHED) return@synchronized
        link.tick(nowMs)
        // Deterministic precedence when DONE and a disconnect are both recorded by the time we look: DONE proves the receiver
        // finished, so the run is a normal completion whichever of the two callbacks the platform delivered first.
        if (phase == Phase.ENDING && doneReceived) { finish("complete", emptyList()); return@synchronized }
        if (peerLostSeen && !peerLostHandled) { peerLostHandled = true; handlePeerLost() }
        if (phase == Phase.FINISHED) return@synchronized
        sweepInFlight(nowMs)
        when (phase) {
            Phase.RUNNING -> {
                while (nextSeq < spec.totalFrames && startMs + nextSeq * 20 <= nowMs) { generate(nextSeq, startMs + nextSeq * 20); nextSeq++; pump(nowMs, true) }
                pump(nowMs, false)
                if (nextSeq >= spec.totalFrames) { phase = Phase.DRAINING; drainStartMs = nowMs }
            }
            Phase.DRAINING -> {
                pump(nowMs, false)
                if ((queue.isEmpty() && slots.isEmpty()) || nowMs - drainStartMs >= spec.drainGraceMs) {
                    for (f in queue.drainAll()) ledger.dropped(f.seq, DropCode.END_OF_RUN)
                    endSent = true
                    sendEnd()
                    phase = Phase.ENDING; endSentMs = nowMs; lastEndMs = nowMs
                }
            }
            Phase.ENDING -> when {
                doneReceived -> finish("complete", emptyList())
                nowMs - endSentMs >= spec.senderEndWaitMs -> finish("complete_no_done", emptyList())
                nowMs - lastEndMs >= spec.endResendIntervalMs -> { sendEnd(); lastEndMs = nowMs }
            }
            else -> {}
        }
    }

    /** Operator stop or fatal fault. Idempotent. */
    fun abort(reason: String, flag: DeviceFlag? = null) = synchronized(lock) {
        if (phase == Phase.FINISHED) return@synchronized
        if (phase == Phase.IDLE) { phase = Phase.FINISHED; status = "aborted:$reason"; return@synchronized }
        if (flag != null) extraFlags.add(flag)
        for (f in queue.drainAll()) ledger.dropped(f.seq, DropCode.END_OF_RUN)
        finish("aborted:$reason", emptyList())
    }

    /** Implementation defect observed by the host app (e.g. an exception in the driver loop). Classified IMPLEMENTATION. */
    fun recordFault(msg: String) = synchronized(lock) { if (faults.size < 10) faults.add(msg) }

    /** Platform/API failure observed by the host app (e.g. startDiscovery failed). Classified API. */
    fun recordApiFailure(msg: String) = synchronized(lock) { if (apiFailures.size < 10) apiFailures.add(msg) }

    // ---- callback-thread entry points: record only -------------------------------------------------------------
    override fun onPeerLost() { peerLostSeen = true }
    override fun onDone() { if (endSent) doneReceived = true else prematureDone++ }
    override fun onScenarioMismatch() {}
    override fun onAudio(frame: ValidFrame) {}
    override fun onCorrupt(frame: CorruptPayloadFrame) {}
    override fun onEnd(header: FrameHeader, payload: ByteArray, rxMs: Long) {}

    private fun handlePeerLost() {
        when (phase) {
            // END was already sent: the receiver closing is how a finished receiver tears down. Not a failure.
            Phase.ENDING -> if (doneReceived) finish("complete", emptyList()) else finish("complete_peer_closed", emptyList())
            // Anywhere earlier the peer vanished mid-run: genuine failure.
            else -> {
                extraFlags.add(DeviceFlag.PEER_DISCONNECTED)
                for (f in queue.drainAll()) ledger.dropped(f.seq, DropCode.END_OF_RUN)
                finish("aborted:peer_disconnected", emptyList())
            }
        }
    }

    private fun sendEnd() {
        link.sendEnd(nextSeq, object : SubmitCallback {
            override fun onAccepted() {}
            // Not an API failure by itself: whether a rejected END matters depends on how the run ended (see finish()).
            override fun onRejected(code: Int, message: String) { synchronized(lock) { endRejected++; if (endRejectNotes.size < 3) endRejectNotes.add("code=$code $message") } }
            override fun onTransferResult(status: TransferStatus) {}
        })
    }

    private fun generate(seq: Long, genMs: Long) {
        val payload = Prbs.generate(Wire.STREAM_AUDIO, seq, spec.payloadBytes)
        val bytes = FrameCodec.encode(Wire.KIND_AUDIO, 0, epoch, Wire.STREAM_AUDIO, seq, U32.wrap(genMs), payload)
        ledger.generated(seq, genMs, bytes.size)
        val dropped = queue.offer(QueuedFrame(seq, genMs, bytes))
        if (dropped != null) ledger.dropped(dropped.seq, DropCode.SRC_FULL)
    }

    private fun pump(nowMs: Long, generationTriggered: Boolean) {
        if (pumping) return
        pumping = true
        try {
            var windowDropDone = false
            while (true) {
                if (slots.size >= spec.maxInFlight) {
                    if (!queue.isEmpty()) {
                        if (spec.mode == Mode.REALTIME && generationTriggered && !windowDropDone) {
                            queue.dropOldest()?.let { ledger.dropped(it.seq, DropCode.WINDOW_FULL) }
                            windowDropDone = true
                        }
                        if (blockedSinceMs == null && !queue.isEmpty()) blockedSinceMs = nowMs
                    }
                    break
                }
                val f = queue.pollLive(nowMs) { ledger.dropped(it.seq, DropCode.SRC_EXPIRED) } ?: break
                closeStall(nowMs)
                submit(f, nowMs)
            }
            if (queue.isEmpty()) closeStall(nowMs)
        } finally { pumping = false }
    }

    private fun closeStall(nowMs: Long) {
        val s = blockedSinceMs ?: return
        blockedSinceMs = null
        val d = nowMs - s
        if (d >= spec.stallThresholdMs) {
            stallCount++; stallTotalMs += d; if (d > stallMaxMs) stallMaxMs = d
            recorder.event("stall_submit", "ms=$d")
        }
    }

    private fun submit(f: QueuedFrame, nowMs: Long) {
        ledger.submitStarted(f.seq, nowMs)
        slots[f.seq] = nowMs
        val seq = f.seq
        link.transport.submit(f.bytes, object : SubmitCallback {
            override fun onAccepted() {
                synchronized(lock) {
                    ledger.accepted(seq, clock.nowMs())
                    if (spec.windowRelease == WindowRelease.ACCEPTED) slots.remove(seq)
                }
            }
            override fun onRejected(code: Int, message: String) {
                synchronized(lock) {
                    ledger.rejected(seq, code, clock.nowMs()); slots.remove(seq)
                    if (apiFailures.size < 10) apiFailures.add("submit rejected code=$code $message")
                }
            }
            override fun onTransferResult(status: TransferStatus) {
                synchronized(lock) { ledger.transfer(seq, status == TransferStatus.SUCCESS, clock.nowMs()); slots.remove(seq) }
            }
        })
    }

    private fun sweepInFlight(nowMs: Long) {
        val it = slots.entries.iterator()
        while (it.hasNext()) {
            val e = it.next()
            if (nowMs - e.value > spec.inFlightTimeoutMs) { it.remove(); inflightTimeouts++ }
        }
    }

    private fun specMap(): Map<String, Any?> = linkedMapOf(
        "id" to spec.id, "mode" to spec.mode.code, "transport" to spec.transport, "encoded_kbps" to spec.encodedKbps,
        "payload_bytes" to spec.payloadBytes, "wire_bytes_per_frame" to spec.wireBytesPerFrame, "wire_kbps" to spec.wireKbps,
        "frame_rate_hz" to spec.frameRateHz, "duration_s" to spec.durationS, "repeats" to spec.repeats,
        "queue_capacity" to spec.queueCapacity, "overflow_policy" to spec.overflowPolicy, "send_expiry_ms" to spec.sendExpiryMs,
        "max_in_flight" to spec.maxInFlight, "in_flight_timeout_ms" to spec.inFlightTimeoutMs, "window_release" to spec.windowRelease,
        "playout_deadline_ms" to spec.playoutDeadlineMs, "stall_threshold_ms" to spec.stallThresholdMs,
    )

    private fun finish(st: String, configErrors: List<String>) {
        ledger.finalizeRun()
        status = st
        for (r in ledger.all()) recorder.frameTx(r)
        val inv = ledger.violations(true) + faults
        val c = ledger.counts()
        val completed = st.startsWith("complete")
        val cfg = ArrayList(configErrors)
        cfg.addAll(ctx.configErrors())
        if (link.wrongEpochFrames > 0) cfg.add("${link.wrongEpochFrames} frames carried a different run epoch (phones use different run indexes, or a stale run)")
        // Callback problems are PLATFORM behaviour: classified API, never as proven transport capacity limits.
        val api = LinkedHashSet<String>(apiFailures)
        api.addAll(ledger.apiAnomalyNotes()); api.addAll(ctx.apiFailures())
        if (inflightTimeouts > 0) api.add("$inflightTimeouts in-flight slots timed out after ${spec.inFlightTimeoutMs} ms: transfer callbacks missing or late, window results are not interpretable")
        if (completed && spec.windowRelease == WindowRelease.TRANSFER_RESULT && c.acceptedWithoutTransferReport > 0)
            api.add("${c.acceptedWithoutTransferReport} accepted submissions never received a transfer result (sender-side BYTES updates unverified; consider windowRelease=ACCEPTED)")
        // END rejections: expected when the peer had already closed or confirmed completion; a genuine transmission failure when
        // the receiver never confirmed (the END could not be delivered) while the connection was still believed to be up.
        val endDisposition = when {
            endRejected == 0L -> "none"
            st == "complete" -> "benign: receiver confirmed completion with DONE"
            st == "complete_peer_closed" -> "benign: peer closed after END (normal teardown)"
            st == "complete_no_done" -> "ERROR: receiver never confirmed"
            else -> "not applicable: run aborted"
        }
        if (endDisposition.startsWith("ERROR")) api.add("$endRejected END submissions were rejected and the receiver never confirmed completion (${endRejectNotes.joinToString("; ")}): END could not be delivered")
        val verdict = RunClassifier.classify(ClassifierInput(
            configErrors = cfg, isolationBreaches = ctx.isolationBreaches(), scenarioMismatch = link.scenarioMismatch,
            invariantViolations = inv, apiFailures = api.toList(), deviceFlags = ctx.deviceFlags() + extraFlags,
        ))
        recorder.runEnd(linkedMapOf(
            "status" to st,
            "counts" to linkedMapOf(
                "generated" to c.generated, "dropped_pre_submission" to c.droppedPre,
                "dropped_by_code" to c.droppedByCode, "submission_pending" to c.pending, "submission_accepted" to c.accepted,
                "submission_rejected" to c.rejected, "transfer_success" to c.transferSuccess, "transfer_failed" to c.transferFailed,
                "unresolved_submit" to c.unresolvedSubmit, "accepted_without_transfer_report" to c.acceptedWithoutTransferReport,
                "unresolved_at_termination" to c.unresolvedAtTermination, "callbacks_after_finalize" to ledger.callbacksAfterFinalize,
            ),
            "bytes" to linkedMapOf("offered_app_bytes" to c.offeredBytes, "accepted_app_bytes" to c.acceptedBytes),
            "invariants" to inv,
            "parser" to link.parser.counters.toMap(),
            "probes" to link.probeStats(),
            "stalls" to linkedMapOf("count" to stallCount, "total_ms" to stallTotalMs, "max_ms" to stallMaxMs, "threshold_ms" to spec.stallThresholdMs, "source" to "sender_window_blocked"),
            "inflight_timeouts" to inflightTimeouts,
            "wrong_epoch_frames" to link.wrongEpochFrames,
            "callbacks" to linkedMapOf(
                "duplicate" to ledger.duplicateCallbacks, "conflicting" to ledger.conflictingCallbacks,
                "transfer_before_ack" to ledger.all().count { it.transferBeforeAck }, "inflight_timeouts" to inflightTimeouts,
                "accepted_without_transfer_report" to c.acceptedWithoutTransferReport, "api_notes" to api.toList(),
                "premature_done_ignored" to prematureDone, "end_rejected" to endRejected, "end_rejection_disposition" to endDisposition,
            ),
            "callback_latency_ms" to ledger.callbackLatency(),
            "peer_done_ack" to doneReceived,
            "peer_lost" to peerLostSeen,
            "verdict" to verdict.toMap(),
        ))
        recorder.flush()
        phase = Phase.FINISHED
    }
}
