package com.rideaze.mobile.crash

import java.util.UUID
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Crash / bike-laydown detection pipeline. Pure Kotlin: no Android classes, no clocks of its own --
 * every input carries its own epoch-ms timestamp, so the whole pipeline is unit-tested on the JVM
 * by replaying synthetic sensor traces (see CrashDetectorCoreTest).
 *
 * THREADING: single-threaded by contract. In production every call, including [tick], is made on
 * the sensor HandlerThread; callers on other threads must post to it.
 *
 * Stages, all of which must agree before the countdown starts:
 *  1. IMPACT     |a| >= impactG (3.5 g). A lower trigger (1.8 g) opens candidates for the low-speed
 *                laydown path, which then needs the stricter checks.
 *  2. ROTATION   gyro |w| >= rotationRadS (5 rad/s) within +-1 s of the impact.
 *  3. LAYDOWN    after the tumble settles the phone stays still for stillMs (4 s), and the rest
 *                gravity vector is >= tiltDeg (60 deg) away from the riding reference. The reference
 *                is learned (or calibrated) while riding, so any mount orientation works.
 *  4. GNSS       speed >= 20 km/h before the impact and <= 5 km/h at least gnssSettleMs after it.
 *                A bike still moving at speed after the "impact" means the phone fell off its mount;
 *                a phone that was already stationary was merely dropped.
 *
 * Without GNSS proof (no fix, a stopped bike that stops producing fixes, or no gyro) the pipeline
 * falls back to a longer stillness requirement and a longer countdown, at MEDIUM confidence.
 *
 * Confirmation only starts a countdown; nothing is sent until it expires un-cancelled.
 */
class CrashDetectorCore(
  private val config: CrashConfig = CrashConfig(),
  private val listener: CrashDetectorListener,
) {
  private val g = STANDARD_GRAVITY

  private val accel = SampleRing()
  private val gyro = SampleRing()
  private val gravity = SampleRing()
  private val fixes = ArrayList<Fix>()

  private var lastAccelT = Long.MIN_VALUE
  private var lastGyroT = Long.MIN_VALUE
  private var lastGravityT = Long.MIN_VALUE
  private var lastGyroMag = 0.0
  private var gyroAvailable = true

  // Riding gravity reference (unit vector in the phone frame).
  private var ref: Vec3? = null
  private var refQuietCount = 0
  private var lastRefT = 0L
  private var manualRef = false

  private var cand: Candidate? = null
  private var calibration: Calibration? = null

  private var state = CrashState()
  private var countdownStartedAt = 0L
  private var cooldownUntil = Long.MIN_VALUE

  private class Vec3(val x: Double, val y: Double, val z: Double) {
    fun normalized(): Vec3? {
      val n = sqrt(x * x + y * y + z * z)
      return if (n > 1e-6) Vec3(x / n, y / n, z / n) else null
    }

    fun angleDegTo(o: Vec3): Double {
      val dot = (x * o.x + y * o.y + z * o.z).coerceIn(-1.0, 1.0)
      return Math.toDegrees(acos(dot))
    }
  }

  private class Fix(val t: Long, val speed: Double?, val lat: Double?, val lon: Double?)

  private class Candidate(
    val t0: Long,
    var peak: Double, // m/s^2
    val ref: Vec3,
    val preSpeed: Double?,
    val freeFall: Boolean,
    var rotMax: Double,
    var stillStart: Long? = null,
  )

  private class Calibration(val endsAt: Long) {
    var sx = 0.0
    var sy = 0.0
    var sz = 0.0
    var nAccel = 0
    var sumM = 0.0
    var sumM2 = 0.0
    var gx = 0.0
    var gy = 0.0
    var gz = 0.0
    var nGravity = 0
    var sumGyro = 0.0
    var nGyro = 0
    var interrupted = false
  }

  private class RestWindow(val still: Boolean, val vector: Vec3?, val from: Long)

  // --- public API ---------------------------------------------------------------------------

  fun getState(): CrashState = state

  /** False for phones with no gyroscope: rotation evidence is skipped and confidence is capped. */
  fun setGyroAvailable(available: Boolean) {
    gyroAvailable = available
  }

  fun addAccel(t: Long, x: Double, y: Double, z: Double) {
    if (!finite(x, y, z) || t <= lastAccelT) return
    lastAccelT = t
    accel.add(t, x, y, z)
    val m = magnitude(x, y, z)
    calibrationAccel(t, x, y, z, m)

    if (state.phase != CrashPhase.IDLE || t < cooldownUntil) return
    val triggerG = if (config.enableLowSpeedLaydown) config.laydownImpactG else config.impactG
    val c = cand
    if (c == null) {
      if (m >= triggerG * g) {
        calibration?.let { it.interrupted = true }
        openCandidate(t, m)
      } else if (calibration == null) {
        // Automatic learning pauses during a manual calibration so the shift it reports is
        // measured against the reference that was in force when the rider asked.
        updateReference(t, x, y, z, m)
      }
      return
    }
    if (t - c.t0 <= PEAK_WINDOW_MS) {
      c.peak = max(c.peak, m)
    } else if (m >= config.impactG * g && c.peak < config.impactG * g) {
      // A full-size impact after a minor bump: restart the evidence chain from the big one.
      openCandidate(t, m)
    }
    evaluate(t)
  }

  fun addGyro(t: Long, x: Double, y: Double, z: Double) {
    if (!finite(x, y, z) || t <= lastGyroT) return
    lastGyroT = t
    val m = magnitude(x, y, z)
    lastGyroMag = m
    gyro.add(t, x, y, z)
    cand?.let { if (t <= it.t0 + 1000) it.rotMax = max(it.rotMax, m) }
    calibration?.let {
      it.sumGyro += m
      it.nGyro++
    }
  }

  /** Fused gravity vector (Sensor.TYPE_GRAVITY), m/s^2 in the phone frame. Optional. */
  fun addGravity(t: Long, x: Double, y: Double, z: Double) {
    if (!finite(x, y, z) || t <= lastGravityT) return
    lastGravityT = t
    gravity.add(t, x, y, z)
    calibration?.let {
      it.gx += x
      it.gy += y
      it.gz += z
      it.nGravity++
    }
  }

  /** [speedMps] null when the fix carries no speed. [lat]/[lon] are kept only for the alert. */
  fun addGnss(t: Long, speedMps: Double?, lat: Double? = null, lon: Double? = null) {
    val speed = speedMps?.takeIf { it.isFinite() && it >= 0.0 }
    val fix = Fix(t, speed, lat?.takeIf { it.isFinite() }, lon?.takeIf { it.isFinite() })
    fixes.add(fix)
    if (fixes.size > 1 && fixes[fixes.size - 2].t > t) fixes.sortBy { it.t }
    val newest = fixes[fixes.size - 1].t
    while (fixes.isNotEmpty() && fixes[0].t < newest - FIX_KEEP_MS) fixes.removeAt(0)

    if (state.phase == CrashPhase.COUNTDOWN &&
      speed != null &&
      speed >= config.resumeSpeedMps &&
      t > countdownStartedAt
    ) {
      state =
        state.copy(
          phase = CrashPhase.CANCELLED,
          cancelReason = "riding_resumed",
          countdownEndsAt = null,
          countdownMs = null,
        )
      cooldownUntil = t + config.cooldownMs
      listener.onStateChanged(state)
    }
  }

  /** Advances countdown / cooldown / candidate expiry / calibration. Call a few times a second. */
  fun tick(now: Long) {
    when {
      state.phase == CrashPhase.COUNTDOWN && now >= (state.countdownEndsAt ?: Long.MAX_VALUE) ->
        dispatchSos(now, "expired")
      state.phase == CrashPhase.CANCELLED && now >= cooldownUntil -> {
        state = CrashState()
        listener.onStateChanged(state)
      }
      state.phase == CrashPhase.IDLE -> {
        cand?.let { if (now - it.t0 > config.windowMs) reject(now, CrashRejectReason.EXPIRED) }
      }
    }
    calibration?.let { if (now >= it.endsAt + CALIBRATION_GRACE_MS) finishCalibration() }
  }

  /** Rider says they are fine. Returns true if a countdown was cancelled. */
  fun cancel(now: Long, reason: String = "user"): Boolean {
    if (state.phase == CrashPhase.COUNTDOWN) {
      state =
        state.copy(
          phase = CrashPhase.CANCELLED,
          cancelReason = reason,
          countdownEndsAt = null,
          countdownMs = null,
        )
      cooldownUntil = now + config.cooldownMs
      listener.onStateChanged(state)
      return true
    }
    cand = null
    return false
  }

  /** Skip the rest of a running countdown and alert now. Returns true if an alert was sent. */
  fun sendNow(now: Long): Boolean {
    if (state.phase != CrashPhase.COUNTDOWN) return false
    dispatchSos(now, "user_sent")
    return true
  }

  /** Rider acknowledges a sent alert; back to idle behind a cooldown. */
  fun acknowledge(now: Long): Boolean {
    if (state.phase != CrashPhase.SOS) return false
    state = CrashState()
    cooldownUntil = now + config.cooldownMs
    listener.onStateChanged(state)
    return true
  }

  /** Starts a countdown without sensor evidence (demo / dev menu). */
  fun simulate(now: Long) {
    if (state.phase == CrashPhase.COUNTDOWN || state.phase == CrashPhase.SOS) return
    startCountdown(
      now,
      CrashEvidence(
        path = CrashPath.MANUAL,
        confidence = CrashConfidence.MEDIUM,
        impactAt = now,
        peakG = 0.0,
        maxGyroRadS = null,
        tiltDeg = null,
        preSpeedMps = null,
        postSpeedMps = null,
        stillMs = 0,
        freeFallBeforeImpact = false,
      ),
    )
  }

  /**
   * Pins the riding reference to the phone's current attitude: averages the fused gravity vector
   * (or the accelerometer if there is no gravity sensor) over [durationMs]. The phone must be
   * steady (parked upright, or riding smoothly). The result arrives via
   * [CrashDetectorListener.onCalibration]. Until [clearCalibration], automatic learning is off.
   */
  fun startCalibration(now: Long, durationMs: Long = CALIBRATION_MS) {
    if (state.phase != CrashPhase.IDLE || cand != null || calibration != null) {
      listener.onCalibration(CalibrationResult(false, "busy"))
      return
    }
    calibration = Calibration(now + durationMs)
  }

  /** Back to automatic reference learning. */
  fun clearCalibration() {
    manualRef = false
    ref = null
    refQuietCount = 0
  }

  /** Forgets all history, calibration and state (e.g. when monitoring restarts). */
  fun reset() {
    accel.clear()
    gyro.clear()
    gravity.clear()
    fixes.clear()
    lastAccelT = Long.MIN_VALUE
    lastGyroT = Long.MIN_VALUE
    lastGravityT = Long.MIN_VALUE
    lastGyroMag = 0.0
    ref = null
    refQuietCount = 0
    manualRef = false
    cand = null
    calibration = null
    cooldownUntil = Long.MIN_VALUE
    countdownStartedAt = 0
    state = CrashState()
    listener.onStateChanged(state)
  }

  // --- internals ----------------------------------------------------------------------------

  private fun finite(x: Double, y: Double, z: Double) = x.isFinite() && y.isFinite() && z.isFinite()

  private fun magnitude(x: Double, y: Double, z: Double) = sqrt(x * x + y * y + z * z)

  private fun updateReference(t: Long, x: Double, y: Double, z: Double, m: Double) {
    if (manualRef || abs(m - g) > QUIET_BAND_G * g || lastGyroMag > QUIET_GYRO_RAD_S) return
    val unit = Vec3(x, y, z).normalized() ?: return
    val cur = ref
    ref =
      if (cur == null) {
        unit
      } else {
        val dt = ((t - lastRefT) / 1000.0).coerceIn(0.0, 1.0)
        val alpha = dt / (REF_TAU_S + dt)
        Vec3(
            cur.x * (1 - alpha) + unit.x * alpha,
            cur.y * (1 - alpha) + unit.y * alpha,
            cur.z * (1 - alpha) + unit.z * alpha,
          )
          .normalized() ?: cur
      }
    lastRefT = t
    refQuietCount++
  }

  private fun preImpactSpeed(t0: Long): Double? {
    var best: Double? = null
    for (f in fixes) {
      val s = f.speed ?: continue
      if (f.t > t0 || f.t < t0 - config.gnssMaxAgeMs) continue
      best = best?.let { max(it, s) } ?: s
    }
    return best
  }

  private fun hadFreeFall(t0: Long): Boolean {
    var runStart: Long? = null
    for (i in accel.firstIndexAtOrAfter(t0 - 500) until accel.size) {
      val t = accel.timeAt(i)
      if (t >= t0) break
      if (accel.magnitudeAt(i) < config.freeFallG * g) {
        val start = runStart ?: t.also { runStart = it }
        if (t - start >= config.freeFallMs) return true
      } else {
        runStart = null
      }
    }
    return false
  }

  private fun openCandidate(t: Long, m: Double) {
    val r = ref
    if (r == null || (!manualRef && refQuietCount < REF_MIN_QUIET_SAMPLES)) return
    var rotMax = 0.0
    for (i in gyro.firstIndexAtOrAfter(t - 1000) until gyro.size) {
      rotMax = max(rotMax, gyro.magnitudeAt(i))
    }
    cand = Candidate(t, m, r, preImpactSpeed(t), hadFreeFall(t), rotMax)
  }

  private fun reject(at: Long, reason: CrashRejectReason) {
    cand?.let { listener.onDecision(CrashDecision.Rejected(at, reason, it.peak / g)) }
    cand = null
  }

  /** Latest fix at least gnssSettleMs after the impact that carries a speed. */
  private fun postImpactFix(c: Candidate): Fix? {
    var found: Fix? = null
    for (f in fixes) {
      if (f.t >= c.t0 + config.gnssSettleMs && f.speed != null) found = f
    }
    return found
  }

  /**
   * Looks at the last second of samples. `vector` is the rest gravity direction: the mean of the
   * fused gravity sensor if it has been reporting, otherwise of the accelerometer.
   */
  private fun restWindow(now: Long): RestWindow? {
    val from = now - STILL_WINDOW_MS
    val a0 = accel.firstIndexAtOrAfter(from + 1)
    val n = accel.size - a0
    if (n < MIN_STILL_SAMPLES) return null

    var sx = 0.0
    var sy = 0.0
    var sz = 0.0
    var sm = 0.0
    for (i in a0 until accel.size) {
      sx += accel.xAt(i)
      sy += accel.yAt(i)
      sz += accel.zAt(i)
      sm += accel.magnitudeAt(i)
    }
    val meanM = sm / n
    var varM = 0.0
    for (i in a0 until accel.size) {
      val d = accel.magnitudeAt(i) - meanM
      varM += d * d
    }
    val stdM = sqrt(varM / n)

    var gyroMean = 0.0
    if (gyroAvailable) {
      val g0 = gyro.firstIndexAtOrAfter(from + 1)
      val gn = gyro.size - g0
      if (gn == 0) return null
      var s = 0.0
      for (i in g0 until gyro.size) s += gyro.magnitudeAt(i)
      gyroMean = s / gn
    }

    val gv0 = gravity.firstIndexAtOrAfter(from + 1)
    val gvn = gravity.size - gv0
    val vector =
      if (gvn >= MIN_GRAVITY_SAMPLES) {
        var gx = 0.0
        var gy = 0.0
        var gz = 0.0
        for (i in gv0 until gravity.size) {
          gx += gravity.xAt(i)
          gy += gravity.yAt(i)
          gz += gravity.zAt(i)
        }
        Vec3(gx / gvn, gy / gvn, gz / gvn).normalized()
      } else {
        Vec3(sx / n, sy / n, sz / n).normalized()
      }

    val still =
      vector != null &&
        stdM < config.stillAccelStd &&
        abs(meanM - g) < QUIET_BAND_G * g &&
        gyroMean < config.stillGyroRadS
    return RestWindow(still, vector, from)
  }

  private fun evaluate(now: Long) {
    val c = cand ?: return
    val age = now - c.t0
    if (age > config.windowMs) {
      reject(now, CrashRejectReason.EXPIRED)
      return
    }
    // Need the +-1 s rotation window closed and a whole still-window after the settle delay.
    if (age < SETTLE_MS + STILL_WINDOW_MS) return

    if (gyroAvailable && c.rotMax < config.laydownRotationRadS) {
      reject(now, CrashRejectReason.NO_ROTATION)
      return
    }

    val post = postImpactFix(c)
    val postSpeed = post?.speed
    if (postSpeed != null && postSpeed > config.stillMovingMps) {
      // The bike is still moving seconds after the "impact": the phone left its mount.
      reject(now, CrashRejectReason.STILL_MOVING)
      return
    }
    val pre = c.preSpeed
    if (pre != null && pre < config.stationaryMps) {
      reject(now, CrashRejectReason.WAS_STATIONARY)
      return
    }

    val win = restWindow(now)
    if (win == null || !win.still || win.vector == null) {
      c.stillStart = null
      return
    }
    val stillStart = c.stillStart ?: win.from.also { c.stillStart = it }
    val stillFor = now - stillStart

    val highImpact = c.peak >= config.impactG * g
    val postStopped = postSpeed != null && postSpeed <= config.stoppedMps

    val path: CrashPath
    var needRot: Double
    var needStill: Long
    var conf: CrashConfidence
    if (highImpact && pre != null && pre >= config.minPreSpeedMps) {
      // GNSS confirms when it saw the stop; otherwise fall back to the no-GNSS requirements.
      needRot = config.rotationRadS
      if (postStopped && gyroAvailable) {
        path = CrashPath.CRASH
        needStill = config.stillMs
        conf = CrashConfidence.HIGH
      } else {
        path = CrashPath.CRASH_NO_GNSS
        needStill = config.stillMsNoGnss
        conf = CrashConfidence.MEDIUM
      }
    } else if (pre != null) {
      // Known to have been moving, but slower than a crash, or below the full impact threshold.
      if (!config.enableLowSpeedLaydown) {
        reject(now, CrashRejectReason.LOW_SPEED_DISABLED)
        return
      }
      path = CrashPath.LAYDOWN
      needRot = config.laydownRotationRadS
      needStill = config.stillMsLaydown
      conf = CrashConfidence.MEDIUM
    } else if (highImpact) {
      path = CrashPath.CRASH_NO_GNSS
      needRot = config.rotationRadS
      needStill = config.stillMsNoGnss
      conf = CrashConfidence.MEDIUM
    } else {
      // A moderate bump with no speed information at all: nothing to anchor a laydown to.
      return
    }
    if (!gyroAvailable) {
      needStill = max(needStill, config.stillMsNoGnss)
      conf = CrashConfidence.MEDIUM
    }
    // The rotation window closed at +1 s, so a shortfall is final.
    if (gyroAvailable && c.rotMax < needRot) {
      reject(now, CrashRejectReason.NO_ROTATION)
      return
    }
    if (stillFor < needStill) return

    // A falling phone with no GNSS proof that the bike stopped is more likely a dropped phone.
    if (c.freeFall && !postStopped) {
      reject(now, CrashRejectReason.MOUNT_DROP_SUSPECTED)
      return
    }

    val tilt = c.ref.angleDegTo(win.vector)
    if (tilt < config.tiltDeg) {
      // Still, but the phone is back at its riding attitude: the bike is upright.
      reject(now, CrashRejectReason.UPRIGHT)
      return
    }

    startCountdown(
      now,
      CrashEvidence(
        path = path,
        confidence = conf,
        impactAt = c.t0,
        peakG = c.peak / g,
        maxGyroRadS = if (gyroAvailable) c.rotMax else null,
        tiltDeg = tilt,
        preSpeedMps = c.preSpeed,
        postSpeedMps = postSpeed,
        stillMs = stillFor,
        freeFallBeforeImpact = c.freeFall,
      ),
    )
  }

  private fun startCountdown(now: Long, evidence: CrashEvidence) {
    cand = null
    val ms =
      if (evidence.confidence == CrashConfidence.HIGH) config.countdownMsHigh
      else config.countdownMsMedium
    countdownStartedAt = now
    state =
      CrashState(
        phase = CrashPhase.COUNTDOWN,
        confidence = evidence.confidence,
        severity = severityOf(evidence),
        countdownMs = ms,
        countdownEndsAt = now + ms,
        evidence = evidence,
      )
    listener.onDecision(CrashDecision.Confirmed(now, evidence))
    listener.onStateChanged(state)
  }

  private fun dispatchSos(now: Long, trigger: String) {
    val evidence = state.evidence ?: return
    val position = fixes.lastOrNull { it.lat != null && it.lon != null }
    state =
      state.copy(phase = CrashPhase.SOS, countdownEndsAt = null, countdownMs = null)
    listener.onStateChanged(state)
    listener.onCountdownExpired(
      SosPayload(
        sosId = UUID.randomUUID().toString(),
        timestamp = now,
        impactTimestamp = evidence.impactAt,
        latitude = position?.lat,
        longitude = position?.lon,
        locationAgeMs = position?.let { max(0L, now - it.t) },
        speedBeforeImpactMps = evidence.preSpeedMps,
        severity = severityOf(evidence),
        confidence = evidence.confidence,
        path = evidence.path,
        peakG = evidence.peakG,
        trigger = trigger,
      ),
    )
  }

  // --- calibration --------------------------------------------------------------------------

  private fun calibrationAccel(t: Long, x: Double, y: Double, z: Double, m: Double) {
    val cal = calibration ?: return
    cal.sx += x
    cal.sy += y
    cal.sz += z
    cal.sumM += m
    cal.sumM2 += m * m
    cal.nAccel++
    if (t >= cal.endsAt) finishCalibration()
  }

  private fun finishCalibration() {
    val cal = calibration ?: return
    calibration = null
    if (cal.interrupted) {
      listener.onCalibration(CalibrationResult(false, "interrupted"))
      return
    }
    if (cal.nAccel < MIN_STILL_SAMPLES) {
      listener.onCalibration(CalibrationResult(false, "no_data"))
      return
    }
    val n = cal.nAccel
    val meanM = cal.sumM / n
    val stdM = sqrt(max(0.0, cal.sumM2 / n - meanM * meanM))
    val gyroMean = if (gyroAvailable && cal.nGyro > 0) cal.sumGyro / cal.nGyro else 0.0
    val steady =
      stdM < config.stillAccelStd &&
        abs(meanM - g) < QUIET_BAND_G * g &&
        gyroMean < config.stillGyroRadS
    if (!steady) {
      listener.onCalibration(CalibrationResult(false, "not_steady"))
      return
    }
    val vector =
      if (cal.nGravity >= MIN_GRAVITY_SAMPLES) {
        Vec3(cal.gx / cal.nGravity, cal.gy / cal.nGravity, cal.gz / cal.nGravity)
      } else {
        Vec3(cal.sx / n, cal.sy / n, cal.sz / n)
      }.normalized()
    if (vector == null) {
      listener.onCalibration(CalibrationResult(false, "no_data"))
      return
    }
    val previous = ref
    ref = vector
    manualRef = true
    refQuietCount = REF_MIN_QUIET_SAMPLES
    listener.onCalibration(CalibrationResult(true, null, previous?.angleDegTo(vector)))
  }

  private companion object {
    /** Impact peak is tracked for this long after the first over-threshold sample. */
    const val PEAK_WINDOW_MS = 2_000L
    /** The still-window must start at least this long after the impact (tumbling has stopped). */
    const val SETTLE_MS = 1_000L
    const val STILL_WINDOW_MS = 1_000L
    const val MIN_STILL_SAMPLES = 20
    const val MIN_GRAVITY_SAMPLES = 10
    const val REF_TAU_S = 2.0
    const val REF_MIN_QUIET_SAMPLES = 50
    /** Samples count as "quiet riding" (used to learn the reference) inside this band, in g. */
    const val QUIET_BAND_G = 0.15
    const val QUIET_GYRO_RAD_S = 1.0
    const val FIX_KEEP_MS = 60_000L
    const val CALIBRATION_MS = 2_000L
    /** If no accelerometer sample arrives to finish a calibration, tick() gives up after this. */
    const val CALIBRATION_GRACE_MS = 1_000L
  }
}
