package com.rideaze.bench.core

import com.rideaze.bench.core.clock.ClockEstimator
import com.rideaze.bench.core.clock.ProbeSample
import com.rideaze.bench.core.measure.DropCode
import com.rideaze.bench.core.measure.FileSink
import com.rideaze.bench.core.measure.RxClass
import com.rideaze.bench.core.measure.SenderLedger
import com.rideaze.bench.core.measure.Stats
import com.rideaze.bench.core.measure.SubmitState
import com.rideaze.bench.core.measure.TransferState
import com.rideaze.bench.core.run.AcceptanceProposal
import com.rideaze.bench.core.run.DeviceFlag
import com.rideaze.bench.core.run.Mode
import com.rideaze.bench.core.run.RunContext
import com.rideaze.bench.core.run.Scenarios
import com.rideaze.bench.core.run.WindowRelease
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.Random

/** H3: platform callback semantics are unverified, so every ordering/duplication/absence case must be survivable and correctly classified. */
class CallbackSemanticsTest {
    private val rt = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5)

    @Suppress("UNCHECKED_CAST")
    private fun reasons(s: Sim) = ((s.endRecord(s.sinkA)["verdict"] as Map<String, Any?>)["reasons"] as Map<String, List<String>>)
    @Suppress("UNCHECKED_CAST")
    private fun callbacks(s: Sim) = s.endRecord(s.sinkA)["callbacks"] as Map<String, Any?>

    @Test fun completionBeforeAckIsLegalAndCounted() {
        val f = object : Faults() { override fun ackDelayMs(kind: Int, seq: Long) = if (kind == 1) 20L else 5L; override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) 10L else 35L }
        val s = Sim(rt, f); s.run(20_000)
        assertEquals(250L, (callbacks(s)["transfer_before_ack"] as Long))
        assertEquals("NONE", s.verdictOf(s.sinkA)); assertEquals(emptyList<String>(), s.sender.ledger.violations(true))
        assertEquals(250L, s.sender.ledger.counts().accepted)
    }

    @Test fun veryLateAckAfterCompletionIsLegal() {
        val f = object : Faults() { override fun ackDelayMs(kind: Int, seq: Long) = if (kind == 1) 500L else 5L }
        val s = Sim(rt, f); s.run(20_000)
        assertEquals(250L, s.sender.ledger.counts().accepted); assertEquals("NONE", s.verdictOf(s.sinkA))
    }

    @Test fun duplicatedCallbacksAreNotDoubleCountedAndAreClassifiedApiNotImplementation() {
        val f = object : Faults() { override fun duplicateCallbacks(kind: Int, seq: Long) = kind == 1 }
        val s = Sim(rt, f); s.run(20_000)
        val c = s.sender.ledger.counts()
        assertEquals(250L, c.accepted); assertEquals(250L, c.transferSuccess); assertEquals(0L, c.transferFailed)   // never 500
        assertEquals(500L, s.sender.ledger.duplicateCallbacks)                                                          // 250 acks + 250 completions
        assertEquals("API", s.verdictOf(s.sinkA)); assertTrue(reasons(s).getValue("API").any { it.contains("reported twice") })
        assertEquals("duplicates are platform behaviour, not a ledger defect", emptyList<String>(), s.sender.ledger.violations(true))
    }

    @Test fun conflictingCompletionKeepsTheFirstOutcomeAndIsClassifiedApi() {
        val f = object : Faults() { override fun conflictingCompletion(kind: Int, seq: Long) = kind == 1 }
        val s = Sim(rt, f); s.run(20_000)
        val c = s.sender.ledger.counts()
        assertEquals(250L, c.transferSuccess); assertEquals(0L, c.transferFailed); assertEquals(250L, s.sender.ledger.conflictingCallbacks)
        assertEquals("API", s.verdictOf(s.sinkA))
    }

    @Test fun missingCompletionCallbacksNeverBecomeATransportLimitation() {
        val f = object : Faults() { override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) null else 35L }
        val s = Sim(rt, f); s.run(40_000)
        assertTrue("window slots must time out", (s.endRecord(s.sinkA)["inflight_timeouts"] as Long) > 0)
        assertEquals("API", s.verdictOf(s.sinkA))
        assertTrue(reasons(s).getValue("API").any { it.contains("timed out") && it.contains("not interpretable") })
        assertFalse("TRANSPORT_LIMITATION" in reasons(s).keys)
    }

    @Test fun missingCompletionCallbacksWithAcceptedReleaseKeepTheStreamFlowing() {
        val f = object : Faults() { override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1) null else 35L }
        val s = Sim(Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED).copy(durationS = 5), f); s.run(40_000)
        assertEquals(250L, s.receiver.ledger.counts().byClass.getValue(RxClass.ON_TIME))
        assertEquals(250L, (callbacks(s)["accepted_without_transfer_report"] as Long))
        assertEquals(0L, (s.endRecord(s.sinkA)["inflight_timeouts"] as Long))
        assertEquals("NONE", s.verdictOf(s.sinkA))
    }

    @Test fun acceptedSubmissionsThatNeverGetATransferResultAreApiEvenWithoutAnyWindowTimeout() {
        // Isolates the "never received a transfer result" rule: the timeout is set far beyond the run so it cannot fire.
        val raw = Scenarios.e1Bytes(24, Mode.RAW).copy(durationS = 5, inFlightTimeoutMs = 600_000)
        val f = object : Faults() { override fun completionDelayMs(kind: Int, seq: Long) = if (kind == 1 && seq >= 245) null else 35L }
        val s = Sim(raw, f); s.run(40_000)
        assertEquals(0L, (s.endRecord(s.sinkA)["inflight_timeouts"] as Long))
        assertEquals(5L, (callbacks(s)["accepted_without_transfer_report"] as Long))
        assertEquals("API", s.verdictOf(s.sinkA))
        assertTrue(reasons(s).getValue("API").any { it.startsWith("5 accepted submissions never received a transfer result") })
    }

    @Test fun callbackLatencyDiagnosticsAreRecordedWithExactValues() {
        val s = Sim(rt); s.run(20_000)
        @Suppress("UNCHECKED_CAST") val l = s.endRecord(s.sinkA)["callback_latency_ms"] as Map<String, Any?>
        assertEquals(250L, l["ack_n"]); assertEquals(5L, l["ack_p50"]); assertEquals(5L, l["ack_max"])
        assertEquals(250L, l["transfer_n"]); assertEquals(35L, l["transfer_p50"]); assertEquals(35L, l["transfer_p95"])
    }

    @Test fun ledgerCallbackAnomaliesAreApiNotesAndNeverChangeCounts() {
        val l = SenderLedger()
        for (i in 0L until 4) { l.generated(i, 0, 10); l.submitStarted(i, 1) }
        l.accepted(0, 2); l.accepted(0, 3)                       // duplicate
        l.accepted(1, 2); l.rejected(1, 7, 3)                    // reject after accept
        l.rejected(2, 7, 2); l.accepted(2, 3)                    // accept after reject
        l.transfer(3, true, 2); l.transfer(3, false, 3)          // conflicting
        val c = l.counts()
        assertEquals(2L, c.accepted); assertEquals(1L, c.rejected); assertEquals(1L, c.pending)
        assertEquals(TransferState.SUCCESS, l.get(3)!!.transfer)
        assertEquals(1L, l.duplicateCallbacks); assertEquals(3L, l.conflictingCallbacks)
        assertEquals(4, l.apiAnomalyNotes().size)
        assertEquals("api anomalies are not ledger-invariant violations", emptyList<String>(), l.violations(false))
        assertEquals(SubmitState.ACCEPTED, l.get(1)!!.submit)
    }

    @Test fun callbackForAFrameWeNeverSubmittedIsStillAnImplementationDefect() {
        val l = SenderLedger(); l.generated(0, 0, 10)
        l.accepted(0, 1)                                         // still QUEUED: our id mapping would be wrong
        l.accepted(99, 1)                                        // unknown seq
        assertTrue(l.violations(false).any { it.startsWith("I4") }); assertEquals(0, l.apiAnomalyNotes().size)
    }
}

/** H2: probe freshness. Expected values are computed by an independent reference in the test. */
class ProbeFreshnessTest {
    private fun probe(trueSend: Long, delay: Long, offset: Long = 250): ProbeSample {
        val f = delay / 2; val r = delay - f
        val t1 = trueSend + f + offset
        return ProbeSample(trueSend, t1, t1, trueSend + f + r, trueSend + f + r)
    }

    @Test fun anOldLowDelayProbeDoesNotShadowFreshOnesNorMakeTheEstimateStale() {
        val est = ClockEstimator()
        est.add(probe(1_000, 10)); est.add(probe(34_000, 40))
        val r = est.estimate(34_100) // old probe is 33 s old, new one 0.1 s
        assertTrue("must not be STALE while a fresh probe exists", r is ClockEstimator.Result.Ok)
        assertEquals(40L, (r as ClockEstimator.Result.Ok).estimate.bestDelayMs)
    }

    @Test fun whenEveryProbeIsOldTheEstimateIsStale() {
        val est = ClockEstimator(); est.add(probe(1_000, 10)); est.add(probe(5_000, 12))
        assertEquals(ClockEstimator.Unavailable.STALE, (est.estimate(40_000) as ClockEstimator.Result.Unavailable).reason)
    }

    @Test fun jitteredProbeStream_chosenProbeMatchesAnIndependentReference() {
        val rnd = Random(99); val all = ArrayList<ProbeSample>(); val est = ClockEstimator()
        for (i in 0 until 14) { val p = probe(i * 5_000L, 5L + rnd.nextInt(200)); all.add(p); est.add(p) }
        val retained = all.takeLast(8)
        repeat(300) {
            val now = retained.last().atMs + rnd.nextInt(45_000)
            val fresh = retained.filter { now - it.atMs <= 30_000 }
            val r = est.estimate(now)
            if (fresh.isEmpty()) assertTrue(r is ClockEstimator.Result.Unavailable)
            else {
                val minDelay = fresh.minOf { it.delayMs }
                assertEquals("now=$now", minDelay, (r as ClockEstimator.Result.Ok).estimate.bestDelayMs)
            }
        }
    }

    @Test fun freshnessBoundaryIsInclusiveAtThirtySeconds() {
        val est = ClockEstimator(); val p = probe(0, 20); est.add(p)
        assertTrue(est.estimate(p.atMs + 30_000) is ClockEstimator.Result.Ok)
        assertTrue(est.estimate(p.atMs + 30_001) is ClockEstimator.Result.Unavailable)
    }
}

class ContextAndSinkTest {
    private val rt = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5)

    @Test fun deviceFlagsAndApiFailuresAreEvaluatedWhenTheSessionFinalises() {
        val state = object { @Volatile var flag = false; @Volatile var api: List<String> = emptyList() }
        val ctx = object : RunContext {
            override fun isolationBreaches() = emptyList<String>()
            override fun deviceFlags() = if (state.flag) setOf(DeviceFlag.SERVICE_VERSION_CHANGED) else emptySet()
            override fun apiFailures() = state.api
            override fun deviceInfo(): Map<String, Any?> = mapOf("model" to "m", "sdk" to 1, "simulated" to false)
        }
        val s = Sim(rt, ctxA = ctx)
        s.run(20_000, hook = { t -> if (t == 7000L) { state.flag = true; state.api = listOf("acceptConnection failed code=8007") } })
        assertEquals("a condition that appears mid-run must still reach run_end", "API", s.verdictOf(s.sinkA))
        @Suppress("UNCHECKED_CAST") val reasons = ((s.endRecord(s.sinkA)["verdict"] as Map<String, Any?>)["reasons"] as Map<String, List<String>>)
        assertEquals(listOf("SERVICE_VERSION_CHANGED"), reasons["DEVICE_DEPENDENT"]); assertTrue(reasons.getValue("API").single().contains("8007"))
    }

    @Test fun runStartMarksSimulatedRunsSoTheyCanNeverPassForPhysicalOnes() {
        val s = Sim(rt); s.run(3_100)
        @Suppress("UNCHECKED_CAST") val start = s.sinkA.lines.map { MiniJson.parse(it) as Map<String, Any?> }.first { it["type"] == "run_start" }
        @Suppress("UNCHECKED_CAST") val dev = start["device"] as Map<String, Any?>
        assertEquals(true, dev["simulated"]); assertEquals("jvm-test", dev["model"])
    }

    @Test fun fileSinkIsLazyNeverOverwritesAndClosesIdempotently() {
        val dir = java.nio.file.Files.createTempDirectory("sinktest").toFile()
        try {
            val f = File(dir, "r.jsonl"); val sink = FileSink(f)
            assertFalse("no file until the first write", f.exists())
            sink.write("{\"a\":1}"); sink.write("{\"a\":2}"); sink.flush()
            assertEquals(listOf("{\"a\":1}", "{\"a\":2}"), f.readLines())
            sink.close(); sink.close(); sink.write("{\"late\":1}")
            assertEquals(2, f.readLines().size)
            val again = FileSink(f)                                 // same name: must refuse, not truncate
            try { again.write("{\"x\":1}"); fail("overwrote an existing result file") } catch (_: IOException) {}
            assertEquals(listOf("{\"a\":1}", "{\"a\":2}"), f.readLines())
            val untouched = FileSink(File(dir, "never.jsonl")); untouched.close()
            assertFalse(File(dir, "never.jsonl").exists())
        } finally { dir.deleteRecursively() }
    }

    @Test fun percentileIsNearestRank() {
        assertEquals(10L, Stats.percentile((1L..10L).toList(), 95)); assertEquals(5L, Stats.percentile((1L..10L).toList(), 50))
        assertEquals(6L, Stats.percentile((1L..10L).toList(), 51)); assertNull(Stats.percentile(emptyList(), 50))
        assertEquals(7L, Stats.percentile(listOf(7L), 99)); assertEquals(5L, Stats.percentile(listOf(5L, 3L, 9L), 34)) // rank ceil(0.34*3)=2 of [3,5,9]
    }

    @Test fun proposalNamesItsDenominatorsAndSpecRejectsAnImpossibleHandshakeWait() {
        val m = AcceptanceProposal.toMap()
        for (k in listOf("on_time_of_generated_min", "intact_of_generated_min", "accepted_of_generated_min", "transfer_failure_of_accepted_max", "corrupt_of_received_max"))
            assertTrue(k, m.containsKey(k))
        assertFalse("ambiguous legacy key must be gone", m.containsKey("on_time_fraction_min"))
        assertTrue(rt.copy(senderEndWaitMs = 3_500).validate().any { it.contains("senderEndWaitMs") })
        assertTrue(rt.copy(endResendIntervalMs = 100).validate().isNotEmpty())
        assertEquals(emptyList<String>(), rt.validate())
        assertEquals(DropCode.values().toList(), DropCode.values().toList())
    }
}
