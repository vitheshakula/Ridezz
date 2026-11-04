package com.rideaze.mobile.crash

import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CrashDetectorCoreTest {
  private val t0 = 1_800_000_000_000L
  private val g = STANDARD_GRAVITY

  private val upright = doubleArrayOf(0.0, 0.0, g)
  private val sideways = doubleArrayOf(g, 0.0, 0.0)

  private fun noise(t: Long, salt: Int): Double {
    val x = sin(((t - t0) / 10.0) * 127.1 + salt * 311.7) * 43758.5453
    return (x - floor(x)) * 2 - 1
  }

  private fun ridingAccel(t: Long) =
    doubleArrayOf(0.3 * noise(t, 1), 0.3 * noise(t, 2), g + 0.4 * noise(t, 3))

  private fun stillAccel(t: Long, v: DoubleArray) =
    doubleArrayOf(
      v[0] + 0.03 * noise(t, 4),
      v[1] + 0.03 * noise(t, 5),
      v[2] + 0.03 * noise(t, 6),
    )

  private fun quietGyro(t: Long) =
    doubleArrayOf(0.04 * noise(t, 7), 0.04 * noise(t, 8), 0.04 * noise(t, 9))

  private class Profile(
    val accel: (Long) -> DoubleArray,
    val gyro: (Long) -> DoubleArray,
    val gravity: (Long) -> DoubleArray,
    val speed: (Long) -> Double?,
  )

  private fun crashProfile(
    impactAt: Long = t0 + 10_000,
    peakG: Double = 6.5,
    impactMs: Long = 30,
    rotRadS: Double = 8.0,
    speedBefore: Double? = 20.0,
    stopAfterS: Double = 4.0,
    keepMoving: Boolean = false,
    noFixAfterImpact: Boolean = false,
    freeFallMs: Long = 0,
    finalGravity: DoubleArray = sideways,
  ) =
    Profile(
      accel = { t ->
        when {
          t < impactAt - freeFallMs -> ridingAccel(t)
          t < impactAt -> doubleArrayOf(0.3, 0.3, 0.3)
          t < impactAt + impactMs -> doubleArrayOf(0.0, 0.0, peakG * g)
          t < impactAt + 1200 -> {
            val w = (t - impactAt) / 60.0
            doubleArrayOf(0.9 * g * sin(w), 0.9 * g * cos(w), 0.3 * g)
          }
          else -> stillAccel(t, finalGravity)
        }
      },
      gyro = { t ->
        if (t >= impactAt - 200 && t < impactAt + 1000) {
          doubleArrayOf(rotRadS, 0.3 * noise(t, 10), 0.0)
        } else {
          quietGyro(t)
        }
      },
      gravity = { t -> if (t < impactAt + 1200) upright else finalGravity },
      speed = speed@{ t ->
        if (speedBefore == null) return@speed null
        if (t < impactAt) return@speed speedBefore
        if (noFixAfterImpact) return@speed null
        if (keepMoving) return@speed speedBefore
        speedBefore * max(0.0, 1 - (t - impactAt) / 1000.0 / stopAfterS)
      },
    )

  private class Recorder : CrashDetectorListener {
    val states = mutableListOf<CrashState>()
    val sos = mutableListOf<SosPayload>()
    val decisions = mutableListOf<CrashDecision>()
    val calibrations = mutableListOf<CalibrationResult>()

    override fun onStateChanged(state: CrashState) {
      states += state
    }

    override fun onCountdownExpired(sos: SosPayload) {
      this.sos += sos
    }

    override fun onDecision(decision: CrashDecision) {
      decisions += decision
    }

    override fun onCalibration(result: CalibrationResult) {
      calibrations += result
    }

    val rejected: List<CrashRejectReason>
      get() = decisions.filterIsInstance<CrashDecision.Rejected>().map { it.reason }

    val confirmed: List<CrashEvidence>
      get() = decisions.filterIsInstance<CrashDecision.Confirmed>().map { it.evidence }
  }

  private fun detector(
    config: CrashConfig = CrashConfig(),
    setup: (CrashDetectorCore) -> Unit = {},
  ): Pair<CrashDetectorCore, Recorder> {
    val rec = Recorder()
    val core = CrashDetectorCore(config, rec)
    setup(core)
    return core to rec
  }

  private fun run(
    core: CrashDetectorCore,
    profile: Profile,
    from: Long,
    to: Long,
    gyro: Boolean = true,
    gravity: Boolean = false,
    hook: (Long) -> Unit = {},
  ) {
    var t = from
    while (t < to) {
      hook(t)
      val a = profile.accel(t)
      core.addAccel(t, a[0], a[1], a[2])
      if (gyro) {
        val w = profile.gyro(t)
        core.addGyro(t, w[0], w[1], w[2])
      }
      if (gravity) {
        val v = profile.gravity(t)
        core.addGravity(t, v[0], v[1], v[2])
      }
      if ((t - t0) % 1000 == 0L) {
        profile.speed(t)?.let { core.addGnss(t, it, 10.0, 20.0) }
      }
      if ((t - t0) % 100 == 0L) core.tick(t)
      t += 10
    }
  }

  @Test
  fun staysSilentWhileRidingNormally() {
    val (core, rec) = detector()
    run(core, Profile(::ridingAccel, ::quietGyro, { upright }, { 20.0 }), t0, t0 + 30_000)
    assertTrue(rec.states.isEmpty())
    assertTrue(rec.sos.isEmpty())
    assertEquals(CrashPhase.IDLE, core.getState().phase)
  }

  @Test
  fun ignoresSharpBumpWithNoRotation() {
    val (core, rec) = detector()
    run(
      core,
      crashProfile(peakG = 4.0, impactMs = 20, rotRadS = 0.3, finalGravity = upright),
      t0,
      t0 + 30_000,
    )
    assertTrue(rec.states.isEmpty())
    assertTrue(rec.sos.isEmpty())
    assertEquals(listOf(CrashRejectReason.NO_ROTATION), rec.rejected)
  }

  @Test
  fun ignoresPotholeHitAtSpeed() {
    val (core, rec) = detector()
    run(
      core,
      crashProfile(
        peakG = 2.2,
        impactMs = 60,
        rotRadS = 0.5,
        speedBefore = 15.0,
        keepMoving = true,
        finalGravity = upright,
      ),
      t0,
      t0 + 30_000,
    )
    assertTrue(rec.sos.isEmpty())
    assertEquals(listOf(CrashRejectReason.NO_ROTATION), rec.rejected)
  }

  @Test
  fun detectsHighSpeedCrashThenSendsSosAfterCountdown() {
    val (core, rec) = detector()
    run(core, crashProfile(), t0, t0 + 70_000)

    val ev = rec.confirmed.single()
    assertEquals(CrashPath.CRASH, ev.path)
    assertEquals(CrashConfidence.HIGH, ev.confidence)
    assertTrue(ev.peakG > 6.0)
    assertEquals(20.0, ev.preSpeedMps!!, 1e-9)
    assertTrue(ev.postSpeedMps!! <= 5.0 / 3.6)
    assertTrue(ev.tiltDeg!! > 80)
    assertTrue(ev.maxGyroRadS!! > 5.0)

    val countdown = rec.states.first { it.phase == CrashPhase.COUNTDOWN }
    assertEquals(CrashConfidence.HIGH, countdown.confidence)
    assertEquals("SEVERE", countdown.severity)
    assertEquals(40_000L, countdown.countdownMs)
    val started = countdown.countdownEndsAt!! - 40_000
    assertTrue(started - (t0 + 10_000) in 4_500..8_000)

    val sos = rec.sos.single()
    assertEquals("expired", sos.trigger)
    assertEquals("SEVERE", sos.severity)
    assertEquals(20.0, sos.speedBeforeImpactMps!!, 1e-9)
    assertEquals(10.0, sos.latitude!!, 1e-9)
    assertEquals(20.0, sos.longitude!!, 1e-9)
    assertNotNull(sos.locationAgeMs)
    assertEquals(CrashPhase.SOS, core.getState().phase)
  }

  @Test
  fun lessViolentCrashIsHighNotSevere() {
    val (core, rec) = detector()
    run(core, crashProfile(peakG = 4.5), t0, t0 + 70_000)
    assertEquals("HIGH", rec.sos.single().severity)
  }

  @Test
  fun noSosWhenRiderCancelsDuringCountdown() {
    val (core, rec) = detector()
    var cancelled = false
    run(core, crashProfile(), t0, t0 + 85_000) { t ->
      if (!cancelled && core.getState().phase == CrashPhase.COUNTDOWN) {
        cancelled = true
        assertTrue(core.cancel(t))
      }
    }
    assertTrue(cancelled)
    assertTrue(rec.sos.isEmpty())
    assertTrue(rec.states.any { it.phase == CrashPhase.CANCELLED && it.cancelReason == "user" })
    assertEquals(CrashPhase.IDLE, core.getState().phase)
  }

  @Test
  fun fallsBackToLongerMediumConfidencePathWithoutGnss() {
    val (core, rec) = detector()
    run(core, crashProfile(speedBefore = null), t0, t0 + 100_000)
    val ev = rec.confirmed.single()
    assertEquals(CrashPath.CRASH_NO_GNSS, ev.path)
    assertEquals(CrashConfidence.MEDIUM, ev.confidence)
    assertNull(ev.preSpeedMps)
    val countdown = rec.states.first { it.phase == CrashPhase.COUNTDOWN }
    assertEquals(40_000L, countdown.countdownMs)
    assertTrue(countdown.countdownEndsAt!! - t0 > 10_000 + 10_000 + 40_000)
    val sos = rec.sos.single()
    assertEquals("MODERATE", sos.severity)
    assertNull(sos.speedBeforeImpactMps)
  }

  @Test
  fun usesSameFallbackWhenStoppedBikeStopsProducingFixes() {
    val (core, rec) = detector()
    run(core, crashProfile(noFixAfterImpact = true), t0, t0 + 30_000)
    val ev = rec.confirmed.single()
    assertEquals(CrashPath.CRASH_NO_GNSS, ev.path)
    assertEquals(CrashConfidence.MEDIUM, ev.confidence)
  }

  @Test
  fun rejectsPhoneThatFellOffMountWhileBikeKeptMoving() {
    val (core, rec) = detector()
    run(core, crashProfile(freeFallMs = 150, keepMoving = true), t0, t0 + 40_000)
    assertTrue(rec.states.isEmpty())
    assertTrue(rec.sos.isEmpty())
    assertEquals(listOf(CrashRejectReason.STILL_MOVING), rec.rejected)
  }

  @Test
  fun rejectsPhoneDroppedWhileParked() {
    val (core, rec) = detector()
    run(core, crashProfile(speedBefore = 0.0), t0, t0 + 40_000)
    assertTrue(rec.sos.isEmpty())
    assertEquals(listOf(CrashRejectReason.WAS_STATIONARY), rec.rejected)
  }

  @Test
  fun refusesFreeFallingPhoneWithNoGnssProofTheBikeStopped() {
    val (core, rec) = detector()
    run(core, crashProfile(freeFallMs = 150, speedBefore = null), t0, t0 + 40_000)
    assertTrue(rec.sos.isEmpty())
    assertEquals(listOf(CrashRejectReason.MOUNT_DROP_SUSPECTED), rec.rejected)
  }

  @Test
  fun rejectsImpactWherePhoneEndsAtRidingAttitude() {
    val (core, rec) = detector()
    run(core, crashProfile(finalGravity = upright), t0, t0 + 40_000)
    assertTrue(rec.sos.isEmpty())
    assertEquals(listOf(CrashRejectReason.UPRIGHT), rec.rejected)
  }

  @Test
  fun catchesLowSpeedLaydownBelowFullCrashImpact() {
    val (core, rec) = detector()
    run(
      core,
      crashProfile(
        peakG = 2.2,
        impactMs = 40,
        rotRadS = 2.5,
        speedBefore = 3.0,
        stopAfterS = 1.5,
      ),
      t0,
      t0 + 40_000,
    )
    val ev = rec.confirmed.single()
    assertEquals(CrashPath.LAYDOWN, ev.path)
    assertEquals(CrashConfidence.MEDIUM, ev.confidence)
    assertTrue(ev.stillMs >= 8_000)
  }

  @Test
  fun lowSpeedLaydownCanBeSwitchedOff() {
    val (core, rec) = detector(CrashConfig(enableLowSpeedLaydown = false))
    run(
      core,
      crashProfile(peakG = 2.2, impactMs = 40, rotRadS = 2.5, speedBefore = 3.0, stopAfterS = 1.5),
      t0,
      t0 + 40_000,
    )
    assertTrue(rec.confirmed.isEmpty())
  }

  @Test
  fun capsConfidenceAtMediumOnPhonesWithoutGyroscope() {
    val (core, rec) = detector { it.setGyroAvailable(false) }
    run(core, crashProfile(), t0, t0 + 40_000, gyro = false)
    val ev = rec.confirmed.single()
    assertEquals(CrashConfidence.MEDIUM, ev.confidence)
    assertNull(ev.maxGyroRadS)
    assertTrue(ev.stillMs >= 10_000)
  }

  @Test
  fun cancelsCountdownWhenGnssShowsRiderRidingOn() {
    val (core, rec) = detector()
    val base = crashProfile()
    val impactAt = t0 + 10_000
    val resumed =
      Profile(base.accel, base.gyro, base.gravity) { t ->
        if (t >= impactAt + 9_000) 12.0 else base.speed(t)
      }
    run(core, resumed, t0, t0 + 30_000)
    assertTrue(rec.sos.isEmpty())
    assertTrue(
      rec.states.any { it.phase == CrashPhase.CANCELLED && it.cancelReason == "riding_resumed" },
    )
  }

  @Test
  fun sendNowSkipsCountdownAndAcknowledgeReturnsToIdle() {
    val (core, rec) = detector()
    var sent = false
    run(core, crashProfile(), t0, t0 + 30_000) { t ->
      if (!sent && core.getState().phase == CrashPhase.COUNTDOWN) {
        sent = true
        assertTrue(core.sendNow(t))
      }
    }
    assertEquals(1, rec.sos.size)
    assertEquals("user_sent", rec.sos[0].trigger)
    assertEquals(CrashPhase.SOS, core.getState().phase)
    assertTrue(core.acknowledge(t0 + 31_000))
    assertEquals(CrashPhase.IDLE, core.getState().phase)
    assertFalse(core.acknowledge(t0 + 32_000))
  }

  @Test
  fun simulateStartsMediumConfidenceManualCountdown() {
    val (core, rec) = detector()
    core.simulate(t0)
    assertEquals(CrashPhase.COUNTDOWN, core.getState().phase)
    assertEquals(CrashPath.MANUAL, rec.states[0].evidence?.path)
    assertEquals("UNKNOWN", rec.states[0].severity)
    core.tick(t0 + 39_000)
    assertTrue(rec.sos.isEmpty())
    core.tick(t0 + 40_000)
    assertEquals(1, rec.sos.size)
  }

  @Test
  fun eachAlertGetsItsOwnId() {
    val (core, rec) = detector()
    core.simulate(t0)
    core.tick(t0 + 40_000)
    core.acknowledge(t0 + 41_000)
    core.simulate(t0 + 100_000)
    core.tick(t0 + 140_000)
    assertEquals(2, rec.sos.map { it.sosId }.toSet().size)
  }

  @Test
  fun ignoresMalformedSamples() {
    val (core, rec) = detector()
    core.addAccel(t0, Double.NaN, 0.0, g)
    core.addAccel(t0, 0.0, Double.POSITIVE_INFINITY, g)
    core.addGyro(t0, Double.POSITIVE_INFINITY, 0.0, 0.0)
    core.addGravity(t0, Double.NaN, 0.0, 0.0)
    core.addGnss(t0, Double.NaN)
    core.addGnss(t0, -3.0)
    core.tick(t0 + 1000)
    assertTrue(rec.states.isEmpty())
  }

  @Test
  fun usesFusedGravitySensorForRestTilt() {
    val (core, rec) = detector()
    run(core, crashProfile(), t0, t0 + 30_000, gravity = true)
    val ev = rec.confirmed.single()
    assertEquals(90.0, ev.tiltDeg!!, 3.0)
  }

  @Test
  fun gravitySensorWinsWhenAccelerometerMeanDisagrees() {
    val (core, rec) = detector()
    val base = crashProfile()
    val disagree = Profile(base.accel, base.gyro, { upright }, base.speed)
    run(core, disagree, t0, t0 + 30_000, gravity = true)
    assertEquals(listOf(CrashRejectReason.UPRIGHT), rec.rejected)
  }

  @Test
  fun calibrationPinsReferenceAndReportsTheShift() {
    val (core, rec) = detector()
    val tilted30 = doubleArrayOf(g * sin(Math.toRadians(30.0)), 0.0, g * cos(Math.toRadians(30.0)))
    run(core, Profile(::ridingAccel, ::quietGyro, { upright }, { 20.0 }), t0, t0 + 3_000)
    core.startCalibration(t0 + 3_000)
    run(
      core,
      Profile({ t -> stillAccel(t, tilted30) }, ::quietGyro, { tilted30 }, { null }),
      t0 + 3_000,
      t0 + 6_500,
      gravity = true,
    )
    val result = rec.calibrations.single()
    assertTrue(result.success)
    assertEquals(30.0, result.deltaDeg!!, 2.0)
  }

  @Test
  fun calibrationFailsWhenPhoneIsNotSteady() {
    val (core, rec) = detector()
    run(core, Profile(::ridingAccel, ::quietGyro, { upright }, { 20.0 }), t0, t0 + 3_000)
    core.startCalibration(t0 + 3_000)
    val shaking = Profile(
      { t -> doubleArrayOf(6 * noise(t, 11), 6 * noise(t, 12), g + 6 * noise(t, 13)) },
      ::quietGyro,
      { upright },
      { null },
    )
    run(core, shaking, t0 + 3_000, t0 + 6_500)
    val result = rec.calibrations.single()
    assertFalse(result.success)
    assertEquals("not_steady", result.reason)
  }

  @Test
  fun calibrationIsRefusedWhileACountdownRuns() {
    val (core, rec) = detector()
    core.simulate(t0)
    core.startCalibration(t0 + 1_000)
    assertEquals("busy", rec.calibrations.single().reason)
  }

  @Test
  fun resetForgetsEverything() {
    val (core, rec) = detector()
    core.simulate(t0)
    core.reset()
    assertEquals(CrashPhase.IDLE, core.getState().phase)
    assertEquals(CrashPhase.IDLE, rec.states.last().phase)
  }

  @Test
  fun sampleRingOverwritesOldestAndFindsWindowStart() {
    val ring = SampleRing(8)
    for (i in 0 until 12) ring.add(1000L + i * 10, i.toDouble(), 0.0, 0.0)
    assertEquals(8, ring.size)
    assertEquals(1040L, ring.timeAt(0))
    assertEquals(4.0, ring.xAt(0), 0.0)
    assertEquals(1110L, ring.timeAt(7))
    assertEquals(0, ring.firstIndexAtOrAfter(0))
    assertEquals(3, ring.firstIndexAtOrAfter(1070))
    assertEquals(ring.size, ring.firstIndexAtOrAfter(5000))
    ring.clear()
    assertEquals(0, ring.size)
  }

  @Test
  fun ringHoldsAtLeastThreeSecondsAt200Hz() {
    val ring = SampleRing()
    for (i in 0 until 700) ring.add(i * 5L, 0.0, 0.0, 0.0)
    val span = ring.timeAt(ring.size - 1) - ring.timeAt(0)
    assertTrue(span >= 3_000)
  }

  @Test
  fun severityLabels() {
    fun ev(path: CrashPath, conf: CrashConfidence, peak: Double) =
      CrashEvidence(path, conf, 0, peak, null, null, null, null, 0, false)
    assertEquals("SEVERE", severityOf(ev(CrashPath.CRASH, CrashConfidence.HIGH, 6.0)))
    assertEquals("HIGH", severityOf(ev(CrashPath.CRASH, CrashConfidence.HIGH, 5.9)))
    assertEquals("MODERATE", severityOf(ev(CrashPath.LAYDOWN, CrashConfidence.MEDIUM, 9.0)))
    assertEquals("UNKNOWN", severityOf(ev(CrashPath.MANUAL, CrashConfidence.MEDIUM, 0.0)))
  }
}
