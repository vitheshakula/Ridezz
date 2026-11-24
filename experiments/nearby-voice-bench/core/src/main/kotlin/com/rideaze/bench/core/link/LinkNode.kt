package com.rideaze.bench.core.link

import com.rideaze.bench.core.MonotonicClock
import com.rideaze.bench.core.U32
import com.rideaze.bench.core.clock.ClockEstimator
import com.rideaze.bench.core.clock.ProbeSample
import com.rideaze.bench.core.measure.Recorder
import com.rideaze.bench.core.protocol.CorruptPayloadFrame
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.protocol.FrameHeader
import com.rideaze.bench.core.protocol.FrameParser
import com.rideaze.bench.core.protocol.ValidFrame
import com.rideaze.bench.core.protocol.Wire
import com.rideaze.bench.core.run.ScenarioSpec
import com.rideaze.bench.core.transport.LinkEvents
import com.rideaze.bench.core.transport.SubmitCallback
import com.rideaze.bench.core.transport.TransferStatus
import com.rideaze.bench.core.transport.Transport

interface LinkHandler {
    fun onAudio(frame: ValidFrame)
    fun onCorrupt(frame: CorruptPayloadFrame)
    fun onEnd(header: FrameHeader, payload: ByteArray, rxMs: Long)
    /** Receiver finished collecting (completion handshake). Only meaningful to a sender. */
    fun onDone()
    /** Called on the platform callback thread: implementations must only record the event, never do heavy work. */
    fun onPeerLost()
    fun onScenarioMismatch()
}

/**
 * One end of the bench link. It is created when the Nearby connection is established, BEFORE any run starts, so it
 * answers clock probes from the first moment (receiver-first startup) and never dereferences an unset handler.
 *
 * Original description: parses inbound bytes, answers clock probes, optionally initiates them.
 * Probe and END frames are control traffic: they are not part of the audio ledger.
 * All state is guarded by [lock]; sessions use the same lock so callbacks from any thread are safe.
 */
class LinkNode(
    private val clock: MonotonicClock,
    val transport: Transport,
    private val recorder: Recorder,
    private val spec: ScenarioSpec,
    private val epoch: Int,
    private val fingerprint: Long,
    private val initiatesProbes: Boolean,
) : LinkEvents {
    val lock = Any()

    /** Audio/END/DONE seen while no session is attached. A receiver that arms late must report this as a configuration error. */
    var unhandledAudioFrames = 0L; private set

    private val idleHandler = object : LinkHandler {
        override fun onAudio(frame: ValidFrame) { unhandledAudioFrames++ }
        override fun onCorrupt(frame: CorruptPayloadFrame) { unhandledAudioFrames++ }
        override fun onEnd(header: FrameHeader, payload: ByteArray, rxMs: Long) {}
        override fun onDone() {}
        override fun onPeerLost() {}
        override fun onScenarioMismatch() {}
    }

    /** A session that is attached but not yet armed reports frames it had to ignore through here. */
    fun countUnhandledAudio() { synchronized(lock) { unhandledAudioFrames++ } }

    /** Never null: sessions replace the idle handler when they attach. */
    @Volatile var handler: LinkHandler = idleHandler
    val parser = FrameParser()
    val estimator = ClockEstimator()

    var wrongEpochFrames = 0L; private set
    var probesSent = 0L; private set
    var probeRepliesMatched = 0L; private set
    var probesTimedOut = 0L; private set
    var probeSubmitRejected = 0L; private set
    var scenarioMismatch = false; private set
    var peerConnected = false; private set

    private var probing = false
    private var nextProbeAtMs = 0L
    private var probeSeq = 0L
    private val outstanding = LinkedHashMap<Long, Long>() // seq -> t0 (u32)
    private val noop = object : SubmitCallback {
        override fun onAccepted() {}
        override fun onRejected(code: Int, message: String) { synchronized(lock) { probeSubmitRejected++ } }
        override fun onTransferResult(status: TransferStatus) {}
    }

    fun startProbing(nowMs: Long) { synchronized(lock) { probing = true; nextProbeAtMs = nowMs } }
    fun stopProbing() { synchronized(lock) { probing = false } }

    override fun onPeerConnected() { synchronized(lock) { peerConnected = true } }
    override fun onPeerDisconnected() {
        synchronized(lock) {
            peerConnected = false
            parser.endOfStream()
            handler.onPeerLost()
        }
    }

    override fun onBytes(bytes: ByteArray, rxMs: Long) {
        synchronized(lock) { parser.feed(bytes, 0, bytes.size, rxMs) { dispatch(it.header, it) } }
    }

    private fun dispatch(h: FrameHeader, ev: Any) {
        if (h.epoch != epoch) { wrongEpochFrames++; return }
        when (ev) {
            is CorruptPayloadFrame -> if (h.kind == Wire.KIND_AUDIO) handler.onCorrupt(ev)
            is ValidFrame -> when (h.kind) {
                Wire.KIND_AUDIO -> if (h.stream == Wire.STREAM_AUDIO) handler.onAudio(ev)
                Wire.KIND_END -> handler.onEnd(h, ev.payload, ev.rxMs)
                Wire.KIND_DONE -> handler.onDone()
                Wire.KIND_PROBE -> answerProbe(h, ev)
                Wire.KIND_PROBE_REPLY -> acceptReply(h, ev)
            }
        }
    }

    private fun answerProbe(h: FrameHeader, f: ValidFrame) {
        if (f.payload.size != 8) return
        val t0 = FrameCodec.getU32(f.payload, 0)
        val fp = FrameCodec.getU32(f.payload, 4)
        if (fp != fingerprint) markMismatch()
        val t1 = U32.wrap(f.rxMs)
        val t2 = U32.wrap(clock.nowMs()) // stamped as late as possible, immediately before submit
        val p = ByteArray(16)
        FrameCodec.putU32(p, 0, t0); FrameCodec.putU32(p, 4, t1); FrameCodec.putU32(p, 8, t2); FrameCodec.putU32(p, 12, fingerprint)
        transport.submit(FrameCodec.encode(Wire.KIND_PROBE_REPLY, 0, epoch, Wire.STREAM_CONTROL, h.seq, t2, p), noop)
    }

    private fun acceptReply(h: FrameHeader, f: ValidFrame) {
        if (f.payload.size != 16) return
        val expectedT0 = outstanding.remove(h.seq) ?: return
        val t0 = FrameCodec.getU32(f.payload, 0)
        if (t0 != expectedT0) return
        val fp = FrameCodec.getU32(f.payload, 12)
        if (fp != fingerprint) { markMismatch(); return }
        val s = ProbeSample(t0, FrameCodec.getU32(f.payload, 4), FrameCodec.getU32(f.payload, 8), U32.wrap(f.rxMs), f.rxMs)
        probeRepliesMatched++
        val ok = estimator.add(s)
        recorder.probe(h.seq, s.t0, s.t1, s.t2, s.t3, s.delayMs, s.offsetMs, ok)
    }

    private fun markMismatch() {
        if (!scenarioMismatch) { scenarioMismatch = true; handler.onScenarioMismatch() }
    }

    fun tick(nowMs: Long) {
        synchronized(lock) {
            parser.tick(nowMs)
            val it = outstanding.entries.iterator()
            // outstanding probes older than 5 s are given up on
            while (it.hasNext()) {
                val e = it.next()
                if (probeSentAt[e.key]?.let { t -> nowMs - t > 5_000 } == true) { it.remove(); probeSentAt.remove(e.key); probesTimedOut++ }
            }
            if (probing && peerConnected && nowMs >= nextProbeAtMs) {
                sendProbe(nowMs)
                nextProbeAtMs = nowMs + if (probesSent < spec.initialProbes) spec.initialProbeSpacingMs else spec.probeIntervalMs
            }
        }
    }

    private val probeSentAt = HashMap<Long, Long>()

    private fun sendProbe(nowMs: Long) {
        val seq = probeSeq++
        val t0 = U32.wrap(clock.nowMs())
        outstanding[seq] = t0
        probeSentAt[seq] = nowMs
        probesSent++
        val p = ByteArray(8)
        FrameCodec.putU32(p, 0, t0); FrameCodec.putU32(p, 4, fingerprint)
        transport.submit(FrameCodec.encode(Wire.KIND_PROBE, 0, epoch, Wire.STREAM_CONTROL, seq, t0, p), noop)
    }

    fun sendEnd(generated: Long, cb: SubmitCallback) {
        val p = ByteArray(4)
        FrameCodec.putU32(p, 0, generated)
        transport.submit(FrameCodec.encode(Wire.KIND_END, Wire.FLAG_FINAL, epoch, Wire.STREAM_AUDIO, generated, U32.wrap(clock.nowMs()), p), cb)
    }

    /** Receiver -> sender: collection finished, safe to hang up. Best effort. */
    fun sendDone(cb: SubmitCallback) {
        synchronized(lock) { transport.submit(FrameCodec.encode(Wire.KIND_DONE, Wire.FLAG_FINAL, epoch, Wire.STREAM_CONTROL, 0, U32.wrap(clock.nowMs()), ByteArray(0)), cb) }
    }

    fun probeStats(): Map<String, Any?> = linkedMapOf(
        "initiator" to initiatesProbes, "sent" to probesSent, "matched" to probeRepliesMatched, "timed_out" to probesTimedOut,
        "submit_rejected" to probeSubmitRejected, "estimator_accepted" to estimator.acceptedProbes,
        "estimator_rejected" to estimator.rejectedProbes, "scenario_mismatch" to scenarioMismatch,
    )
}
