package com.rideaze.bench.core

import com.rideaze.bench.core.measure.DropCode
import com.rideaze.bench.core.measure.RxClass
import com.rideaze.bench.core.measure.SubmitState
import com.rideaze.bench.core.run.DeviceFlag
import com.rideaze.bench.core.run.Mode
import com.rideaze.bench.core.run.Phase
import com.rideaze.bench.core.run.RunContext
import com.rideaze.bench.core.run.Scenarios
import com.rideaze.bench.core.transport.TransferStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNotNull
import org.junit.Test

/** End-to-end behaviour over a deterministic fake link with independent device clocks. No physical devices. */
class LoopbackTest {
    private val rt = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5)
    private val raw = Scenarios.e1Bytes(24, Mode.RAW).copy(durationS = 5)

    private fun assertLedgersClean(s: Sim) {
        assertEquals(emptyList<String>(), s.sender.ledger.violations(true))
        assertEquals(emptyList<String>(), s.receiver.ledger.violations())
        assertEquals(emptyList<String>(), s.reconciliation().violations())
    }

    @Test fun cleanRealtimeLinkDeliversEverythingOnTimeWithCorrectLatency() {
        val s = Sim(rt); s.run(15_000)
        assertEquals(Phase.FINISHED, s.sender.phase); assertEquals("complete", s.sender.status)
        assertTrue(s.receiver.finished); assertEquals("complete", s.receiver.status)
        val c = s.sender.ledger.counts(); val r = s.receiver.ledger.counts()
        assertEquals(250L, c.generated); assertEquals(0L, c.droppedPre); assertEquals(250L, c.accepted); assertEquals(250L, c.transferSuccess)
        assertEquals(0L, c.unresolvedAtTermination)
        assertEquals(250L, r.byClass.getValue(RxClass.ON_TIME)); assertEquals(0L, r.afterDeadline)
        val lat = s.receiver.ledger.all().map { it.latencyMs!! }
        assertEquals("symmetric 30 ms path, B clock +250 ms", 30.0, lat.average(), 1.0)
        assertTrue(lat.all { Math.abs(it - 30.0) <= it.coerceAtLeast(0.0) + 35.0 })
        assertEquals(250L, s.reconciliation().receivedIntact)
        assertLedgersClean(s)
        assertEquals("NONE", s.verdictOf(s.sinkA)); assertEquals("NONE", s.verdictOf(s.sinkB))
        assertEquals(250L, (s.endRecord(s.sinkB)["expected_frames"] as Long))
        assertEquals(0L, s.endRecord(s.sinkB)["never_received_upper_bound"])
    }

    @Test fun clockOffsetsAreHandledInBothDirectionsAndAcrossWraparound() {
        for ((offA, offB) in listOf(0L to 250L, 250L to 0L, 0L to -400L, U32.MOD - 4000 to U32.MOD - 4000 + 250, 5_000_000L to 1_000L)) {
            val s = Sim(rt, offA = offA, offB = offB); s.run(15_000)
            assertEquals("offsets $offA/$offB", 250L, s.receiver.ledger.counts().byClass.getValue(RxClass.ON_TIME))
            assertEquals(30.0, s.receiver.ledger.all().map { it.latencyMs!! }.average(), 1.0)
        }
    }

    @Test fun slowLinkMakesFramesLateAndNeverUsefulAndNeverSubmitsStaleFrames() {
        val f = object : Faults() {
            override fun deliverDelayMs(fromSender: Boolean, kind: Int, seq: Long) = if (kind == 1) 250L else 30L
            override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) 255L else 35L
        }
        val s = Sim(rt, f); s.run(20_000)
        val c = s.sender.ledger.counts(); val r = s.receiver.ledger.counts()
        assertTrue("window must throttle: dropped=${c.droppedPre}", c.droppedPre > 100)
        assertTrue(c.droppedByCode.getValue(DropCode.WINDOW_FULL) > 0)
        assertEquals(0L, r.byClass.getValue(RxClass.ON_TIME)); assertEquals(0L, r.byClass.getValue(RxClass.UNCERTAIN))
        assertEquals(r.intact, r.afterDeadline); assertTrue(r.afterDeadline > 0)
        for (t in s.sender.ledger.all()) if (t.submit != SubmitState.DROPPED) assertTrue("stale frame submitted: age ${t.submitMs!! - t.genMs}", t.submitMs!! - t.genMs <= 80)
        assertLedgersClean(s)
    }

    @Test fun rawModeUnderTheSameSlowLinkRecordsLatencyWithoutDeadlineClasses() {
        val f = object : Faults() {
            override fun deliverDelayMs(fromSender: Boolean, kind: Int, seq: Long) = if (kind == 1) 250L else 30L
            override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) 255L else 35L
        }
        val s = Sim(raw, f); s.run(20_000)
        val r = s.receiver.ledger.counts()
        assertEquals(250L, r.byClass.getValue(RxClass.VALID)); assertEquals(0L, r.afterDeadline)
        assertEquals(250.0, s.receiver.ledger.all().map { it.latencyMs!! }.average(), 1.5)
        assertEquals(0L, s.sender.ledger.counts().droppedPre)
        assertLedgersClean(s)
    }

    @Test fun reportedTransferFailureIsNotDeliveryAndSilentLossIsStillFoundByReconciliation() {
        for (status in listOf(TransferStatus.FAILURE, TransferStatus.SUCCESS)) {
            val f = object : Faults() {
                override fun lose(kind: Int, seq: Long) = kind == 1 && seq % 10 == 3L
                override val statusOnLoss = status
            }
            val s = Sim(rt, f); s.run(15_000)
            val c = s.sender.ledger.counts(); val x = s.reconciliation()
            assertEquals(250L, c.accepted); assertEquals(25L, x.lostAccepted); assertEquals(225L, x.receivedIntact)
            if (status == TransferStatus.FAILURE) { assertEquals(25L, c.transferFailed); assertEquals(225L, c.transferSuccess) }
            else { assertEquals("sender believes all 250 transfers succeeded", 250L, c.transferSuccess); assertEquals(0L, c.transferFailed) }
            assertEquals(25L, s.endRecord(s.sinkB)["never_received_upper_bound"])
            assertLedgersClean(s)
        }
    }

    @Test fun rejectedSubmissionsAreCountedSeparatelyAndClassifiedAsApiFailure() {
        val f = object : Faults() { override fun rejectCode(kind: Int, seq: Long) = if (kind == 1 && seq % 7 == 0L) 8012 else null }
        val s = Sim(raw, f); s.run(15_000)
        val c = s.sender.ledger.counts()
        assertEquals(36L, c.rejected); assertEquals(214L, c.accepted); assertEquals(0L, s.reconciliation().receivedDespiteRejected)
        assertEquals(36L, s.reconciliation().lostRejected)
        assertEquals("API", s.verdictOf(s.sinkA))
        assertLedgersClean(s)
    }

    @Test fun unresolvedAtTerminationAreReportedNotAssumedDelivered() {
        val f = object : Faults() {
            override fun ackDelayMs(kind: Int, seq: Long) = if (kind == 1 && seq >= 245) null else 5L
            override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1 && seq >= 200) null else 35L
        }
        val s = Sim(raw, f); s.run(20_000)
        val c = s.sender.ledger.counts()
        assertEquals(5L, c.unresolvedSubmit); assertEquals(45L, c.acceptedWithoutTransferReport); assertEquals(50L, c.unresolvedAtTermination)
        assertEquals("frames unresolved at the sender may still have arrived", 250L, s.reconciliation().receivedIntact)
        assertLedgersClean(s)
    }

    @Test fun corruptPayloadsAreAttributedToTheirSequenceNumbers() {
        val f = object : Faults() { override fun corrupt(kind: Int, seq: Long) = kind == 1 && seq % 25 == 5L }
        val s = Sim(rt, f); s.run(15_000)
        val r = s.receiver.ledger.counts()
        assertEquals(10L, r.byClass.getValue(RxClass.CORRUPT_PAYLOAD)); assertEquals(240L, r.byClass.getValue(RxClass.ON_TIME))
        assertEquals(10L, s.reconciliation().receivedCorrupt)
        assertEquals(10L, s.linkB.parser.counters.payloadCrcFail)
        assertLedgersClean(s)
    }

    @Test fun lossBurstProducesOneStallOfTheRightSize() {
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 1 && seq in 100L..119L }
        val s = Sim(rt, f); s.run(15_000)
        @Suppress("UNCHECKED_CAST") val st = s.endRecord(s.sinkB)["stalls"] as Map<String, Any?>
        assertEquals(1L, st["count"]); assertTrue((st["max_ms"] as Long) in 400L..440L)
    }

    @Test fun peerLossMidRunAbortsSenderCleanlyAndIsDeviceDependent() {
        val s = Sim(rt, teardown = false) // receiver is NOT told about the disconnect: it can only time out
        s.run(20_000, hook = { t -> if (t == 6000L) s.linkA.onPeerDisconnected() })
        assertEquals(Phase.FINISHED, s.sender.phase); assertEquals("aborted:peer_disconnected", s.sender.status)
        assertEquals("DEVICE_DEPENDENT", s.verdictOf(s.sinkA))
        assertEquals(0L, s.sender.ledger.counts().queued)
        assertEquals(emptyList<String>(), s.sender.ledger.violations(true))
        assertEquals("unterminated_idle", s.receiver.status)
        assertEquals(true, s.endRecord(s.sinkB)["unterminated"]); assertNull(s.endRecord(s.sinkB)["never_received_upper_bound"])
    }

    @Test fun lostEndFrameLeavesReceiverUnterminatedAndHonest() {
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 2 }
        val s = Sim(rt, f, teardown = false); s.run(25_000)
        assertEquals("unterminated_idle", s.receiver.status)
        assertNull(s.endRecord(s.sinkB)["expected_frames"]); assertEquals(250L, s.receiver.ledger.counts().distinct)
    }

    @Test fun mismatchedScenarioSelectionIsAConfigurationFailureOnBothPhones() {
        val s = Sim(rt, senderRunIndex = 0, receiverRunIndex = 1); s.run(15_000)
        assertEquals("CONFIGURATION", s.verdictOf(s.sinkA)); assertEquals("CONFIGURATION", s.verdictOf(s.sinkB))
    }

    @Test fun framesFromAnotherRunEpochAreIgnoredAndCounted() {
        val s = Sim(rt, receiverEpoch = 4); s.run(8_000); s.receiver.stop()
        assertEquals(0L, s.receiver.ledger.counts().distinct)
        assertTrue(s.linkB.wrongEpochFrames > 0)
        assertEquals(250L, s.reconciliation().lostAccepted + s.reconciliation().lostUnresolvedSubmit + s.reconciliation().receivedIntact)
    }

    @Test fun isolationBreachFromPairingMakesRunInvalidNotATransportResult() {
        val ctx = object : RunContext {
            override fun isolationBreaches() = listOf("second_peer@ab12cd34")
            override fun deviceFlags() = emptySet<DeviceFlag>()
            override fun deviceInfo(): Map<String, Any?> = mapOf("model" to "m", "sdk" to 1)
        }
        val s = Sim(rt, ctxA = ctx); s.run(15_000)
        assertEquals("CONFIGURATION", s.verdictOf(s.sinkA))
    }

    @Test fun invalidScenarioDoesNotStartAndIsRecordedAsConfigurationFailure() {
        val s = Sim(rt.copy(sendExpiryMs = null)); s.run(5_000)
        assertEquals("config_error", s.sender.status); assertEquals("CONFIGURATION", s.verdictOf(s.sinkA)); assertEquals(0L, s.sender.ledger.counts().generated)
    }

    @Test fun abortWhileRunningMovesQueuedFramesToEndOfRun() {
        val s = Sim(rt); s.run(6_000, hook = { t -> if (t == 5000L) s.sender.abort("operator_stop") })
        assertEquals("aborted:operator_stop", s.sender.status)
        assertEquals(emptyList<String>(), s.sender.ledger.violations(true))
        assertNotNull(s.sender.ledger.counts().droppedByCode[DropCode.END_OF_RUN])
    }

    @Test fun probesSurviveAsymmetricPathAndReportBoundedError() {
        val f = object : Faults() {
            override fun deliverDelayMs(fromSender: Boolean, kind: Int, seq: Long) = if (fromSender) 40L else 20L
        }
        val s = Sim(rt, f); s.run(15_000)
        val lat = s.receiver.ledger.all().map { it.latencyMs!! }.average()
        // true A->B latency 40; probes initiated by B: theta error = (fwd-ret)/2 where fwd = B->A 20, ret = A->B 40 -> estimate biased by 10
        assertTrue("estimate $lat must be within the stated uncertainty of the truth 40", Math.abs(lat - 40.0) <= s.receiver.ledger.all().first().uncertaintyMs!!)
        assertEquals(250L, s.receiver.ledger.counts().byClass.getValue(RxClass.ON_TIME))
    }

    @Test fun latencyInsideTheUncertaintyBandOfTheDeadlineIsUncertainNotOnTime() {
        val f = object : Faults() {
            override fun deliverDelayMs(fromSender: Boolean, kind: Int, seq: Long) = if (kind == 1) 190L else 30L
            override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) 30L else 35L
        }
        val s = Sim(rt, f); s.run(20_000)
        val r = s.receiver.ledger.counts()
        // L ~ 190 ms, uncertainty ~ 32 ms, deadline 200 ms: neither provably on time nor provably late
        assertEquals(250L, r.byClass.getValue(RxClass.UNCERTAIN))
        assertEquals(0L, r.byClass.getValue(RxClass.ON_TIME)); assertEquals(0L, r.afterDeadline)
    }

    @Test fun generatorStallExpiresStaleFramesAtDequeueInsteadOfSubmittingThem() {
        val s = Sim(rt); s.run(15_000, skipSenderTick = { t -> t in 4000L..4400L })
        val c = s.sender.ledger.counts()
        assertTrue("stalled generator must expire frames: $c", c.droppedByCode.getValue(DropCode.SRC_EXPIRED) > 0)
        for (t in s.sender.ledger.all()) if (t.submit != SubmitState.DROPPED) assertTrue("stale frame submitted, age ${t.submitMs!! - t.genMs}", t.submitMs!! - t.genMs <= 80)
        assertLedgersClean(s)
    }

    @Test fun noClockEstimateMeansUnclassifiedNotOnTime() {
        // receiver never gets probe replies: drop every probe reply (kind 4)
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 4 }
        val s = Sim(rt, f); s.run(15_000)
        val r = s.receiver.ledger.counts()
        assertEquals(250L, r.byClass.getValue(RxClass.UNCLASSIFIED)); assertEquals(0L, r.byClass.getValue(RxClass.ON_TIME))
    }
}

class SessionFaultAndDeviceTest {
    private val rt = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5)

    private fun sample(screen: Boolean? = true, save: Boolean? = false, thermal: Int? = 0, pct: Int? = 80, wifi: Boolean? = true, bt: Boolean? = true) =
        com.rideaze.bench.core.measure.ResourceSample(null, null, null, null, pct, null, null, null, thermal, save, screen, wifi, bt)

    @Test fun hostReportedFaultsAndApiFailuresClassifyTheRun() {
        val a = Sim(rt); a.run(3_500); a.sender.recordFault("driver exception: NPE"); a.sender.abort("driver_exception")
        assertEquals("IMPLEMENTATION", a.verdictOf(a.sinkA))
        val b = Sim(rt); b.run(3_500); b.sender.recordApiFailure("startDiscovery failed 8002"); b.sender.abort("api")
        assertEquals("API", b.verdictOf(b.sinkA))
        val c = Sim(rt); c.run(3_500); c.receiver.recordApiFailure("acceptConnection failed"); c.receiver.stop()
        assertEquals("API", c.verdictOf(c.sinkB))
        val d = Sim(rt); d.run(3_500); d.receiver.recordFault("x"); d.receiver.stop()
        assertEquals("IMPLEMENTATION", d.verdictOf(d.sinkB))
    }

    @Test fun deviceFlagTracker() {
        val t = com.rideaze.bench.core.run.DeviceFlagTracker()
        t.observe(sample()); assertTrue(t.flags().isEmpty())
        t.observe(sample(screen = null, save = null, thermal = null, pct = null, wifi = null, bt = null)); assertTrue("unknown (null) is not a flag", t.flags().isEmpty())
        t.observe(sample(screen = false)); t.observe(sample(save = true)); t.observe(sample(thermal = 3)); t.observe(sample(pct = 14)); t.observe(sample(bt = false))
        assertEquals(setOf(DeviceFlag.SCREEN_OFF, DeviceFlag.POWER_SAVE, DeviceFlag.THERMAL_SEVERE, DeviceFlag.BATTERY_LOW, DeviceFlag.RADIO_DISABLED), t.flags())
        val u = com.rideaze.bench.core.run.DeviceFlagTracker()
        u.compareServiceVersion("1.0", "1.0"); u.compareServiceVersion(null, "1.0"); assertTrue(u.flags().isEmpty())
        u.compareServiceVersion("1.0", "1.1"); assertEquals(setOf(DeviceFlag.SERVICE_VERSION_CHANGED), u.flags())
        val ok = com.rideaze.bench.core.run.DeviceFlagTracker(); ok.observe(sample(pct = 15, thermal = 2)); assertTrue(ok.flags().isEmpty())
    }

    @Test fun deviceFlagsFromContextMakeRunDeviceDependentNotATransportResult() {
        val tracker = com.rideaze.bench.core.run.DeviceFlagTracker(); tracker.observe(sample(save = true))
        val ctx = object : RunContext {
            override fun isolationBreaches() = emptyList<String>()
            override fun deviceFlags() = tracker.flags()
            override fun deviceInfo(): Map<String, Any?> = mapOf("model" to "m", "sdk" to 1)
        }
        val s = Sim(rt, ctxB = ctx); s.run(15_000)
        assertEquals("DEVICE_DEPENDENT", s.verdictOf(s.sinkB)); assertEquals("NONE", s.verdictOf(s.sinkA))
    }
}
