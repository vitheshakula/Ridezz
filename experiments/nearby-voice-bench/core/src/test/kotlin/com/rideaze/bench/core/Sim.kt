package com.rideaze.bench.core

import com.rideaze.bench.core.link.LinkNode
import com.rideaze.bench.core.measure.MemorySink
import com.rideaze.bench.core.measure.Reconciler
import com.rideaze.bench.core.measure.Recorder
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.protocol.Wire
import com.rideaze.bench.core.run.ReceiverSession
import com.rideaze.bench.core.run.RunContext
import com.rideaze.bench.core.run.ScenarioSpec
import com.rideaze.bench.core.run.SenderSession
import com.rideaze.bench.core.transport.SubmitCallback
import com.rideaze.bench.core.transport.TransferStatus
import com.rideaze.bench.core.transport.Transport
import java.util.PriorityQueue

class VirtualTime {
    class Ev(val t: Long, val n: Long, val r: () -> Unit)
    var now = 0L
    private var n = 0L
    private val q = PriorityQueue<Ev>(compareBy<Ev>({ it.t }, { it.n }))
    fun at(t: Long, r: () -> Unit) { q.add(Ev(maxOf(t, now), n++, r)) }
    fun runDue() { while (q.isNotEmpty() && q.peek().t <= now) q.poll().r() }
}

class SimClock(private val vt: VirtualTime, val offset: Long) : MonotonicClock { override fun nowMs() = vt.now + offset }

/** Deterministic fault injection. fromSender = true for the A->B direction. */
open class Faults {
    open fun deliverDelayMs(fromSender: Boolean, kind: Int, seq: Long): Long = 30
    open fun lose(kind: Int, seq: Long): Boolean = false
    open fun corrupt(kind: Int, seq: Long): Boolean = false
    open fun ackDelayMs(kind: Int, seq: Long): Long? = 5
    open fun completionDelayMs(kind: Int, seq: Long): Long? = 35
    open fun rejectCode(kind: Int, seq: Long): Int? = null
    open val statusOnLoss: TransferStatus = TransferStatus.FAILURE
    /** Deliver the ack and the completion callback a second time (platform duplicate). */
    open fun duplicateCallbacks(kind: Int, seq: Long): Boolean = false
    /** Deliver a contradictory second completion (SUCCESS then FAILURE). */
    open fun conflictingCompletion(kind: Int, seq: Long): Boolean = false
}

class FakeTransport(
    private val vt: VirtualTime, private val fromSender: Boolean, private val faults: Faults,
    private val peer: () -> LinkNode, private val peerClock: MonotonicClock,
    private val open: () -> Boolean = { true },
) : Transport {
    var submitted = 0L
    override fun submit(bytes: ByteArray, cb: SubmitCallback) {
        if (!open()) { vt.at(vt.now + 1) { cb.onRejected(-2, "closed") }; return }
        submitted++
        val kind = bytes[3].toInt() and 0xFF
        val seq = FrameCodec.getU32(bytes, 6)
        val t = vt.now
        faults.rejectCode(kind, seq)?.let { code -> vt.at(t + 5) { cb.onRejected(code, "fake reject") }; return }
        faults.ackDelayMs(kind, seq)?.let { d ->
            vt.at(t + d) { cb.onAccepted() }
            if (faults.duplicateCallbacks(kind, seq)) vt.at(t + d + 3) { cb.onAccepted() }
        }
        val lost = faults.lose(kind, seq)
        if (!lost) {
            val data = if (faults.corrupt(kind, seq) && bytes.size > Wire.FIXED_OVERHEAD + 3) bytes.copyOf().also { it[Wire.HEADER_SIZE + 2] = (it[Wire.HEADER_SIZE + 2].toInt() xor 0x55).toByte() } else bytes
            vt.at(t + faults.deliverDelayMs(fromSender, kind, seq)) { if (open()) peer().onBytes(data, peerClock.nowMs()) }
        }
        faults.completionDelayMs(kind, seq)?.let { d ->
            val first = if (lost) faults.statusOnLoss else TransferStatus.SUCCESS
            vt.at(t + d) { cb.onTransferResult(first) }
            if (faults.duplicateCallbacks(kind, seq)) vt.at(t + d + 3) { cb.onTransferResult(first) }
            if (faults.conflictingCompletion(kind, seq)) vt.at(t + d + 3) { cb.onTransferResult(TransferStatus.FAILURE) }
        }
    }
    override fun close() {}
}

class Sim(
    val spec: ScenarioSpec,
    val faults: Faults = Faults(),
    offA: Long = 0, offB: Long = 250,
    val senderRunIndex: Int = 0, val receiverRunIndex: Int = 0, val senderEpoch: Int = 3, val receiverEpoch: Int = 3,
    val ctxA: RunContext = com.rideaze.bench.core.run.NoContext,
    val ctxB: RunContext = com.rideaze.bench.core.run.NoContext,
    label: String = "t",
    /** Model RunController.stop(): a finished side closes the connection and the peer gets onDisconnected. */
    val teardown: Boolean = true,
    /** Virtual time at which the receiver session is armed (0 = before the sender). */
    val receiverArmMs: Long = 0,
    /** Lets a test arm the receiver with a different scenario than the sender (operator selected different options). */
    val receiverSpec: ScenarioSpec = spec,
) {
    val vt = VirtualTime()
    val clockA = SimClock(vt, offA); val clockB = SimClock(vt, offB)
    val sinkA = MemorySink(); val sinkB = MemorySink()
    val recA = Recorder(sinkA, spec.runId(senderRunIndex, label), "sender", clockA, strict = true)
    val recB = Recorder(sinkB, receiverSpec.runId(receiverRunIndex, label), "receiver", clockB, strict = true)
    var connectionOpen = true; private set
    lateinit var linkA: LinkNode; lateinit var linkB: LinkNode
    val tAB = FakeTransport(vt, true, faults, { linkB }, clockB, { connectionOpen })
    val tBA = FakeTransport(vt, false, faults, { linkA }, clockA, { connectionOpen })
    init {
        // Both links exist from connection time, exactly like RunController: sessions attach later.
        linkA = LinkNode(clockA, tAB, recA, spec, senderEpoch, spec.fingerprint(senderRunIndex), false)
        linkB = LinkNode(clockB, tBA, recB, receiverSpec, receiverEpoch, receiverSpec.fingerprint(receiverRunIndex), true)
    }
    lateinit var sender: SenderSession
    lateinit var receiver: ReceiverSession
    private val senderCreated get() = ::sender.isInitialized
    private val receiverCreated get() = ::receiver.isInitialized
    /** Null until the sender session has been created (receiver-first startup). */
    val senderPhase: com.rideaze.bench.core.run.Phase? get() = if (senderCreated) sender.phase else null
    private var senderTornAt: Long? = null
    private var receiverTornAt: Long? = null
    var firstDisconnectNotice: Long? = null; private set

    /** What RunController.stop() does: close the connection; the other side is told shortly after. */
    private fun tearDown(by: String) {
        if (!connectionOpen) return
        connectionOpen = false
        firstDisconnectNotice = vt.now + 20
        vt.at(vt.now + 20) { if (by == "sender") linkB.onPeerDisconnected() else linkA.onPeerDisconnected() }
    }

    fun run(totalMs: Long, senderStartMs: Long = 3000, skipSenderTick: (Long) -> Boolean = { false }, hook: (Long) -> Unit = {}) {
        linkA.onPeerConnected(); linkB.onPeerConnected()
        for (t in 0..totalMs) {
            vt.now = t; vt.runDue()
            if (t == receiverArmMs) { receiver = ReceiverSession(receiverSpec, clockB, linkB, recB, receiverEpoch, receiverRunIndex, ctxB); receiver.start() }
            if (t == senderStartMs) { sender = SenderSession(spec, clockA, linkA, recA, senderEpoch, senderRunIndex, ctxA); sender.start() }
            if (receiverCreated) receiver.tick(clockB.nowMs())
            if (senderCreated && !skipSenderTick(t)) sender.tick(clockA.nowMs())
            hook(t)
            if (teardown) {
                if (senderCreated && sender.phase == com.rideaze.bench.core.run.Phase.FINISHED && senderTornAt == null) { senderTornAt = t; tearDown("sender") }
                if (receiverCreated && receiver.finished && receiverTornAt == null) { receiverTornAt = t; vt.at(t + 500) { tearDown("receiver") } }
            }
        }
    }

    fun reconciliation() = Reconciler.reconcile(sender.ledger, receiver.ledger)

    @Suppress("UNCHECKED_CAST")
    fun endRecord(sink: MemorySink): Map<String, Any?> =
        sink.lines.map { MiniJson.parse(it) as Map<String, Any?> }.last { it["type"] == "run_end" }

    @Suppress("UNCHECKED_CAST")
    fun verdictOf(sink: MemorySink): String = ((endRecord(sink)["verdict"] as Map<String, Any?>)["failure_class"]) as String

    fun runEndCount(sink: MemorySink) = sink.lines.count { it.contains("\"type\":\"run_end\"") }
}
