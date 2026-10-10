package com.rideaze.mobile.crash

const val STANDARD_GRAVITY = 9.80665

/**
 * Thresholds for the crash / laydown pipeline. Every value is a first-draft design number, not
 * tuned on real crash data: collect [CrashDecision]s from real rides and adjust.
 */
data class CrashConfig(
  /** Stage 1: resultant acceleration (g) that opens a crash candidate. */
  val impactG: Double = 3.5,
  /** Lower trigger (g) for the low-speed tip-over path; ignored when [enableLowSpeedLaydown] is off. */
  val laydownImpactG: Double = 1.8,
  val enableLowSpeedLaydown: Boolean = true,
  /** Stage 2: gyro magnitude (rad/s) needed within +-1 s of the impact on the crash path. */
  val rotationRadS: Double = 5.0,
  /** Gyro magnitude (rad/s) needed on the low-speed laydown path (a tip-over rotates slowly). */
  val laydownRotationRadS: Double = 2.0,
  /** Stage 3: rest gravity must differ from the riding reference by at least this many degrees. */
  val tiltDeg: Double = 60.0,
  /** Stage 3: required stillness (ms) when GNSS confirms the stop. Spec window is 3-5 s. */
  val stillMs: Long = 4_000,
  /** Required stillness (ms) when GNSS cannot confirm (no fix, stopped bike) or the gyro is missing. */
  val stillMsNoGnss: Long = 10_000,
  /** Required stillness (ms) on the low-speed laydown path. */
  val stillMsLaydown: Long = 8_000,
  /** "Still" = mean gyro magnitude below this (rad/s) over a 1 s window... */
  val stillGyroRadS: Double = 0.5,
  /** ...and standard deviation of acceleration magnitude below this (m/s^2). */
  val stillAccelStd: Double = 1.0,
  /** Candidate lifetime from the impact; unconfirmed candidates are dropped after this (ms). */
  val windowMs: Long = 25_000,
  /** Stage 4: speed (m/s) before the impact for the crash path. Default 20 km/h. */
  val minPreSpeedMps: Double = 20.0 / 3.6,
  /** Below this pre-impact speed (m/s) the phone was effectively parked: reject. Default 5 km/h. */
  val stationaryMps: Double = 5.0 / 3.6,
  /** Stage 4: after the settle delay, speed at or below this (m/s) is "stopped". Default 5 km/h. */
  val stoppedMps: Double = 5.0 / 3.6,
  /** After the settle delay, speed above this (m/s) means the bike is still moving: reject. */
  val stillMovingMps: Double = 3.0,
  /** A fix only counts as the pre-impact speed if it is at most this old (ms). */
  val gnssMaxAgeMs: Long = 5_000,
  /** A post-impact fix only counts once it is this long after the impact (a slide takes seconds). */
  val gnssSettleMs: Long = 5_000,
  /** Acceleration below this (g) for [freeFallMs] just before the impact = the phone was falling. */
  val freeFallG: Double = 0.3,
  val freeFallMs: Long = 80,
  val countdownMsHigh: Long = 40_000,
  val countdownMsMedium: Long = 40_000,
  /** After a cancel / acknowledged alert, no new crash is declared for this long (ms). */
  val cooldownMs: Long = 60_000,
  /** A fix at or above this speed (m/s) during the countdown means the rider is riding on. */
  val resumeSpeedMps: Double = 20.0 / 3.6,
)

enum class CrashPhase(val wire: String) {
  IDLE("idle"),
  COUNTDOWN("countdown"),
  SOS("sos"),
  CANCELLED("cancelled"),
}

enum class CrashConfidence(val wire: String) {
  HIGH("high"),
  MEDIUM("medium"),
}

/** Which evidence path produced the detection. MANUAL = a demo / dev-menu trigger. */
enum class CrashPath(val wire: String) {
  CRASH("crash"),
  CRASH_NO_GNSS("crash_no_gnss"),
  LAYDOWN("laydown"),
  MANUAL("manual"),
}

enum class CrashRejectReason(val wire: String) {
  NO_ROTATION("no_rotation"),
  WAS_STATIONARY("was_stationary"),
  STILL_MOVING("still_moving"),
  MOUNT_DROP_SUSPECTED("mount_drop_suspected"),
  UPRIGHT("upright"),
  LOW_SPEED_DISABLED("low_speed_disabled"),
  EXPIRED("expired"),
}

data class CrashEvidence(
  val path: CrashPath,
  val confidence: CrashConfidence,
  /** Epoch ms of the impact (the trigger time for MANUAL). */
  val impactAt: Long,
  val peakG: Double,
  val maxGyroRadS: Double?,
  val tiltDeg: Double?,
  val preSpeedMps: Double?,
  val postSpeedMps: Double?,
  val stillMs: Long,
  val freeFallBeforeImpact: Boolean,
)

data class CrashState(
  val phase: CrashPhase = CrashPhase.IDLE,
  val confidence: CrashConfidence? = null,
  val severity: String? = null,
  /** Length of the countdown that just started (ms); set during COUNTDOWN. */
  val countdownMs: Long? = null,
  /** Epoch ms at which the countdown ends; set during COUNTDOWN. */
  val countdownEndsAt: Long? = null,
  val evidence: CrashEvidence? = null,
  /** Why the last countdown was cancelled ("user" | "riding_resumed" | ...); set during CANCELLED. */
  val cancelReason: String? = null,
)

/** The alert sent to the group when a countdown runs out (or is sent early). */
data class SosPayload(
  /** Unique per alert, so the JS side can dedupe a re-delivered one. */
  val sosId: String,
  /** Epoch ms when the alert was dispatched. */
  val timestamp: Long,
  val impactTimestamp: Long,
  /** Last known GNSS position, or null if no fix was ever received. */
  val latitude: Double?,
  val longitude: Double?,
  /** How old that position was at dispatch (ms), or null without a fix. */
  val locationAgeMs: Long?,
  /** Best speed seen in the seconds before the impact (m/s), or null without GNSS. */
  val speedBeforeImpactMps: Double?,
  /** "SEVERE" | "HIGH" | "MODERATE" | "UNKNOWN" -- see [severityOf]. */
  val severity: String,
  val confidence: CrashConfidence,
  val path: CrashPath,
  val peakG: Double,
  /** "expired" (countdown ran out) | "user_sent" (rider skipped the wait). */
  val trigger: String,
)

sealed class CrashDecision {
  abstract val at: Long

  data class Confirmed(override val at: Long, val evidence: CrashEvidence) : CrashDecision()

  data class Rejected(override val at: Long, val reason: CrashRejectReason, val peakG: Double) :
    CrashDecision()
}

data class CalibrationResult(
  val success: Boolean,
  /** Failure reason: "busy" | "not_steady" | "no_data" | "interrupted"; null on success. */
  val reason: String? = null,
  /** Angle (deg) between the old and new riding reference, when both existed. */
  val deltaDeg: Double? = null,
)

/**
 * Receives the detector's outputs. Called on whatever thread drives the detector (the sensor
 * thread in production), so implementations must be quick and hand work off.
 */
interface CrashDetectorListener {
  /** Phase or countdown changed. Not fired for internal candidates. */
  fun onStateChanged(state: CrashState)

  /** A countdown ran out (or the rider skipped it): dispatch the alert. Fired once per alert. */
  fun onCountdownExpired(sos: SosPayload)

  /** Every finished candidate, confirmed or rejected -- the tuning log. */
  fun onDecision(decision: CrashDecision) {}

  fun onCalibration(result: CalibrationResult) {}
}

/** Severity label for an alert: SEVERE needs a very hard, GNSS-confirmed impact. */
fun severityOf(evidence: CrashEvidence): String =
  when {
    evidence.path == CrashPath.MANUAL -> "UNKNOWN"
    evidence.confidence == CrashConfidence.HIGH && evidence.peakG >= 6.0 -> "SEVERE"
    evidence.confidence == CrashConfidence.HIGH -> "HIGH"
    else -> "MODERATE"
  }
