package com.rideaze.bench.core

import com.rideaze.bench.core.measure.DropCode
import com.rideaze.bench.core.measure.ReceiverLedger
import com.rideaze.bench.core.measure.Reconciler
import com.rideaze.bench.core.measure.RxClass
import com.rideaze.bench.core.measure.RxRecord
import com.rideaze.bench.core.measure.SenderLedger
import com.rideaze.bench.core.measure.SubmitState
import com.rideaze.bench.core.measure.TransferState
import com.rideaze.bench.core.queue.BoundedFrameQueue
import com.rideaze.bench.core.queue.OverflowPolicy
import com.rideaze.bench.core.queue.QueuedFrame
import com.rideaze.bench.core.run.ClassifierInput
import com.rideaze.bench.core.run.DeviceFlag
import com.rideaze.bench.core.run.FailureClass
import com.rideaze.bench.core.run.Mode
import com.rideaze.bench.core.run.RunClassifier
import com.rideaze.bench.core.run.Scenarios
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoundedFrameQueueTest {
    private fun f(seq: Long, gen: Long = 0) = QueuedFrame(seq, gen, ByteArray(1))

    @Test fun dropNewestKeepsOrderAndReturnsRejected() {
        val q = BoundedFrameQueue(2, OverflowPolicy.DROP_NEWEST, null)
        assertNull(q.offer(f(1))); assertNull(q.offer(f(2)))
        assertEquals(3L, q.offer(f(3))!!.seq)
        assertEquals(1L, q.pollLive(0) {}!!.seq); assertEquals(2L, q.pollLive(0) {}!!.seq)
    }
    @Test fun dropOldestKeepsFreshest() {
        val q = BoundedFrameQueue(3, OverflowPolicy.DROP_OLDEST, null)
        for (i in 1L..3) q.offer(f(i))
        assertEquals(1L, q.offer(f(4))!!.seq); assertEquals(3, q.size)
        assertEquals(listOf(2L, 3L, 4L), q.drainAll().map { it.seq })
    }
    @Test fun expiryAppliedAtDequeueNotBefore() {
        val q = BoundedFrameQueue(5, OverflowPolicy.DROP_OLDEST, 80)
        q.offer(f(1, 0)); q.offer(f(2, 10)); q.offer(f(3, 100))
        val expired = ArrayList<Long>()
        val live = q.pollLive(100) { expired.add(it.seq) }
        assertEquals("ages 100 and 90 exceed 80 ms", listOf(1L, 2L), expired)
        assertEquals(3L, live!!.seq)
    }
    @Test fun exactlyAtExpiryIsStillLive() {
        val q = BoundedFrameQueue(2, OverflowPolicy.DROP_OLDEST, 80); q.offer(f(1, 0))
        assertEquals(1L, q.pollLive(80) { throw AssertionError("not expired") }!!.seq)
    }
    @Test fun emptyPollReturnsNull() { assertNull(BoundedFrameQueue(1, OverflowPolicy.DROP_NEWEST, null).pollLive(0) {}) }
}

class LedgerTest {
    private fun assertClean(l: SenderLedger, final: Boolean = false) = assertEquals(emptyList<String>(), l.violations(final))

    @Test fun invariantHoldsAfterEveryOperationInAnyCallbackOrder() {
        val l = SenderLedger()
        for (i in 0L until 6) { l.generated(i, i * 20, 80); assertClean(l) }
        l.dropped(0, DropCode.SRC_EXPIRED); assertClean(l)
        l.submitStarted(1, 100); assertClean(l)
        l.submitStarted(2, 100); assertClean(l)
        l.submitStarted(3, 100); assertClean(l)
        l.transfer(1, true, 110); assertClean(l)       // transfer result BEFORE submission callback
        l.accepted(1, 111); assertClean(l)
        l.accepted(2, 112); assertClean(l)
        l.rejected(3, 8012, 113); assertClean(l)
        l.transfer(2, false, 120); assertClean(l)
        assertTrue(l.get(1)!!.transferBeforeAck)
        assertEquals(SubmitState.ACCEPTED, l.get(1)!!.submit); assertEquals(TransferState.SUCCESS, l.get(1)!!.transfer)
    }

    @Test fun successfulSubmissionIsNotDelivery() {
        val l = SenderLedger(); l.generated(0, 0, 80); l.submitStarted(0, 1); l.accepted(0, 2)
        l.finalizeRun()
        val c = l.counts()
        assertEquals(1L, c.accepted); assertEquals(0L, c.transferSuccess)
        assertEquals("accepted but no transfer report is UNRESOLVED, not delivered", 1L, c.unresolvedAtTermination)
        assertClean(l, true)
    }

    @Test fun finalReconciliationMovesQueuedAndPending() {
        val l = SenderLedger()
        for (i in 0L until 5) l.generated(i, 0, 10)
        l.submitStarted(0, 1); l.submitStarted(1, 1); l.accepted(0, 2); l.transfer(0, true, 3)
        l.finalizeRun()
        val c = l.counts()
        assertEquals(3L, c.droppedByCode.getValue(DropCode.END_OF_RUN)); assertEquals(1L, c.unresolvedSubmit)
        assertEquals(0L, c.queued); assertEquals(0L, c.pending)
        assertEquals(5L, c.generated)
        assertClean(l, true)
    }

    @Test fun lateCallbacksAfterFinalizeAreIgnoredAndCounted() {
        val l = SenderLedger(); l.generated(0, 0, 10); l.submitStarted(0, 1); l.finalizeRun()
        l.accepted(0, 5); l.transfer(0, true, 6)
        assertEquals(SubmitState.UNRESOLVED_SUBMIT, l.get(0)!!.submit); assertEquals(2L, l.callbacksAfterFinalize)
        assertClean(l, true)
    }

    @Test fun implausibleTransitionsAreFlaggedAsImplementationAnomalies() {
        val l = SenderLedger(); l.generated(0, 0, 10)
        l.transfer(0, true, 1) // transfer for a frame never submitted
        assertTrue(l.violations(false).any { it.startsWith("I4") })
        val m = SenderLedger(); m.generated(0, 0, 10); m.dropped(0, DropCode.SRC_FULL); m.dropped(0, DropCode.SRC_FULL)
        assertTrue(m.violations(false).any { it.startsWith("I4") })
        val n = SenderLedger(); n.generated(0, 0, 10); n.generated(0, 0, 10)
        assertTrue(n.violations(false).any { it.startsWith("I4") })
    }

    @Test fun finalViolationIfNotFinalized() {
        val l = SenderLedger(); l.generated(0, 0, 10)
        assertTrue(l.violations(true).any { it.startsWith("I3") })
    }

    @Test fun receiverLedgerCountsClassesAndDuplicates() {
        val r = ReceiverLedger()
        r.record(RxRecord(0, 0, 30, RxClass.ON_TIME, 30.0, 27.0, 80))
        r.record(RxRecord(1, 20, 300, RxClass.LATE, 260.0, 27.0, 80))
        r.record(RxRecord(2, 40, 70, RxClass.UNCERTAIN, 190.0, 27.0, 80))
        r.record(RxRecord(3, 60, 90, RxClass.CORRUPT_PAYLOAD, null, null, 60))
        assertFalse(r.record(RxRecord(0, 0, 31, RxClass.ON_TIME, 31.0, 27.0, 80)))
        val c = r.counts()
        assertEquals(4L, c.distinct); assertEquals(3L, c.intact); assertEquals(1L, c.afterDeadline); assertEquals(1L, c.duplicates)
        assertEquals(240L, c.intactBytes)
        assertEquals(emptyList<String>(), r.violations())
    }

    @Test fun reconciliationPutsEveryGeneratedFrameInExactlyOneBucket() {
        val tx = SenderLedger()
        for (i in 0L until 10) tx.generated(i, i * 20, 80)
        tx.dropped(0, DropCode.SRC_FULL)
        for (i in 1L..9) tx.submitStarted(i, 100)
        for (i in 1L..7) tx.accepted(i, 101)
        tx.rejected(8, 8012, 101)
        // 9 stays pending -> unresolved
        tx.finalizeRun()
        val rx = ReceiverLedger()
        rx.record(RxRecord(1, 0, 0, RxClass.ON_TIME, 1.0, 1.0, 80))
        rx.record(RxRecord(2, 0, 0, RxClass.CORRUPT_PAYLOAD, null, null, 80))
        rx.record(RxRecord(8, 0, 0, RxClass.VALID, 1.0, 1.0, 80)) // arrived although sender saw a rejection
        val x = Reconciler.reconcile(tx, rx)
        assertEquals(10L, x.generated); assertEquals(1L, x.droppedPre)
        assertEquals(2L, x.receivedIntact); assertEquals(1L, x.receivedCorrupt)
        assertEquals("accepted 1..7 minus received {1,2}", 5L, x.lostAccepted)
        assertEquals(0L, x.lostRejected); assertEquals(1L, x.receivedDespiteRejected)
        assertEquals(1L, x.lostUnresolvedSubmit)
        assertEquals(10L, x.terminalSum); assertEquals(emptyList<String>(), x.violations())
    }

    @Test fun reconciliationFlagsFramesTheSenderNeverSent() {
        val tx = SenderLedger(); tx.generated(0, 0, 80); tx.dropped(0, DropCode.SRC_FULL); tx.finalizeRun()
        val rx = ReceiverLedger()
        rx.record(RxRecord(0, 0, 0, RxClass.VALID, null, null, 80)); rx.record(RxRecord(99, 0, 0, RxClass.VALID, null, null, 80))
        val x = Reconciler.reconcile(tx, rx)
        assertEquals(1L, x.receivedFromDropped); assertEquals(1L, x.receivedUnknownSeq)
        assertTrue(x.violations().any { it.startsWith("X2") } && x.violations().any { it.startsWith("X3") })
    }
}

class ScenarioAndClassifierTest {
    @Test fun matrixHasTwentyEightValidScenariosWithUniqueIds() {
        val m = Scenarios.e1BytesMatrix
        assertEquals("7 bitrates x 2 modes x 2 window-release policies", 7 * 2 * 2, m.size); assertEquals(28, m.map { it.id }.toSet().size)
        for (s in m) assertEquals(s.id, emptyList<String>(), s.validate())
    }

    @Test fun payloadAndWireRatesMatchWorkshopTable() {
        val expect = mapOf(12 to (30 to 20.0), 16 to (40 to 24.0), 24 to (60 to 32.0), 30 to (75 to 38.0), 48 to (120 to 56.0), 64 to (160 to 72.0), 96 to (240 to 104.0))
        for ((k, v) in expect) {
            val s = Scenarios.e1Bytes(k, Mode.RAW)
            assertEquals(v.first, s.payloadBytes); assertEquals(v.first + 20, s.wireBytesPerFrame); assertEquals(v.second, s.wireKbps, 1e-9)
        }
    }

    @Test fun modesAreSeparated() {
        val raw = Scenarios.e1Bytes(24, Mode.RAW); val rt = Scenarios.e1Bytes(24, Mode.REALTIME)
        assertEquals(50, raw.queueCapacity); assertEquals(OverflowPolicy.DROP_NEWEST, raw.overflowPolicy)
        assertNull(raw.sendExpiryMs); assertNull(raw.playoutDeadlineMs)
        assertEquals(3, rt.queueCapacity); assertEquals(OverflowPolicy.DROP_OLDEST, rt.overflowPolicy)
        assertEquals(80L, rt.sendExpiryMs); assertEquals(200L, rt.playoutDeadlineMs); assertEquals(2, rt.maxInFlight)
        assertEquals(6000L, rt.totalFrames)
    }

    @Test fun configurationErrorsAreDetected() {
        val raw = Scenarios.e1Bytes(24, Mode.RAW); val rt = Scenarios.e1Bytes(24, Mode.REALTIME)
        assertTrue(raw.copy(sendExpiryMs = 80).validate().any { it.contains("RAW") })
        assertTrue(rt.copy(playoutDeadlineMs = null).validate().any { it.contains("playoutDeadlineMs") })
        assertTrue(rt.copy(overflowPolicy = OverflowPolicy.DROP_NEWEST).validate().any { it.contains("drop oldest") })
        assertTrue(raw.copy(encodedKbps = 13).validate().any { it.contains("integral") })
        assertTrue(raw.copy(encodedKbps = 1000).validate().any { it.contains("payloadBytes") })
        assertTrue(raw.copy(transport = "STREAM").validate().any { it.contains("BYTES only") })
        assertTrue(raw.copy(queueCapacity = 0).validate().isNotEmpty())
        assertTrue(raw.copy(probeIntervalMs = 10).validate().isNotEmpty())
    }

    @Test fun fingerprintDependsOnScenarioAndRunIndex() {
        val a = Scenarios.e1Bytes(24, Mode.RAW)
        assertNotEquals(a.fingerprint(0), a.fingerprint(1))
        assertNotEquals(a.fingerprint(0), Scenarios.e1Bytes(24, Mode.REALTIME).fingerprint(0))
        assertEquals(a.fingerprint(3), a.fingerprint(3))
    }

    @Test fun classifierPriorityAndInterpretation() {
        assertEquals(FailureClass.NONE, RunClassifier.classify(ClassifierInput()).primary)
        val tl = RunClassifier.classify(ClassifierInput(thresholdMisses = listOf("on_time_fraction 0.80 < 0.95")))
        assertEquals(FailureClass.TRANSPORT_LIMITATION, tl.primary); assertTrue(tl.interpretation.contains("tested conditions"))
        val dev = RunClassifier.classify(ClassifierInput(thresholdMisses = listOf("x"), deviceFlags = setOf(DeviceFlag.POWER_SAVE)))
        assertEquals("device condition outranks a threshold miss", FailureClass.DEVICE_DEPENDENT, dev.primary)
        assertTrue(dev.interpretation.contains("INVALID"))
        val api = RunClassifier.classify(ClassifierInput(apiFailures = listOf("rejected"), deviceFlags = setOf(DeviceFlag.SCREEN_OFF)))
        assertEquals(FailureClass.API, api.primary)
        val impl = RunClassifier.classify(ClassifierInput(invariantViolations = listOf("I1"), apiFailures = listOf("a")))
        assertEquals(FailureClass.IMPLEMENTATION, impl.primary)
        val cfg = RunClassifier.classify(ClassifierInput(isolationBreaches = listOf("second_peer"), invariantViolations = listOf("I1")))
        assertEquals(FailureClass.CONFIGURATION, cfg.primary)
        assertTrue(RunClassifier.classify(ClassifierInput(scenarioMismatch = true)).primary == FailureClass.CONFIGURATION)
        assertTrue(cfg.interpretation.contains("cannot support voice"))
        assertEquals(setOf(FailureClass.CONFIGURATION, FailureClass.IMPLEMENTATION), cfg.reasons.keys)
    }
}
