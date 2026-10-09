package com.rideaze.mobile.crash

import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Replays synthetic 100 Hz IMU traces plus 1 Hz GNSS fixes. World frame: +Y is the direction of
 * travel, +X is right, +Z is up. A phone orientation is a rotation from world to phone axes, so the
 * same ride can be replayed with the phone mounted any way round. These prove the decision logic
 * only; the thresholds are not tuned on real rides.
 */
class HardBrakingDetectorTest {

  private val g = STANDARD_GRAVITY

  private class Recorder : HardBrakingListener {
    val events = mutableListOf<BrakingEvent>()
    val decisions = mutableListOf<BrakingDecision>()

    override fun onHardBraking(event: BrakingEvent) {
      events += event
    }

    override fun onBrakingDecision(decision: BrakingDecision) {
      decisions += decision
    }

    fun rejected(reason: BrakingRejectReason) =
      decisions.filterIsInstance<BrakingDecision.Rejected>().any { it.reason == reason }
  }

  // --- orientations (world -> phone) -------------------------------------------------------

  private fun rotX(a: Double) =
    arrayOf(doubleArrayOf(1.0, 0.0, 0.0), doubleArrayOf(0.0, cos(a), -sin(a)), doubleArrayOf(0.0, sin(a), cos(a)))

  private fun rotZ(a: Double) =
    arrayOf(doubleArrayOf(cos(a), -sin(a), 0.0), doubleArrayOf(sin(a), cos(a), 0.0), doubleArrayOf(0.0, 0.0, 1.0))

  private fun mul(a: Array<DoubleArray>, b: Array<DoubleArray>) =
    Array(3) { i -> DoubleArray(3) { j -> (0..2).sumOf { k -> a[i][k] * b[k][j] } } }

  private val deg = Math.PI / 180.0

  private val flat = rotX(0.0) // phone lying flat, its +Y pointing forward
  private val landscape = rotZ(90 * deg) // phone turned sideways in the mount
  private val uprightMount = rotX(90 * deg) // phone standing up facing the rider
  private val tiltedMount = mul(rotX(35 * deg), rotZ(-20 * deg)) // dash-style tilt plus yaw
  private val upsideDown = mul(rotZ(180 * deg), rotX(20 * deg))
  private val orientations =
    mapOf(
      "flat" to flat,
      "landscape" to landscape,
      "upright" to uprightMount,
      "tilted" to tiltedMount,
      "upside-down" to upsideDown,
    )

  private fun apply(r: Array<DoubleArray>, v: DoubleArray) =
    DoubleArray(3) { i -> r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2] }

  private fun noise(t: Long, salt: Int): Double {
    val x = sin((t / 10.0) * 127.1 + salt * 311.7) * 43758.5453
    return (x - floor(x)) * 2 - 1
  }

  /** Feeds a simulated ride into a detector. */
  private inner class Ride(
    private val detector: HardBrakingDetector,
    private val orientation: Array<DoubleArray>,
    private val withGravitySensor: Boolean = true,
    startSpeed: Double = 6.0,
    private val bearing: Double? = 90.0,
  ) {
    var t = 1_800_000_000_000L
    var v = startSpeed
    private var sinceFix = 0L

    /** Advances [ms] with forward accel [fwd], lateral accel [lat] and extra vertical accel [vert] (all m/s^2). */
    fun run(
      ms: Long,
      fwd: Double = 0.0,
      lat: Double = 0.0,
      vert: Double = 0.0,
    ) {
      var done = 0L
      while (done < ms) {
        step(fwd, lat, vert)
        done += 10
      }
    }

    private fun step(fwd: Double, lat: Double, vert: Double) {
      t += 10
      v = (v + fwd * 0.01).coerceAtLeast(0.0)
      val a = doubleArrayOf(lat + 0.12 * noise(t, 1), fwd + 0.12 * noise(t, 2), g + vert + 0.15 * noise(t, 3))
      val grav = apply(orientation, doubleArrayOf(0.0, 0.0, g))
      if (withGravitySensor) detector.addGravity(t, grav[0], grav[1], grav[2])
      val s = apply(orientation, a)
      detector.addAccel(t, s[0], s[1], s[2])
      detector.tick(t)
      sinceFix += 10
      if (sinceFix >= 1000) {
        sinceFix = 0
        detector.addGnss(t, v, bearing)
      }
    }

    /** Alternating accelerate / brake at 2 m/s^2 between about 4 and 10 m/s, so the axis can be learned. */
    fun learnMount(cycles: Int = 4) {
      repeat(cycles) {
        run(3000, fwd = 2.0)
        run(3000, fwd = -2.0)
      }
    }

    fun cruiseAt(speed: Double, ms: Long = 2000) {
      // Speed up (or down) gently, then hold.
      while (v < speed - 0.05) run(100, fwd = 1.5)
      while (v > speed + 0.05) run(100, fwd = -1.5)
      run(ms)
    }

    fun brake(ms: Long, g_: Double = 0.8) = run(ms, fwd = -g_ * g)
  }

  private fun detector(rec: Recorder, config: HardBrakingConfig = HardBrakingConfig()) =
    HardBrakingDetector(config, rec)

  // --- onset detection ----------------------------------------------------------------------

  @Test
  fun hardBrakeFiresAtImuOnsetNotAtGnssConfirmation() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    assertTrue("axis should be learned", d.isAxisReady)
    ride.cruiseAt(15.0)
    assertTrue(rec.events.isEmpty())

    val brakeStart = ride.t
    ride.brake(600)
    ride.run(2500)

    assertEquals(1, rec.events.size)
    val e = rec.events[0]
    assertEquals(BrakingSource.IMU, e.source)
    val latency = e.raisedAt - brakeStart
    assertTrue("raised ${latency} ms after the brake began", latency in 150..260)
    assertTrue("peak ${e.peakDecelG}", e.peakDecelG in 0.65..1.0)
    assertEquals(15.0, e.speedMps, 0.6)
    assertEquals(90.0, e.headingDeg!!, 0.001)
    // GNSS confirms afterwards, and only afterwards.
    assertTrue(rec.decisions.filterIsInstance<BrakingDecision.Confirmed>().isNotEmpty())
  }

  @Test
  fun doesNotFireBeforeTheSustainWindow() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(15.0)
    ride.brake(110) // shorter than 150 ms
    ride.run(3000)
    assertTrue(rec.events.isEmpty())
  }

  // --- mount orientation independence --------------------------------------------------------

  @Test
  fun worksWithTheSamePhoneMountedAnyWayRound() {
    for ((name, orientation) in orientations) {
      val rec = Recorder()
      val d = detector(rec)
      val ride = Ride(d, orientation)
      ride.learnMount()
      assertTrue("$name: axis not learned", d.isAxisReady)
      ride.cruiseAt(15.0)
      val start = ride.t
      ride.brake(600)
      ride.run(2000)
      assertEquals("$name: events", 1, rec.events.size)
      assertTrue("$name: latency", rec.events[0].raisedAt - start in 150..260)
      assertTrue("$name: peak ${rec.events[0].peakDecelG}", rec.events[0].peakDecelG in 0.65..1.0)
    }
  }

  @Test
  fun lateralAndAcceleratingForcesNeverLookLikeBraking() {
    for ((name, orientation) in orientations) {
      val rec = Recorder()
      val d = detector(rec)
      val ride = Ride(d, orientation)
      ride.learnMount()
      ride.cruiseAt(15.0)
      ride.run(500, lat = 0.8 * g) // hard sustained cornering / swerve
      ride.run(500, lat = -0.8 * g)
      ride.run(500, fwd = 0.9 * g) // hard acceleration
      ride.run(2000)
      assertTrue("$name: ${rec.events}", rec.events.isEmpty())
    }
  }

  // --- bump rejection ------------------------------------------------------------------------

  @Test
  fun potholeAndShortBumpsAreRejected() {
    for ((name, orientation) in orientations) {
      val rec = Recorder()
      val d = detector(rec)
      val ride = Ride(d, orientation)
      ride.learnMount()
      ride.cruiseAt(15.0)
      ride.run(80, vert = 3.0 * g) // pothole: a vertical spike
      ride.run(500)
      ride.run(100, fwd = -1.2 * g) // a sharp forward jolt, but under 150 ms
      ride.run(500)
      ride.run(40, fwd = -2.0 * g, vert = 2.0 * g)
      ride.run(2000)
      assertTrue("$name: ${rec.events}", rec.events.isEmpty())
    }
  }

  @Test
  fun vibrationAroundTheThresholdDoesNotTrigger() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(15.0)
    // 0.45 g mean braking with +-1.5 g of 25 Hz engine / road vibration on top.
    var i = 0
    repeat(60) {
      ride.run(10, fwd = -0.45 * g + 1.5 * g * (if ((i++ / 2) % 2 == 0) 1.0 else -1.0))
    }
    ride.run(2000)
    assertTrue(rec.events.isEmpty())
  }

  @Test
  fun forkDivePitchDoesNotBleedIntoTheBrakingChannel() {
    // A sudden pitch rotates the phone, so gravity swings through the phone's forward axis. With
    // the fused gravity tracking that swing it must not read as deceleration.
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(15.0)
    // 12 degrees of pitch within 200 ms, feeding the gravity sensor and the accelerometer alike.
    val steps = 20
    for (i in 1..steps) {
      val pitch = 12 * deg * i / steps
      val o = mul(rotX(pitch), flat)
      val grav = apply(o, doubleArrayOf(0.0, 0.0, g))
      ride.t += 10
      d.addGravity(ride.t, grav[0], grav[1], grav[2])
      val a = apply(o, doubleArrayOf(0.0, 0.0, g))
      d.addAccel(ride.t, a[0], a[1], a[2])
    }
    ride.run(2000)
    assertTrue(rec.events.isEmpty())
  }

  // --- gates ----------------------------------------------------------------------------------

  @Test
  fun slowRidingNeverTriggers() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(7.0) // 25 km/h
    ride.brake(600)
    ride.run(2000)
    assertTrue(rec.events.isEmpty())
    assertTrue(rec.rejected(BrakingRejectReason.LOW_SPEED))
  }

  @Test
  fun noGnssFixMeansNoAlert() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(15.0)
    // The fixes stop arriving (tunnel): after 2.5 s the speed is too old to trust.
    var t = ride.t
    repeat(300) {
      t += 10
      val grav = apply(flat, doubleArrayOf(0.0, 0.0, g))
      d.addGravity(t, grav[0], grav[1], grav[2])
      d.addAccel(t, 0.0, 0.0, g)
    }
    repeat(60) {
      t += 10
      val grav = apply(flat, doubleArrayOf(0.0, 0.0, g))
      d.addGravity(t, grav[0], grav[1], grav[2])
      d.addAccel(t, 0.0, -0.9 * g, g)
    }
    assertTrue(rec.events.isEmpty())
    assertTrue(rec.rejected(BrakingRejectReason.NO_SPEED))
  }

  // --- cooldown -------------------------------------------------------------------------------

  @Test
  fun multiStageBrakingProducesOneAlertPerCooldown() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(20.0)

    ride.brake(400)
    ride.run(500)
    ride.brake(400) // second stage, inside the 4 s cooldown
    ride.run(500)
    ride.brake(400) // third stage, still inside
    ride.run(200)
    assertEquals(1, rec.events.size)
    assertTrue(rec.rejected(BrakingRejectReason.COOLDOWN))

    // A fresh hard brake after the cooldown is a new alert.
    ride.cruiseAt(20.0, ms = 5000)
    ride.brake(400)
    ride.run(1500)
    assertEquals(2, rec.events.size)
    assertTrue(rec.events[1].seq > rec.events[0].seq)
  }

  // --- GNSS confirmation ---------------------------------------------------------------------

  @Test
  fun alertWithoutAMatchingSpeedDropIsMarkedUnconfirmed() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    ride.cruiseAt(15.0)
    // The IMU sees 0.8 g, but the GNSS speed keeps reading 15 m/s (e.g. a bad fix).
    var t = ride.t
    var sinceFix = 0
    repeat(500) {
      t += 10
      sinceFix += 10
      val grav = apply(flat, doubleArrayOf(0.0, 0.0, g))
      d.addGravity(t, grav[0], grav[1], grav[2])
      d.addAccel(t, 0.0, if (it < 40) -0.8 * g else 0.0, g)
      d.tick(t)
      if (sinceFix >= 1000) {
        sinceFix = 0
        d.addGnss(t, 15.0, 90.0)
      }
    }
    assertEquals(1, rec.events.size)
    assertTrue(rec.decisions.any { it is BrakingDecision.Unconfirmed })
    assertFalse(rec.decisions.any { it is BrakingDecision.Confirmed })
  }

  @Test
  fun beforeTheAxisIsLearnedOnlyTheSlowerGnssPathCanAlert() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat, startSpeed = 15.0)
    ride.run(3000) // cruising: nothing learned yet
    assertFalse(d.isAxisReady)
    ride.brake(1000, g_ = 0.8) // 7.8 m/s drop within one GNSS interval
    ride.run(2000)
    assertEquals(1, rec.events.size)
    assertEquals(BrakingSource.GNSS_ONLY, rec.events[0].source)
  }

  // --- robustness -----------------------------------------------------------------------------

  @Test
  fun worksWithoutAGravitySensor() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, tiltedMount, withGravitySensor = false)
    ride.learnMount(cycles = 5)
    assertTrue("axis should be learned from the accelerometer alone", d.isAxisReady)
    ride.cruiseAt(15.0, ms = 4000)
    ride.brake(600, g_ = 0.95)
    ride.run(2000)
    assertEquals(1, rec.events.size)
  }

  @Test
  fun badSamplesAreIgnored() {
    val rec = Recorder()
    val d = detector(rec)
    d.addAccel(1, Double.NaN, 0.0, 9.8)
    d.addGravity(1, Double.POSITIVE_INFINITY, 0.0, 9.8)
    d.addGnss(1, Double.NaN, Double.NaN)
    d.addGnss(1000, -5.0)
    d.tick(2000)
    assertTrue(rec.events.isEmpty())
    assertNull(rec.decisions.firstOrNull())
  }

  @Test
  fun resetMountForgetsTheAxis() {
    val rec = Recorder()
    val d = detector(rec)
    val ride = Ride(d, flat)
    ride.learnMount()
    assertTrue(d.isAxisReady)
    d.resetMount()
    assertFalse(d.isAxisReady)
    assertNotNull(d)
  }
}
