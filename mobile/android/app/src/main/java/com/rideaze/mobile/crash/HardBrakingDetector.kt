package com.rideaze.mobile.crash

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.sqrt

/**
 * Thresholds for the emergency hard-braking warning. First-draft design numbers, not tuned on real
 * rides: collect [BrakingDecision]s and adjust.
 */
data class HardBrakingConfig(
  /** Longitudinal deceleration (g) that opens a braking run. */
  val decelG: Double = 0.65,
  /** The filtered deceleration must hold above [decelG] this long (ms) before an alert fires. */
  val sustainMs: Long = 150,
  /** Moving-average length (ms) applied to the longitudinal channel to reject vibration spikes. */
  val filterMs: Long = 50,
  /** The latest GNSS speed must be above this (m/s) at onset. Default 30 km/h. */
  val minSpeedMps: Double = 30.0 / 3.6,
  /** ...and no older than this (ms). The fix rate is 1 Hz. */
  val gnssMaxAgeMs: Long = 2_500,
  /** After an alert, no further alert for this long (ms). Covers multi-stage braking. */
  val cooldownMs: Long = 4_000,
  /** GNSS confirmation: how long after onset to wait for a speed drop before calling it unconfirmed. */
  val confirmWindowMs: Long = 3_000,
  /** GNSS confirmation: speed must have fallen by at least this much (m/s, ~8 km/h). */
  val confirmDropMps: Double = 2.2,
  /** A fix must be at least this long after onset to count as a confirming one (ms). */
  val confirmMinAfterMs: Long = 300,
  /** Mount-axis learning: only intervals with a GNSS acceleration at least this large (m/s^2) teach. */
  val learnMinAccel: Double = 0.6,
  /** Mount-axis learning: qualifying intervals needed before the forward axis is trusted. */
  val learnMinIntervals: Int = 5,
  /** Mount-axis learning: how consistently the intervals agree on one axis (0..1). */
  val learnCoherence: Double = 0.5,
  /** Gravity-direction rate (rad/s) above which a run is a bump / wheelie / tumble, not braking. */
  val pitchRateRadS: Double = 1.5,
  /** Without a learned axis: a GNSS-only alert needs this much deceleration between fixes (m/s^2). */
  val gnssOnlyDecel: Double = 5.0,
)

enum class BrakingSource(val wire: String) {
  /** Raised at IMU onset, using the learned forward axis. */
  IMU("imu"),
  /** Raised from two GNSS fixes because the mount axis was not learned yet. Up to ~1 s later. */
  GNSS_ONLY("gnss_only"),
}

/** The alert itself. Built at onset, before any GNSS confirmation. */
data class BrakingEvent(
  /** Per-run counter, so a receiver can drop duplicates. */
  val seq: Int,
  /** Epoch ms of the moment the deceleration threshold was first crossed. */
  val onsetAt: Long,
  /** Epoch ms the alert was raised (onset plus the sustain window). */
  val raisedAt: Long,
  val speedMps: Double,
  val peakDecelG: Double,
  /** GNSS course in degrees [0, 360), or null when the bike was too slow / no bearing. */
  val headingDeg: Double?,
  val source: BrakingSource,
)

enum class BrakingRejectReason(val wire: String) {
  /** The run was long enough but the latest GNSS speed was too low. */
  LOW_SPEED("low_speed"),
  /** ...or there was no recent GNSS fix at all. */
  NO_SPEED("no_speed"),
  /** The gravity direction moved too fast: a bump, wheelie or tumble, not a brake. */
  PITCH_RATE("pitch_rate"),
  COOLDOWN("cooldown"),
}

sealed class BrakingDecision {
  abstract val at: Long

  /** The speed really fell after an IMU alert. */
  data class Confirmed(override val at: Long, val seq: Int, val dropMps: Double) : BrakingDecision()

  /** No matching speed drop appeared in time (the warning had already gone out). */
  data class Unconfirmed(override val at: Long, val seq: Int) : BrakingDecision()

  data class Rejected(override val at: Long, val reason: BrakingRejectReason, val peakG: Double) :
    BrakingDecision()
}

interface HardBrakingListener {
  fun onHardBraking(event: BrakingEvent)

  fun onBrakingDecision(decision: BrakingDecision)
}

/**
 * Emergency hard-braking detector. Pure Kotlin and single-threaded: feed it on the sensor thread.
 *
 * Mount independence: nothing assumes which phone axis points forward.
 *  1. Linear acceleration = accelerometer - TYPE_GRAVITY (a low-pass estimate if the phone has no
 *     gravity sensor), in the phone frame.
 *  2. It is projected onto the horizontal plane (perpendicular to the current gravity direction),
 *     which removes the vertical part of potholes and the part of a fork dive that the gravity
 *     tracking has not absorbed.
 *  3. The forward axis within that plane is learned from the ride itself: every GNSS interval with
 *     a clear speed change votes with (speed change) x (mean horizontal acceleration over the
 *     interval). Accelerating and braking both vote for the same axis; cornering votes
 *     perpendicular and cancels out. Until enough intervals agree there is no axis, and only the
 *     slower GNSS-only path can raise an alert.
 *  4. Longitudinal deceleration = projection on that axis, smoothed over [HardBrakingConfig.filterMs].
 *
 * The alert fires at IMU onset (threshold held for the sustain window and the latest GNSS speed
 * above the gate), not after GNSS confirms; GNSS then confirms or marks it unconfirmed through
 * [HardBrakingListener.onBrakingDecision] for tuning.
 */
class HardBrakingDetector(
  private val config: HardBrakingConfig,
  private val listener: HardBrakingListener,
) {

  private class Fix(val t: Long, val speed: Double?, val bearing: Double?)

  private class Pending(
    val seq: Int,
    val onsetAt: Long,
    val preSpeed: Double,
    var peakG: Double,
    var done: Boolean = false,
  )

  // --- gravity / linear acceleration ---
  private var gx = 0.0
  private var gy = 0.0
  private var gz = 0.0
  private var haveGravity = false
  private var gravityAt = Long.MIN_VALUE
  private var hasGravitySensor = false
  private var lpAt = Long.MIN_VALUE
  private var lpx = 0.0
  private var lpy = 0.0
  private var lpz = 0.0
  private var prevGravityUnit: DoubleArray? = null
  private var prevGravityT = 0L

  // --- forward-axis learning ---
  private var sx = 0.0
  private var sy = 0.0
  private var sz = 0.0
  private var sumAbs = 0.0
  private var intervals = 0
  private var axisReady = false
  private var fx = 0.0
  private var fy = 0.0
  private var fz = 0.0
  private var accX = 0.0
  private var accY = 0.0
  private var accZ = 0.0
  private var accN = 0

  // --- GNSS ---
  private var lastFix: Fix? = null
  private var prevFix: Fix? = null
  private var lastBearingFix: Fix? = null

  // --- smoothing + run state ---
  private val filterT = LongArray(FILTER_CAP)
  private val filterV = DoubleArray(FILTER_CAP)
  private var filterHead = 0
  private var filterSize = 0
  private var filterSum = 0.0
  private var runStart = -1L
  private var runPeakG = 0.0
  private var runMaxPitchRate = 0.0
  private var runHandled = false
  private var cooldownUntil = Long.MIN_VALUE
  private var seq = 0
  private var pending: Pending? = null

  /** True once the forward axis is trusted. */
  val isAxisReady: Boolean
    get() = axisReady

  /** Forget the learned mount axis (the phone was moved). The GNSS-only path covers the gap. */
  fun resetMount() {
    sx = 0.0; sy = 0.0; sz = 0.0
    sumAbs = 0.0
    intervals = 0
    axisReady = false
    accX = 0.0; accY = 0.0; accZ = 0.0; accN = 0
    clearRun()
  }

  fun addGravity(t: Long, x: Double, y: Double, z: Double) {
    if (!finite(x, y, z)) return
    val n = sqrt(x * x + y * y + z * z)
    if (n < 1.0) return
    hasGravitySensor = true
    // Angular rate of the gravity direction: the pitch / bump guard. Measured over at least
    // PITCH_BASELINE_MS so sensor jitter at 100 Hz does not read as rotation.
    val unit = doubleArrayOf(x / n, y / n, z / n)
    val anchor = prevGravityUnit
    if (anchor == null || t - prevGravityT > 500) {
      prevGravityUnit = unit
      prevGravityT = t
    } else if (t - prevGravityT >= PITCH_BASELINE_MS) {
      val dt = (t - prevGravityT) / 1000.0
      val dot = (anchor[0] * unit[0] + anchor[1] * unit[1] + anchor[2] * unit[2]).coerceIn(-1.0, 1.0)
      val rate = acos(dot) / dt
      if (runStart >= 0 && rate > runMaxPitchRate) runMaxPitchRate = rate
      prevGravityUnit = unit
      prevGravityT = t
    }
    gx = x; gy = y; gz = z
    haveGravity = true
    gravityAt = t
  }

  fun addAccel(t: Long, x: Double, y: Double, z: Double) {
    if (!finite(x, y, z)) return
    // Gravity: the fused sensor while it is alive, otherwise a 1 s low-pass of the accelerometer.
    if (!(hasGravitySensor && haveGravity && t - gravityAt <= GRAVITY_STALE_MS)) {
      if (lpAt == Long.MIN_VALUE) {
        lpx = x; lpy = y; lpz = z
      } else {
        val dt = (t - lpAt).coerceIn(1L, 200L) / 1000.0
        val k = dt / (LP_TAU_S + dt)
        lpx += k * (x - lpx); lpy += k * (y - lpy); lpz += k * (z - lpz)
      }
      lpAt = t
      gx = lpx; gy = lpy; gz = lpz
      haveGravity = true
    }
    val gn = sqrt(gx * gx + gy * gy + gz * gz)
    if (gn < 1.0) return
    val ux = gx / gn
    val uy = gy / gn
    val uz = gz / gn

    // Linear acceleration, then its horizontal part (gravity-axis component removed).
    val lx = x - gx
    val ly = y - gy
    val lz = z - gz
    val up = lx * ux + ly * uy + lz * uz
    val hx = lx - up * ux
    val hy = ly - up * uy
    val hz = lz - up * uz

    accX += hx; accY += hy; accZ += hz; accN++

    if (!axisReady) return
    // Re-project the learned axis onto the current horizontal plane (the phone may have pitched).
    val fu = fx * ux + fy * uy + fz * uz
    var ax = fx - fu * ux
    var ay = fy - fu * uy
    var az = fz - fu * uz
    val an = sqrt(ax * ax + ay * ay + az * az)
    if (an < MIN_AXIS_PLANE) return
    ax /= an; ay /= an; az /= an

    val along = (hx * ax + hy * ay + hz * az) / STANDARD_GRAVITY
    val smoothed = smooth(t, along)
    step(t, -smoothed)
  }

  /** [bearingDeg] is the GNSS course in degrees; position is deliberately not taken here. */
  fun addGnss(t: Long, speedMps: Double?, bearingDeg: Double? = null) {
    val speed = speedMps?.takeIf { it.isFinite() && it >= 0.0 }
    val bearing = bearingDeg?.takeIf { it.isFinite() }
    val fix = Fix(t, speed, bearing)
    val prev = lastFix
    if (prev != null && fix.t < prev.t) return // out of order
    prevFix = prev
    lastFix = fix
    if (speed != null && bearing != null && speed >= BEARING_MIN_SPEED) lastBearingFix = fix

    val p = prevFix
    if (p != null && p.speed != null && speed != null) {
      val dt = (t - p.t) / 1000.0
      if (dt in 0.5..2.0) {
        learn(p.speed, speed, dt)
        pending?.let { evaluateConfirmation(it, fix) }
        if (!axisReady) gnssOnly(p, fix, dt)
      }
    }
    // The accumulator always restarts at a fix so each interval is learned from its own samples.
    accX = 0.0; accY = 0.0; accZ = 0.0; accN = 0
  }

  /** Expires an unconfirmed alert. Call a few times a second. */
  fun tick(now: Long) {
    val p = pending ?: return
    if (!p.done && now - p.onsetAt > config.confirmWindowMs) {
      p.done = true
      listener.onBrakingDecision(BrakingDecision.Unconfirmed(now, p.seq))
    }
    if (p.done && now - p.onsetAt > config.confirmWindowMs) pending = null
  }

  fun reset() {
    resetMount()
    lastFix = null; prevFix = null; lastBearingFix = null
    haveGravity = false; hasGravitySensor = false
    gravityAt = Long.MIN_VALUE; lpAt = Long.MIN_VALUE
    prevGravityUnit = null
    cooldownUntil = Long.MIN_VALUE
    pending = null
    filterSize = 0; filterHead = 0; filterSum = 0.0
  }

  // --- internals ---

  private fun learn(v0: Double, v1: Double, dt: Double) {
    if (accN == 0) return
    val a = (v1 - v0) / dt
    if (abs(a) < config.learnMinAccel || (v0 + v1) / 2 < LEARN_MIN_SPEED) return
    val mx = accX / accN
    val my = accY / accN
    val mz = accZ / accN
    // Old evidence fades, so a re-mounted phone is relearned within a couple of minutes.
    sx = sx * LEARN_DECAY + a * mx
    sy = sy * LEARN_DECAY + a * my
    sz = sz * LEARN_DECAY + a * mz
    sumAbs = sumAbs * LEARN_DECAY + abs(a) * sqrt(mx * mx + my * my + mz * mz)
    intervals++
    val mag = sqrt(sx * sx + sy * sy + sz * sz)
    if (mag < 1e-6 || sumAbs < 1e-6) return
    fx = sx / mag; fy = sy / mag; fz = sz / mag
    axisReady = intervals >= config.learnMinIntervals && mag / sumAbs >= config.learnCoherence
  }

  /** Moving average of the longitudinal channel over [HardBrakingConfig.filterMs]. */
  private fun smooth(t: Long, v: Double): Double {
    if (filterSize == FILTER_CAP) {
      filterSum -= filterV[filterHead]
      filterHead = (filterHead + 1) % FILTER_CAP
      filterSize--
    }
    val tail = (filterHead + filterSize) % FILTER_CAP
    filterT[tail] = t
    filterV[tail] = v
    filterSum += v
    filterSize++
    while (filterSize > 1 && t - filterT[filterHead] > config.filterMs) {
      filterSum -= filterV[filterHead]
      filterHead = (filterHead + 1) % FILTER_CAP
      filterSize--
    }
    return filterSum / filterSize
  }

  /** [decel] is the smoothed deceleration in g (positive = slowing down). */
  private fun step(t: Long, decel: Double) {
    if (decel < config.decelG) {
      clearRun()
      return
    }
    if (runStart < 0) {
      runStart = t
      runPeakG = decel
      runMaxPitchRate = 0.0
      runHandled = false
    } else if (decel > runPeakG) {
      runPeakG = decel
    }
    pending?.let { if (!it.done && decel > it.peakG) it.peakG = decel }
    if (runHandled || t - runStart < config.sustainMs) return

    val reject = gate(t)
    if (reject != null) {
      runHandled = true
      listener.onBrakingDecision(BrakingDecision.Rejected(t, reject, runPeakG))
      return
    }
    runHandled = true
    cooldownUntil = t + config.cooldownMs
    seq++
    val fix = lastFix!!
    val event =
      BrakingEvent(
        seq = seq,
        onsetAt = runStart,
        raisedAt = t,
        speedMps = fix.speed!!,
        peakDecelG = runPeakG,
        headingDeg = headingAt(t),
        source = BrakingSource.IMU,
      )
    pending = Pending(seq, runStart, fix.speed, runPeakG)
    listener.onHardBraking(event)
  }

  private fun gate(t: Long): BrakingRejectReason? {
    if (runMaxPitchRate > config.pitchRateRadS) return BrakingRejectReason.PITCH_RATE
    if (t < cooldownUntil) return BrakingRejectReason.COOLDOWN
    val fix = lastFix
    if (fix == null || fix.speed == null || t - fix.t > config.gnssMaxAgeMs || fix.t > t + 1_000) {
      return BrakingRejectReason.NO_SPEED
    }
    if (fix.speed < config.minSpeedMps) return BrakingRejectReason.LOW_SPEED
    return null
  }

  private fun evaluateConfirmation(p: Pending, fix: Fix) {
    if (p.done || fix.speed == null || fix.t - p.onsetAt < config.confirmMinAfterMs) return
    val drop = p.preSpeed - fix.speed
    if (drop >= config.confirmDropMps) {
      p.done = true
      listener.onBrakingDecision(BrakingDecision.Confirmed(fix.t, p.seq, drop))
    }
  }

  /** Slower path used until the mount axis is learned: two consecutive fixes show a hard stop. */
  private fun gnssOnly(prev: Fix, fix: Fix, dt: Double) {
    val v0 = prev.speed ?: return
    val v1 = fix.speed ?: return
    val decel = (v0 - v1) / dt
    if (decel < config.gnssOnlyDecel || v0 < config.minSpeedMps || fix.t < cooldownUntil) return
    cooldownUntil = fix.t + config.cooldownMs
    seq++
    val peak = decel / STANDARD_GRAVITY
    listener.onHardBraking(
      BrakingEvent(
        seq = seq,
        onsetAt = prev.t,
        raisedAt = fix.t,
        speedMps = v0,
        peakDecelG = peak,
        headingDeg = headingAt(fix.t),
        source = BrakingSource.GNSS_ONLY,
      ),
    )
    listener.onBrakingDecision(BrakingDecision.Confirmed(fix.t, seq, v0 - v1))
  }

  private fun headingAt(t: Long): Double? {
    val f = lastBearingFix ?: return null
    if (t - f.t > BEARING_MAX_AGE_MS) return null
    val b = f.bearing ?: return null
    return ((b % 360.0) + 360.0) % 360.0
  }

  private fun clearRun() {
    runStart = -1
    runPeakG = 0.0
    runMaxPitchRate = 0.0
    runHandled = false
  }

  private fun finite(x: Double, y: Double, z: Double) = x.isFinite() && y.isFinite() && z.isFinite()

  private companion object {
    // 50 ms of 200 Hz samples is 10; leave room for a faster sensor.
    const val FILTER_CAP = 64
    const val GRAVITY_STALE_MS = 500L
    const val PITCH_BASELINE_MS = 100L
    const val LP_TAU_S = 1.0
    const val MIN_AXIS_PLANE = 0.3
    const val LEARN_DECAY = 0.97
    const val LEARN_MIN_SPEED = 3.0
    const val BEARING_MIN_SPEED = 2.0
    const val BEARING_MAX_AGE_MS = 3_000L
  }
}
