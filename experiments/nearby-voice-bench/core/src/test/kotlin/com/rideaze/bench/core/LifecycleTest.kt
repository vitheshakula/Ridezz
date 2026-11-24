package com.rideaze.bench.core

import com.rideaze.bench.core.measure.RxClass
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.protocol.Prbs
import com.rideaze.bench.core.protocol.Wire
import com.rideaze.bench.core.run.Mode
import com.rideaze.bench.core.run.Phase
import com.rideaze.bench.core.run.Scenarios
import com.rideaze.bench.core.run.WindowRelease
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Completion lifecycle (review finding C1) and startup ordering (H1/M2).
 * Sim models RunController teardown: a finished side closes the connection and the peer gets onDisconnected.
 * 5 s runs: 250 frames; sender starts at t=3000.
 */
class LifecycleTest {
    private val rt = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5)
    private val raw = Scenarios.e1Bytes(24, Mode.RAW).copy(durationS = 5)

    @Suppress("UNCHECKED_CAST")
    private fun reasons(s: Sim, sink: com.rideaze.bench.core.measure.MemorySink) =
        ((s.endRecord(sink)["verdict"] as Map<String, Any?>)["reasons"] as Map<String, List<String>>)

    // ---- C1: normal completion -----------------------------------------------------------------------------------
    @Test fun normalCompletionHandshakeThenTeardownIsCleanOnBothSides() {
        val s = Sim(rt); s.run(20_000)
        assertEquals("complete", s.sender.status); assertEquals("complete", s.receiver.status)
        assertEquals(true, s.endRecord(s.sinkA)["peer_done_ack"])
        assertEquals("NONE", s.verdictOf(s.sinkA)); assertEquals("NONE", s.verdictOf(s.sinkB))
        assertEquals(false, s.endRecord(s.sinkB)["peer_lost"])
        assertEquals(250L, s.receiver.ledger.counts().byClass.getValue(RxClass.ON_TIME))
        assertEquals(1, s.runEndCount(s.sinkA)); assertEquals(1, s.runEndCount(s.sinkB))
    }

    @Test fun senderHangingUpRightAfterEndIsNotAFailureAndTheReceiverStillFinishesItsGrace() {
        // Reproduces the original defect: the sender tears the connection down ~1 s after END, well inside the receiver's 3 s grace.
        val s = Sim(rt, teardown = false)
        var endPhaseAt: Long? = null
        s.run(20_000, hook = { t ->
            if (endPhaseAt == null && s.senderPhase == Phase.ENDING) endPhaseAt = t
            if (endPhaseAt != null && t == endPhaseAt!! + 1000) s.linkB.onPeerDisconnected()
        })
        assertNotEquals(null, endPhaseAt)
        assertEquals("complete", s.receiver.status)
        assertEquals("NONE", s.verdictOf(s.sinkB))
        assertEquals(true, s.endRecord(s.sinkB)["peer_lost"])
        assertEquals(250L, s.receiver.ledger.counts().distinct)
        assertEquals(0L, s.endRecord(s.sinkB)["never_received_upper_bound"])
    }

    @Test fun lateFramesArrivingAfterEndAreStillCollectedDuringTheGracePeriod() {
        val f = object : Faults() { override fun deliverDelayMs(fromSender: Boolean, kind: Int, seq: Long) = if (kind == 1) 1000L else 30L }
        val s = Sim(raw, f); s.run(25_000)
        val endAt = s.receiver.endReceivedAtMs!!
        val after = s.receiver.ledger.all().count { it.rxMs > endAt }
        assertTrue("frames must still be arriving after END ($after)", after > 20)
        assertEquals(250L, s.receiver.ledger.counts().distinct)
        assertEquals("complete", s.receiver.status); assertEquals("NONE", s.verdictOf(s.sinkB))
    }

    @Test fun receiverHangingUpAfterEndBeforeDoneEndsTheSenderAsNormalCompletion() {
        val s = Sim(rt, teardown = false)
        var endPhaseAt: Long? = null
        s.run(20_000, hook = { t ->
            if (endPhaseAt == null && s.senderPhase == Phase.ENDING) endPhaseAt = t
            if (endPhaseAt != null && t == endPhaseAt!! + 500) s.linkA.onPeerDisconnected()
        })
        assertEquals("complete_peer_closed", s.sender.status)
        assertEquals("NONE", s.verdictOf(s.sinkA))
        assertEquals(false, s.endRecord(s.sinkA)["peer_done_ack"])
    }

    // ---- missing END -------------------------------------------------------------------------------------------
    @Test fun aSingleLostEndIsRecoveredByResendAndTheRunCompletesNormally() {
        var n = 0
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 2 && n++ == 0 }
        val s = Sim(rt, f); s.run(25_000)
        assertEquals("complete", s.receiver.status); assertEquals("complete", s.sender.status)
        assertEquals(250L, s.endRecord(s.sinkB)["expected_frames"]); assertEquals(0L, s.endRecord(s.sinkB)["never_received_upper_bound"])
        assertEquals("NONE", s.verdictOf(s.sinkB))
    }

    @Test fun everyEndLostAndConnectionStaysUp_receiverTimesOutSenderGivesUpWaiting() {
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 2 }
        val s = Sim(rt, f, teardown = false); s.run(30_000)
        assertEquals("unterminated_idle", s.receiver.status); assertEquals(true, s.endRecord(s.sinkB)["unterminated"])
        assertNull(s.endRecord(s.sinkB)["expected_frames"])
        assertEquals("complete_no_done", s.sender.status); assertEquals(false, s.endRecord(s.sinkA)["peer_done_ack"])
        assertEquals("NONE", s.verdictOf(s.sinkA))
    }

    @Test fun everyEndLostThenSenderHangsUp_receiverCannotTellFromAnEarlyDisconnectAndFlagsTheRun() {
        // Documented limitation: without END the receiver cannot distinguish "sender finished" from "sender died".
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 2 }
        val s = Sim(rt, f); s.run(30_000)
        assertEquals("aborted:peer_disconnected", s.receiver.status); assertEquals("DEVICE_DEPENDENT", s.verdictOf(s.sinkB))
        assertEquals("complete_no_done", s.sender.status); assertEquals("NONE", s.verdictOf(s.sinkA))
    }

    // ---- early disconnect / genuine failure --------------------------------------------------------------------
    @Test fun disconnectBeforeEndFailsBothSidesAsDeviceDependentWithConsistentLedgers() {
        val s = Sim(rt, teardown = false)
        s.run(20_000, hook = { t -> if (t == 6000L) { s.linkB.onPeerDisconnected(); s.linkA.onPeerDisconnected() } })
        assertEquals("aborted:peer_disconnected", s.sender.status); assertEquals("aborted:peer_disconnected", s.receiver.status)
        assertEquals("DEVICE_DEPENDENT", s.verdictOf(s.sinkA)); assertEquals("DEVICE_DEPENDENT", s.verdictOf(s.sinkB))
        assertEquals(emptyList<String>(), s.sender.ledger.violations(true)); assertEquals(emptyList<String>(), s.reconciliation().violations())
        assertTrue(s.receiver.ledger.counts().distinct in 100L..200L)
    }

    @Test fun peerLostCallbacksOnlyRecordStateAndFinalisationHappensOnTheNextTick() {
        val s = Sim(rt, teardown = false); s.run(4_000)
        s.linkB.onPeerDisconnected(); s.linkA.onPeerDisconnected()      // platform callback thread
        assertFalse("receiver must not finalise inside the callback", s.receiver.finished)
        assertNotEquals("sender must not finalise inside the callback", Phase.FINISHED, s.sender.phase)
        s.receiver.tick(s.clockB.nowMs()); s.sender.tick(s.clockA.nowMs())
        assertTrue(s.receiver.finished); assertEquals(Phase.FINISHED, s.sender.phase)
    }

    // ---- delayed callbacks / idempotent cleanup ----------------------------------------------------------------
    @Test fun transferCallbacksArrivingAfterFinalisationAreCountedAndNotApplied() {
        val f = object : Faults() { override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) 12_000L else 35L }
        val s = Sim(Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED).copy(durationS = 5), f); s.run(40_000)
        @Suppress("UNCHECKED_CAST") val counts = s.endRecord(s.sinkA)["counts"] as Map<String, Any?>
        assertTrue((counts["accepted_without_transfer_report"] as Long) > 0)
        assertTrue("late callbacks must be counted", s.sender.ledger.callbacksAfterFinalize > 0)
        assertEquals(emptyList<String>(), s.sender.ledger.violations(true))
        assertEquals("with window release=ACCEPTED, missing transfer results are informational", "NONE", s.verdictOf(s.sinkA))
    }

    @Test fun cleanupIsIdempotent() {
        val s = Sim(rt); s.run(20_000)
        repeat(3) { s.sender.abort("again"); s.receiver.stop("again"); s.linkA.onPeerDisconnected(); s.linkB.onPeerDisconnected() }
        assertEquals(1, s.runEndCount(s.sinkA)); assertEquals(1, s.runEndCount(s.sinkB))
        assertEquals("complete", s.sender.status); assertEquals("complete", s.receiver.status)
    }

    @Test fun abortingMidRunTwiceWritesOneRunEnd() {
        val s = Sim(rt); s.run(6_000, hook = { t -> if (t == 5000L) { s.sender.abort("operator_stop"); s.sender.abort("operator_stop") } })
        assertEquals(1, s.runEndCount(s.sinkA)); assertEquals("aborted:operator_stop", s.sender.status)
    }

    // ---- H1 / M2: startup ordering -------------------------------------------------------------------------------
    @Test fun receiverFirstStartup_allInitialProbesAreAnsweredBeforeTheSenderSessionExists() {
        var probesAnsweredBeforeSender = -1L; var senderExisted = true
        val s = Sim(rt)
        s.run(20_000, hook = { t ->
            if (t == 2999L) {
                probesAnsweredBeforeSender = s.linkB.estimator.acceptedProbes
                senderExisted = try { s.sender; true } catch (_: UninitializedPropertyAccessException) { false }
            }
        })
        assertFalse(senderExisted)
        assertEquals("the whole initial burst of 8 probes", 8L, probesAnsweredBeforeSender)
        val c = s.receiver.ledger.counts()
        assertEquals("no frame may be left UNCLASSIFIED by a late clock", 0L, c.byClass.getValue(RxClass.UNCLASSIFIED))
        assertEquals(250L, c.byClass.getValue(RxClass.ON_TIME))
    }

    @Test fun receiverArmedAfterTheSenderStartedIsAConfigurationError() {
        val s = Sim(rt, receiverArmMs = 4000); s.run(25_000)
        assertTrue("frames sent before arming: ${s.linkB.unhandledAudioFrames}", s.linkB.unhandledAudioFrames in 40L..50L)
        assertEquals("CONFIGURATION", s.verdictOf(s.sinkB))
        assertTrue(reasons(s, s.sinkB).getValue("CONFIGURATION").any { it.contains("BEFORE the sender") })
        assertEquals("NONE", s.verdictOf(s.sinkA))
    }

    @Test fun framesArrivingBeforeAnySessionExistsNeverThrowAndAreCounted() {
        val s = Sim(rt)                       // no sessions created yet: only the idle handler is attached
        val good = FrameCodec.encode(Wire.KIND_AUDIO, 0, 3, 0, 0, 0, Prbs.generate(0, 0, 60))
        val bad = good.copyOf().also { it[30] = (it[30].toInt() xor 0x55).toByte() }
        s.linkB.onBytes(good, 1); s.linkB.onBytes(bad, 2)
        s.linkB.onBytes(FrameCodec.encode(Wire.KIND_END, 1, 3, 0, 1, 0, ByteArray(4)), 3)
        s.linkB.onBytes(FrameCodec.encode(Wire.KIND_DONE, 1, 3, 15, 0, 0, ByteArray(0)), 4)
        s.linkB.onPeerDisconnected()
        assertEquals(2L, s.linkB.unhandledAudioFrames)
    }

    @Test fun aReceiverSessionThatIsAttachedButNotArmedCountsTheFramesItMustIgnore() {
        val s = Sim(rt, receiverArmMs = 1_000_000)               // never armed by the loop
        val r = com.rideaze.bench.core.run.ReceiverSession(rt, s.clockB, s.linkB, s.recB, 3, 0)   // attached, start() NOT called
        val good = FrameCodec.encode(Wire.KIND_AUDIO, 0, 3, 0, 0, 0, Prbs.generate(0, 0, 60))
        val bad = good.copyOf().also { it[30] = (it[30].toInt() xor 0x55).toByte() }
        s.linkB.onBytes(good, 1); s.linkB.onBytes(bad, 2)
        assertEquals(2L, s.linkB.unhandledAudioFrames)
        assertEquals(0L, r.ledger.counts().distinct)
    }

    @Test fun probesAreAnsweredByALinkThatHasNoSession() {
        val s = Sim(rt); s.run(2_000)           // sender session is created only at 3000
        assertEquals(8L, s.linkB.probeRepliesMatched)
    }

    // ---- M1: run epoch ----------------------------------------------------------------------------------------
    @Test fun differentRunIndexesAreAConfigurationErrorOnBothPhones() {
        val s = Sim(rt, senderRunIndex = 0, receiverRunIndex = 1, senderEpoch = 0, receiverEpoch = 1)
        s.run(25_000); s.receiver.stop()
        assertEquals("CONFIGURATION", s.verdictOf(s.sinkA)); assertEquals("CONFIGURATION", s.verdictOf(s.sinkB))
        assertTrue((s.endRecord(s.sinkB)["wrong_epoch_frames"] as Long) > 0)
        assertEquals(0L, s.receiver.ledger.counts().distinct)
    }

    // ---- wire: DONE kind ---------------------------------------------------------------------------------------
    @Test fun doneKindRoundTripsAndKindSixIsRejected() {
        val p = com.rideaze.bench.core.protocol.FrameParser(); val out = ArrayList<Int>()
        val f = FrameCodec.encode(Wire.KIND_DONE, 1, 2, 15, 0, 5, ByteArray(0))
        p.feed(f, 0, f.size, 0) { out.add(it.header.kind) }
        assertEquals(listOf(Wire.KIND_DONE), out); assertEquals(20, f.size)
        val bad = f.copyOf(); bad[3] = 6
        val c = com.rideaze.bench.core.protocol.Crc16.ccittFalse(bad, 0, 16); bad[16] = (c ushr 8).toByte(); bad[17] = c.toByte()
        val q = com.rideaze.bench.core.protocol.FrameParser(); q.feed(bad, 0, bad.size, 0) { out.add(99) }
        assertEquals(1L, q.counters.unsupportedHeader); assertEquals(listOf(Wire.KIND_DONE), out)
        try { FrameCodec.encode(6, 0, 0, 0, 0, 0, ByteArray(0)); throw AssertionError("encoded kind 6") } catch (_: IllegalArgumentException) {}
    }
}
