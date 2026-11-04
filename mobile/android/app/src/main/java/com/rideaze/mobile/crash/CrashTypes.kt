package com.rideaze.mobile.crash

const val STANDARD_GRAVITY = 9.80665

data class CrashConfig(
  val impactG: Double = 3.5,
  val laydownImpactG: Double = 1.8,
  val enableLowSpeedLaydown: Boolean = true,
  val rotationRadS: Double = 5.0,
  val laydownRotationRadS: Double = 2.0,
  val tiltDeg: Double = 60.0,
  val stillMs: Long = 4_000,
  val stillMsNoGnss: Long = 10_000,
  val stillMsLaydown: Long = 8_000,
  val stillGyroRadS: Double = 0.5,
  val stillAccelStd: Double = 1.0,
  val windowMs: Long = 25_000,
  val minPreSpeedMps: Double = 20.0 / 3.6,
  val stationaryMps: Double = 5.0 / 3.6,
  val stoppedMps: Double = 5.0 / 3.6,
  val stillMovingMps: Double = 3.0,
  val gnssMaxAgeMs: Long = 5_000,
  val gnssSettleMs: Long = 5_000,
  val freeFallG: Double = 0.3,
  val freeFallMs: Long = 80,
  val countdownMsHigh: Long = 40_000,
  val countdownMsMedium: Long = 40_000,
  val cooldownMs: Long = 60_000,
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
  val countdownMs: Long? = null,
  val countdownEndsAt: Long? = null,
  val evidence: CrashEvidence? = null,
  val cancelReason: String? = null,
)

data class SosPayload(
  val sosId: String,
  val timestamp: Long,
  val impactTimestamp: Long,
  val latitude: Double?,
  val longitude: Double?,
  val locationAgeMs: Long?,
  val speedBeforeImpactMps: Double?,
  val severity: String,
  val confidence: CrashConfidence,
  val path: CrashPath,
  val peakG: Double,
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
  val reason: String? = null,
  val deltaDeg: Double? = null,
)

interface CrashDetectorListener {
  fun onStateChanged(state: CrashState)

  fun onCountdownExpired(sos: SosPayload)

  fun onDecision(decision: CrashDecision) {}

  fun onCalibration(result: CalibrationResult) {}
}

fun severityOf(evidence: CrashEvidence): String =
  when {
    evidence.path == CrashPath.MANUAL -> "UNKNOWN"
    evidence.confidence == CrashConfidence.HIGH && evidence.peakG >= 6.0 -> "SEVERE"
    evidence.confidence == CrashConfidence.HIGH -> "HIGH"
    else -> "MODERATE"
  }
