package com.rideaze.bench.core.clock

import com.rideaze.bench.core.U32

/**
 * Four-timestamp exchange. The INITIATOR is the device that sends the probe.
 *  t0 = initiator send (initiator clock)   t1 = responder receive (responder clock)
 *  t2 = responder send (responder clock)   t3 = initiator receive (initiator clock)
 * All values are 32-bit millisecond stamps; differences use modular arithmetic.
 *
 * Convention used everywhere: theta = clock(receiver) - clock(sender).
 * A probe measures theta_peerMinusSelf = clock(responder) - clock(initiator).
 */
class ProbeSample(
    val t0: Long, val t1: Long, val t2: Long, val t3: Long,
    /** Initiator's un-wrapped monotonic time at t3; used only to order and age probes. */
    val atMs: Long,
) {
    private val outbound = U32.signedDiff(t1, t0)
    private val inbound = U32.signedDiff(t2, t3)
    private val total = U32.signedDiff(t3, t0)
    private val residence = U32.signedDiff(t2, t1)

    /** theta_hat = ((t1 - t0) + (t2 - t3)) / 2 = clock(responder) - clock(initiator). */
    val offsetMs: Double get() = (outbound + inbound) / 2.0

    /** delta = (t3 - t0) - (t2 - t1): round-trip network delay excluding responder residence. */
    val delayMs: Long get() = total - residence

    /** Asymmetry bound: |theta_hat - theta| <= delta / 2 (plus timestamp resolution). */
    val asymmetryBoundMs: Double get() = delayMs / 2.0

    fun isValid(): Boolean = total >= 0 && residence >= 0 && delayMs >= 0
}

data class ThetaEstimate(
    /** clock(peer) - clock(self) at query time. */
    val peerMinusSelfMs: Double,
    val uncertaintyMs: Double,
    val probeAgeMs: Long,
    val bestDelayMs: Long,
    val driftPpm: Double?,
    val driftApplied: Boolean,
)

class ClockEstimator(
    private val maxProbes: Int = 8,
    private val staleMs: Long = 30_000,
    private val driftMinSeparationMs: Long = 10_000,
    private val driftSanityPpm: Double = 500.0,
    /** ASSUMPTION (not measured): relative drift bound used when drift cannot be estimated. */
    private val assumedDriftPpm: Double = 100.0,
    private val resolutionMs: Double = 1.0,
) {
    private val probes = ArrayList<ProbeSample>()
    var rejectedProbes = 0L; private set
    var acceptedProbes = 0L; private set

    fun add(sample: ProbeSample): Boolean {
        if (!sample.isValid()) { rejectedProbes++; return false }
        acceptedProbes++
        probes.add(sample)
        while (probes.size > maxProbes) probes.removeAt(0)
        return true
    }

    enum class Unavailable { NO_PROBE, STALE }

    sealed interface Result {
        class Ok(val estimate: ThetaEstimate) : Result
        class Unavailable(val reason: ClockEstimator.Unavailable) : Result
    }

    fun estimate(nowMs: Long): Result {
        if (probes.isEmpty()) return Result.Unavailable(Unavailable.NO_PROBE)
        // Freshness is applied BEFORE choosing the minimum-delay probe: an old low-delay probe must never shadow
        // newer usable ones, and must never make the estimate "stale" while newer probes exist.
        val fresh = probes.filter { nowMs - it.atMs <= staleMs }
        if (fresh.isEmpty()) return Result.Unavailable(Unavailable.STALE)
        var best = fresh[0]
        for (p in fresh) if (p.delayMs <= best.delayMs) best = p // ties: most recent
        val age = nowMs - best.atMs

        var driftPerMs: Double? = null
        var slopeErr = 0.0
        // Drift is a SLOPE: older probes are legitimate evidence for it. Only the offset candidate must be fresh.
        val oldest = probes.first()
        val newest = probes.last()
        val sep = newest.atMs - oldest.atMs
        if (sep >= driftMinSeparationMs) {
            val e = (newest.offsetMs - oldest.offsetMs) / sep
            if (Math.abs(e) * 1e6 <= driftSanityPpm) {
                driftPerMs = e
                slopeErr = (oldest.asymmetryBoundMs + newest.asymmetryBoundMs) / sep
            }
        }
        val theta = best.offsetMs + (driftPerMs ?: 0.0) * age
        val driftTerm = if (driftPerMs != null) slopeErr * age else assumedDriftPpm * 1e-6 * age
        // delta/2 (asymmetry) + 2 ms resolution (theta: +-1 ms from two floored terms; two frame stamps: +-0.5 ms each) + drift
        val u = best.asymmetryBoundMs + 2 * resolutionMs + driftTerm
        return Result.Ok(ThetaEstimate(theta, u, age, best.delayMs, driftPerMs?.let { it * 1e6 }, driftPerMs != null))
    }
}

enum class LatencyStatus { OK, UNAVAILABLE_NO_PROBE, UNAVAILABLE_STALE, IMPLAUSIBLE }

data class LatencyEstimate(val status: LatencyStatus, val latencyMs: Double?, val uncertaintyMs: Double?)

object Latency {
    const val MAX_PLAUSIBLE_MS = 10_000.0

    /**
     * One-way latency of a frame: L = (receiver timestamp) - (sender timestamp) - theta,
     * with theta = clock(receiver) - clock(sender). Timestamps are 32-bit and wrap.
     */
    fun oneWay(senderTxMs: Long, receiverRxMs: Long, thetaReceiverMinusSenderMs: Double): Double =
        U32.signedDiff(receiverRxMs, senderTxMs) - thetaReceiverMinusSenderMs

    /**
     * Frame sent by the PEER of the estimator's owner and received by the owner.
     * The estimator measures clock(peer) - clock(self) = clock(sender) - clock(receiver) = -theta.
     */
    fun forReceivedFrame(est: ClockEstimator, senderTxMs: Long, receiverRxMs: Long, nowMs: Long): LatencyEstimate =
        when (val r = est.estimate(nowMs)) {
            is ClockEstimator.Result.Unavailable -> LatencyEstimate(
                if (r.reason == ClockEstimator.Unavailable.NO_PROBE) LatencyStatus.UNAVAILABLE_NO_PROBE
                else LatencyStatus.UNAVAILABLE_STALE, null, null,
            )
            is ClockEstimator.Result.Ok -> {
                val theta = -r.estimate.peerMinusSelfMs
                val l = oneWay(senderTxMs, receiverRxMs, theta)
                val u = r.estimate.uncertaintyMs
                if (l > MAX_PLAUSIBLE_MS || l < -u) LatencyEstimate(LatencyStatus.IMPLAUSIBLE, l, u)
                else LatencyEstimate(LatencyStatus.OK, l, u)
            }
        }
}
