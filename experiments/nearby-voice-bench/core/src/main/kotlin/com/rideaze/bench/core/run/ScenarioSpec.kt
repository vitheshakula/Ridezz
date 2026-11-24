package com.rideaze.bench.core.run

import com.rideaze.bench.core.protocol.Wire
import com.rideaze.bench.core.queue.OverflowPolicy

/** RAW: raw transport capacity (no deadlines). REALTIME: real-time suitability (bounded, expiring). */
enum class Mode(val code: String) { RAW("raw"), REALTIME("rt") }

/**
 * What frees a slot in the in-flight window.
 * TRANSFER_RESULT: the platform's transfer-complete callback (workshop spec). UNVERIFIED for the BYTES sender side:
 * Google's guide says BYTES are sent as one chunk and need not wait for SUCCESS, and describes the SUCCESS update only
 * on the receiving side. If a device smoke test shows no sender-side updates, switch to ACCEPTED.
 * ACCEPTED: the sendPayload() task completing successfully (platform accepted the bytes, NOT delivery).
 */
enum class WindowRelease { TRANSFER_RESULT, ACCEPTED }

/**
 * One E1 scenario. All thresholds below are PROPOSALS from the accepted workshop spec, not requirements.
 * A scenario is run [repeats] times; each repetition is a "run" identified by (scenario id, run index).
 */
data class ScenarioSpec(
    val id: String,
    val mode: Mode,
    val transport: String = "BYTES",
    val encodedKbps: Int,
    val frameRateHz: Int = 50,
    val durationS: Int = 120,
    val repeats: Int = 5,
    val queueCapacity: Int,
    val overflowPolicy: OverflowPolicy,
    /** REALTIME only: drop at dequeue if older than this (generation -> submission). */
    val sendExpiryMs: Long?,
    /** Max payloads awaiting a transfer result. REALTIME: 2. RAW: large but bounded. */
    val maxInFlight: Int,
    /** A slot not released by a transfer result within this time is force-released and counted. */
    val inFlightTimeoutMs: Long = 2_000,
    /** REALTIME only: playout deadline from generation (offset-corrected). */
    val playoutDeadlineMs: Long?,
    val probeIntervalMs: Long = 5_000,
    val initialProbes: Int = 8,
    val initialProbeSpacingMs: Long = 250,
    val drainGraceMs: Long = 2_000,
    /**
     * After sending END the sender keeps the connection open until the receiver's DONE arrives or this wait expires.
     * Must exceed the receiver's finalize grace, otherwise the sender could hang up while the receiver still collects.
     */
    val senderEndWaitMs: Long = 8_000,
    /** END is re-sent at this interval until DONE arrives (a lost END must not silently truncate the receiver's view). */
    val endResendIntervalMs: Long = 2_000,
    val windowRelease: WindowRelease = WindowRelease.TRANSFER_RESULT,
    val receiverFinalizeGraceMs: Long = 3_000,
    val receiverIdleTimeoutMs: Long = 10_000,
    val stallThresholdMs: Long = 200,
    val resourceSampleIntervalMs: Long = 1_000,
) {
    val payloadBytes: Int get() = encodedKbps * 1000 / 8 / frameRateHz
    val wireBytesPerFrame: Int get() = payloadBytes + Wire.FIXED_OVERHEAD
    val wireKbps: Double get() = wireBytesPerFrame * 8.0 * frameRateHz / 1000.0
    val framePeriodMs: Double get() = 1000.0 / frameRateHz
    val totalFrames: Long get() = durationS.toLong() * frameRateHz

    /** Benchmark CONFIGURATION errors. A non-empty result means the run must not start. */
    fun validate(): List<String> {
        val e = ArrayList<String>()
        if (id.isBlank()) e.add("id blank")
        // The policy is part of the experiment's identity: results under different policies must never share an id.
        if ((windowRelease == WindowRelease.ACCEPTED) != id.endsWith(ACK_SUFFIX))
            e.add("scenario id '$id' does not match windowRelease=$windowRelease (ids for windowRelease=ACCEPTED must end with '$ACK_SUFFIX', others must not)")
        if (transport != "BYTES") e.add("transport '$transport' not implemented in M1 (BYTES only)")
        if (frameRateHz != 50) e.add("frameRateHz must be 50 in M1 (20 ms frames)")
        if (encodedKbps <= 0) e.add("encodedKbps must be > 0")
        else if ((encodedKbps * 1000) % (8 * frameRateHz) != 0) e.add("encodedKbps*1000/8 not divisible by frameRateHz: payload would not be integral")
        if (payloadBytes !in 1..Wire.MAX_PAYLOAD) e.add("payloadBytes $payloadBytes outside 1..${Wire.MAX_PAYLOAD}")
        if (durationS <= 0) e.add("durationS must be > 0")
        if (repeats < 1) e.add("repeats must be >= 1")
        if (queueCapacity < 1) e.add("queueCapacity must be >= 1")
        if (maxInFlight < 1) e.add("maxInFlight must be >= 1")
        if (inFlightTimeoutMs < 100) e.add("inFlightTimeoutMs too small")
        if (senderEndWaitMs < receiverFinalizeGraceMs + 1_000) e.add("senderEndWaitMs must exceed receiverFinalizeGraceMs by >= 1000 ms")
        if (endResendIntervalMs < 500) e.add("endResendIntervalMs must be >= 500")
        if (probeIntervalMs < 1_000) e.add("probeIntervalMs must be >= 1000")
        if (initialProbes < 2) e.add("initialProbes must be >= 2")
        when (mode) {
            Mode.RAW -> {
                if (sendExpiryMs != null) e.add("RAW mode must not use sendExpiryMs")
                if (playoutDeadlineMs != null) e.add("RAW mode must not use playoutDeadlineMs")
            }
            Mode.REALTIME -> {
                if (sendExpiryMs == null || sendExpiryMs <= 0) e.add("REALTIME requires sendExpiryMs > 0")
                if (playoutDeadlineMs == null || playoutDeadlineMs <= 0) e.add("REALTIME requires playoutDeadlineMs > 0")
                if (overflowPolicy != OverflowPolicy.DROP_OLDEST) e.add("REALTIME must drop oldest on overflow")
            }
        }
        return e
    }

    companion object { const val ACK_SUFFIX = "-ack" }

    fun runId(runIndex: Int, label: String): String = "$id-r$runIndex-$label"

    /** Short stable value both phones compute; mismatching operator selections are detected during probing. */
    fun fingerprint(runIndex: Int): Long {
        var h = 0x811C9DC5L
        for (ch in "$id|$runIndex|$encodedKbps|${mode.code}|$durationS|${windowRelease.name}") {
            h = (h xor ch.code.toLong()) * 0x01000193L
            h = h and 0xFFFFFFFFL
        }
        return h
    }
}

/**
 * Proposed acceptance targets. PROPOSALS, recorded into every run so analysis never hard-codes them.
 * Every fraction names its denominator. Real-time success is judged against GENERATED frames, so frames dropped
 * before submission count against the run (a run that drops most of its audio can never pass).
 */
object AcceptanceProposal {
    const val VERSION = "proposal-v2"
    const val ACCEPTED_OF_GENERATED_MIN = 0.98 // RAW: accepted / generated
    const val INTACT_OF_GENERATED_MIN = 0.98 // RAW: received intact / generated
    const val ON_TIME_OF_GENERATED_MIN = 0.95 // REALTIME: provably on time / generated
    const val TRANSFER_FAILURE_OF_ACCEPTED_MAX = 0.01 // reported transfer failures / accepted
    const val CORRUPT_OF_RECEIVED_MAX = 0.001 // corrupt payloads / distinct frames received
    const val STALLS_PER_120S_MAX = 2
    const val REPRO_CV_MAX = 0.15
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "version" to VERSION, "accepted_of_generated_min" to ACCEPTED_OF_GENERATED_MIN,
        "intact_of_generated_min" to INTACT_OF_GENERATED_MIN, "on_time_of_generated_min" to ON_TIME_OF_GENERATED_MIN,
        "transfer_failure_of_accepted_max" to TRANSFER_FAILURE_OF_ACCEPTED_MAX, "corrupt_of_received_max" to CORRUPT_OF_RECEIVED_MAX,
        "stalls_per_120s_max" to STALLS_PER_120S_MAX, "repro_cv_max" to REPRO_CV_MAX, "is_requirement" to false,
    )
}

object Scenarios {
    val E1_BITRATES_KBPS = listOf(12, 16, 24, 30, 48, 64, 96)

    /**
     * Base scenarios use windowRelease=TRANSFER_RESULT (ids unchanged: e1-bytes-rt-24k). The same scenarios with
     * windowRelease=ACCEPTED have their own ids with the suffix "-ack" (e1-bytes-rt-24k-ack): the fallback if a device smoke
     * test shows no sender-side BYTES transfer updates. A slot freed on ACCEPTED means "the platform took the bytes", which is
     * neither transfer completion nor receiver-confirmed delivery.
     */
    fun e1Bytes(kbps: Int, mode: Mode, release: WindowRelease = WindowRelease.TRANSFER_RESULT): ScenarioSpec {
        val suffix = if (release == WindowRelease.ACCEPTED) ScenarioSpec.ACK_SUFFIX else ""
        return when (mode) {
            Mode.RAW -> ScenarioSpec(
                id = "e1-bytes-raw-${kbps}k$suffix", mode = mode, encodedKbps = kbps,
                queueCapacity = 50, overflowPolicy = OverflowPolicy.DROP_NEWEST,
                sendExpiryMs = null, maxInFlight = 50, playoutDeadlineMs = null, windowRelease = release,
            )
            Mode.REALTIME -> ScenarioSpec(
                id = "e1-bytes-rt-${kbps}k$suffix", mode = mode, encodedKbps = kbps,
                queueCapacity = 3, overflowPolicy = OverflowPolicy.DROP_OLDEST,
                sendExpiryMs = 80, maxInFlight = 2, playoutDeadlineMs = 200, windowRelease = release,
            )
        }
    }

    /** 7 bitrates x 2 modes x 2 window-release policies = 28 distinct scenario ids. */
    val e1BytesMatrix: List<ScenarioSpec> = WindowRelease.values().flatMap { r ->
        E1_BITRATES_KBPS.flatMap { k -> listOf(e1Bytes(k, Mode.RAW, r), e1Bytes(k, Mode.REALTIME, r)) }
    }

    fun byId(id: String): ScenarioSpec? = e1BytesMatrix.firstOrNull { it.id == id }
}
