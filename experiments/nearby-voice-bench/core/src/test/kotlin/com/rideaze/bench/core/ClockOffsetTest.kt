package com.rideaze.bench.core

import com.rideaze.bench.core.clock.ClockEstimator
import com.rideaze.bench.core.clock.Latency
import com.rideaze.bench.core.clock.LatencyStatus
import com.rideaze.bench.core.clock.ProbeSample
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Random

/**
 * Convention: theta = clock(receiver) - clock(sender).
 * A probe measures clock(responder) - clock(initiator); latency L = rx - tx - theta.
 */
class ClockOffsetTest {
    /** Builds a probe. Initiator clock = true time; responder clock = true time + offset. */
    private fun probe(trueSend: Long, offset: Long, fwd: Long, ret: Long, residence: Long = 10): ProbeSample {
        val t0 = trueSend
        val t1 = trueSend + fwd + offset
        val t2 = t1 + residence
        val t3 = trueSend + fwd + residence + ret
        return ProbeSample(U32.wrap(t0), U32.wrap(t1), U32.wrap(t2), U32.wrap(t3), t3)
    }

    @Test fun t1_symmetricPositiveOffset_exact() {
        val s = probe(1000, 250, 25, 25)
        assertEquals(250.0, s.offsetMs, 0.0); assertEquals(50, s.delayMs)
    }

    @Test fun t2_symmetricNegativeOffset_exact() {
        val s = ProbeSample(1000, 625, 630, 1055, 1055) // worked example 2
        assertEquals(-400.0, s.offsetMs, 0.0); assertEquals(50, s.delayMs)
    }

    @Test fun t3_asymmetryErrorEqualsHalfDifference() {
        val s = ProbeSample(1000, 1280, 1290, 1060, 1060) // worked example 1: B=A+250, fwd 30, ret 20
        assertEquals(255.0, s.offsetMs, 0.0)
        assertEquals("error = (fwd-ret)/2", (30 - 20) / 2.0, s.offsetMs - 250.0, 0.0)
    }

    @Test fun t4_roundTripDelayIsFwdPlusRet() { assertEquals(50, ProbeSample(1000, 1280, 1290, 1060, 1060).delayMs) }

    @Test fun t5_latencyPositiveOffsetExample() {
        // frame sent by A at 5000 (A clock); B clock = A + 250; true latency 30 -> B reads 5280; theta_hat = 255
        assertEquals(25.0, Latency.oneWay(5000, 5280, 255.0), 0.0)
    }

    @Test fun t6_latencyNegativeOffsetExample() {
        assertEquals(25.0, Latency.oneWay(2000, 1625, -400.0), 0.0)
    }

    @Test fun t7_wrongSignWouldBeDetected() {
        val good = Latency.oneWay(2000, 1625, -400.0)
        val buggyPreviousSpec = U32.signedDiff(1625, 2000) + (-400.0) // rx - tx + theta
        assertEquals(25.0, good, 0.0)
        assertEquals(-775.0, buggyPreviousSpec, 0.0)
        assertTrue("sign error changes the answer by 2*theta", Math.abs(good - buggyPreviousSpec) == 800.0)
    }

    @Test fun t8_modularWrapAcrossSenderAndReceiver() {
        // receiver ahead by 250 ms; sender stamps 10 ms before wrap; true latency 30 -> receiver stamp wraps to 270
        val tx = U32.MOD - 10
        val rx = U32.wrap(tx + 250 + 30)
        assertEquals(270L, rx)
        assertEquals(30.0, Latency.oneWay(tx, rx, 250.0), 0.0)
        // probe straddling the wrap
        val s = ProbeSample(U32.MOD - 5, U32.wrap(U32.MOD - 5 + 25 + 250), U32.wrap(U32.MOD - 5 + 25 + 250 + 10), U32.wrap(U32.MOD - 5 + 25 + 10 + 25), 0)
        assertEquals(250.0, s.offsetMs, 0.0); assertEquals(50, s.delayMs); assertTrue(s.isValid())
    }

    @Test fun t9_negativeDelayProbeRejectedAndCounted() {
        val bad = ProbeSample(1000, 1000, 1500, 1010, 1010) // responder residence 500 ms > total 10 ms
        assertFalse(bad.isValid())
        val est = ClockEstimator()
        assertFalse(est.add(bad)); assertEquals(1L, est.rejectedProbes); assertEquals(0L, est.acceptedProbes)
        assertTrue(est.estimate(1010) is ClockEstimator.Result.Unavailable)
    }

    @Test fun t10_implausibleLatencyRejected() {
        val est = ClockEstimator(); est.add(probe(1000, 0, 25, 25))
        val ok = Latency.forReceivedFrame(est, 2000, 2030, 2040)
        assertEquals(LatencyStatus.OK, ok.status)
        assertEquals(LatencyStatus.IMPLAUSIBLE, Latency.forReceivedFrame(est, 2000, 14_000, 14_001).status)
        assertEquals(LatencyStatus.IMPLAUSIBLE, Latency.forReceivedFrame(est, 2000, 1900, 2040).status) // < -uncertainty
    }

    @Test fun t10b_smallNegativeLatencyWithinUncertaintyIsKeptAndReported() {
        val est = ClockEstimator(); est.add(probe(1000, 0, 30, 20)) // theta_hat has +5 error
        val l = Latency.forReceivedFrame(est, 5000, 5004, 5010)
        assertEquals(LatencyStatus.OK, l.status)
        assertTrue("latency may legitimately read below zero inside the bound", l.latencyMs!! < 10)
        assertTrue(l.uncertaintyMs!! >= 25.0)
    }

    @Test fun t11_minDelayProbeSelected() {
        val est = ClockEstimator()
        val delays = listOf(80L, 120L, 40L, 90L, 200L, 60L, 150L, 70L)
        delays.forEachIndexed { i, d -> est.add(probe(1000L + i * 1000, 250, d / 2, d - d / 2)) }
        val r = est.estimate(9000) as ClockEstimator.Result.Ok
        assertEquals(40L, r.estimate.bestDelayMs)
    }

    @Test fun t12_boundPropertyOver1000RandomAsymmetricPairs() {
        val rnd = Random(2024)
        repeat(1000) {
            val fwd = rnd.nextInt(300).toLong(); val ret = rnd.nextInt(300).toLong(); val off = rnd.nextInt(2_000_000) - 1_000_000L
            val s = probe(10_000, off, fwd, ret, rnd.nextInt(50).toLong())
            assertTrue(s.isValid())
            assertTrue("fwd=$fwd ret=$ret", Math.abs(s.offsetMs - off) <= s.delayMs / 2.0 + 1.0)
            assertEquals((fwd - ret) / 2.0, s.offsetMs - off, 1e-9)
        }
    }

    @Test fun t13_zeroDelayProbeIsExact() {
        val s = probe(1000, 777, 0, 0, 0)
        assertEquals(777.0, s.offsetMs, 0.0); assertEquals(0, s.delayMs)
    }

    @Test fun t14_driftExtrapolation() {
        // responder runs 50 ppm fast: offset(t) = 250 + 5e-5 * t. Probes at t=0 and t=20000 -> 250 and 251 ms.
        val est = ClockEstimator()
        est.add(probe(0, 250, 10, 10)); est.add(probe(20_000, 251, 10, 10))
        val r = est.estimate(40_000 + 20) as ClockEstimator.Result.Ok
        assertTrue(r.estimate.driftApplied)
        assertEquals(50.0, r.estimate.driftPpm!!, 1.0)
        assertEquals("true offset at 40 s is 252", 252.0, r.estimate.peerMinusSelfMs, 1.0)
    }

    @Test fun t14b_implausibleDriftSlopeIsIgnored() {
        val est = ClockEstimator()
        est.add(probe(0, 250, 10, 10)); est.add(probe(12_000, 400, 10, 10)) // 150 ms in 12 s = 12500 ppm
        val r = est.estimate(12_100) as ClockEstimator.Result.Ok
        assertFalse(r.estimate.driftApplied)
    }

    @Test fun t15_staleProbeMakesLatencyUnavailable() {
        val est = ClockEstimator(); val p = probe(0, 0, 10, 10); est.add(p)
        assertTrue(est.estimate(p.atMs + 30_000) is ClockEstimator.Result.Ok)
        val r = est.estimate(p.atMs + 30_001) as ClockEstimator.Result.Unavailable
        assertEquals(ClockEstimator.Unavailable.STALE, r.reason)
        assertEquals(LatencyStatus.UNAVAILABLE_STALE, Latency.forReceivedFrame(est, 1, 2, p.atMs + 30_001).status)
        assertEquals(LatencyStatus.UNAVAILABLE_NO_PROBE, Latency.forReceivedFrame(ClockEstimator(), 1, 2, 3).status)
    }

    @Test fun uncertaintyReporting_halfDelayPlusResolutionPlusAssumedDrift() {
        val est = ClockEstimator(); val p = probe(1000, 250, 25, 25); est.add(p) // delta 50
        val fresh = (est.estimate(p.atMs) as ClockEstimator.Result.Ok).estimate
        assertEquals(25.0 + 2.0, fresh.uncertaintyMs, 1e-9)
        val aged = (est.estimate(p.atMs + 10_000) as ClockEstimator.Result.Ok).estimate
        assertEquals("100 ppm ASSUMED drift * 10 s = 1 ms", 25.0 + 2.0 + 1.0, aged.uncertaintyMs, 1e-9)
        assertFalse(aged.driftApplied)
    }

    @Test fun receivedFrameFromPeer_negativePeerOffset() {
        // Owner A initiated probes; peer B is 400 ms BEHIND A. B sends at true 3000 (B clock 2600), A receives at true 3025.
        val est = ClockEstimator(); est.add(probe(1000, -400, 25, 25))
        val l = Latency.forReceivedFrame(est, 2600, 3025, 3025 + 10)
        assertEquals(LatencyStatus.OK, l.status); assertEquals(25.0, l.latencyMs!!, 1e-9)
    }

    @Test fun receivedFrameFromPeer_positivePeerOffsetWithAsymmetry() {
        // B is 250 ms AHEAD of A; probe fwd 30 / ret 20 (so theta_hat=255, error +5). B->A frame takes 20: B stamps 5250, A reads 5020.
        val est = ClockEstimator(); est.add(probe(1000, 250, 30, 20))
        val l = Latency.forReceivedFrame(est, 5250, 5020, 5030)
        assertEquals(25.0, l.latencyMs!!, 1e-9) // true 20; error +5 = (fwd-ret)/2, inside the reported bound
        assertTrue(Math.abs(l.latencyMs!! - 20.0) <= l.uncertaintyMs!!)
    }

    @Test fun wrapAroundOfWholeTimeline() {
        val est = ClockEstimator()
        val base = U32.MOD - 100
        est.add(probe(base, 250, 25, 25))
        // peer (B, +250) sends just before wrapping its own clock; owner A receives after A wrapped
        val txB = U32.wrap(base + 60 + 250)
        val rxA = U32.wrap(base + 60 + 25)
        val l = Latency.forReceivedFrame(est, txB, rxA, base + 85)
        assertEquals(25.0, l.latencyMs!!, 1e-9)
    }
}
