package com.rideaze.mobile.crash

import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PackSeparationDetectorTest {

  private val t0 = 1_700_000_000_000L
  private val g = STANDARD_GRAVITY
  // 1 degree of latitude in metres.
  private val metresPerDegree = 111_195.0

  private class Recorder : PackListener {
    val stopped = mutableListOf<Long>()
    val moving = mutableListOf<Long>()
    val alerts = mutableListOf<PackEvent>()
    val lost = mutableListOf<PackEvent>()
    val recovered = mutableListOf<Triple<PackEventType, String, Long>>()

    override fun onRiderStopped(at: Long, latitude: Double?, longitude: Double?) {
      stopped += at
    }

    override fun onRiderMoving(at: Long) {
      moving += at
    }

    override fun onPackAlert(event: PackEvent) {
      alerts += event
    }

    override fun onRiderLostContact(event: PackEvent) {
      lost += event
    }

    override fun onPackRecovered(type: PackEventType, riderId: String, at: Long) {
      recovered += Triple(type, riderId, at)
    }
  }

  private class Rig(val t0: Long, config: PackConfig, val g: Double) {
    val rec = Recorder()
    val detector = PackSeparationDetector(config, rec)
    var now = t0
    var lat = 12.0
    var lon = 77.0

    /**
     * Advances [ms] of simulated time. IMU at 100 Hz: gravity plus a small ripple, with [shake] m/s^2
     * of extra vibration and [spin] rad/s of rotation. One GNSS fix per second at [speed]. [onSecond]
     * runs once per simulated second, before that second's samples.
     */
    fun run(
      ms: Long,
      speed: Double?,
      shake: Double = 0.0,
      spin: Double = 0.0,
      onSecond: (Long) -> Unit = {},
    ) {
      val end = now + ms
      while (now < end) {
        if ((now - t0) % 1000 == 0L) {
          onSecond(now)
          detector.addGnss(now, speed, lat, lon)
        }
        val ripple = 0.1 * sin(now * 0.37) + shake * sin(now * 1.7)
        detector.addAccel(now, 0.0, 0.0, g + ripple)
        detector.addGyro(now, spin * sin(now * 0.9), 0.0, 0.0)
        if ((now - t0) % 100 == 0L) detector.tick(now)
        now += 10
      }
    }
  }

  private fun rig(config: PackConfig = PackConfig()) = Rig(t0, config, g)

  // --- stillness confirmation (GNSS + accelerometer + gyro) ---

  @Test
  fun stopIsConfirmedOnlyAfterFiveSecondsOfGnssAndImuStillness() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    val stopStart = r.now
    r.run(4_000, speed = 0.0)
    assertTrue("must not fire inside the 5 s window", r.rec.stopped.isEmpty())
    r.run(4_000, speed = 0.0)
    assertEquals(1, r.rec.stopped.size)
    val after = r.rec.stopped.single() - stopStart
    assertTrue("fired $after ms after the stop began", after in 5_000..7_500)
    assertTrue(r.detector.isStopped)
  }

  @Test
  fun gnssAtZeroButEngineVibratingIsNotAStop() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    r.run(12_000, speed = 0.0, shake = 3.0)
    assertTrue(r.rec.stopped.isEmpty())
  }

  @Test
  fun rotationKeepsAZeroSpeedRiderFromCountingAsStill() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    r.run(12_000, speed = 0.0, spin = 1.5)
    assertTrue(r.rec.stopped.isEmpty())
  }

  @Test
  fun aStillPhoneWhileGnssSaysMovingIsNotAStop() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    r.run(12_000, speed = 4.0)
    assertTrue(r.rec.stopped.isEmpty())
  }

  @Test
  fun aBikeThatNeverTravelledIsJustParked() {
    val r = rig()
    r.run(30_000, speed = 0.0)
    assertTrue(r.rec.stopped.isEmpty())
  }

  @Test
  fun aMissingGnssFixBlocksTheStopDecision() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    // No fixes any more: the last one is older than the freshness limit.
    val d = r.detector
    val quietStart = r.now
    while (r.now < quietStart + 12_000) {
      d.addAccel(r.now, 0.0, 0.0, g)
      d.addGyro(r.now, 0.0, 0.0, 0.0)
      if ((r.now - r.t0) % 100 == 0L) d.tick(r.now)
      r.now += 10
    }
    assertTrue(r.rec.stopped.isEmpty())
  }

  @Test
  fun movingAgainEndsTheStop() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    r.run(9_000, speed = 0.0)
    assertEquals(1, r.rec.stopped.size)
    r.run(3_000, speed = 6.0)
    assertEquals(1, r.rec.moving.size)
    assertFalse(r.detector.isStopped)
  }

  // --- breakdown: stopped while the group moves ---

  private fun peersAt(lat: Double, lon: Double, speed: Double?, ts: Long, count: Int = 2) =
    (1..count).map { PeerFix("p$it", "Peer $it", lat, lon + it * 0.00001, speed, ts) }

  @Test
  fun stoppedWhileTheGroupMovesBecomesABreakdown() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    var ts = 1L
    r.run(30_000, speed = 0.0) { now ->
      r.detector.updatePeers(peersAt(r.lat, r.lon, 16.0, ts++), now)
    }
    val breakdown = r.rec.alerts.single { it.type == PackEventType.BREAKDOWN }
    assertTrue(breakdown.self)
    assertEquals(12.0, breakdown.latitude!!, 1e-9)
    assertEquals(0.0, breakdown.speedMps!!, 1e-9)
    assertEquals(16.0, breakdown.groupSpeedMps!!, 1e-9)
    assertTrue(r.rec.stopped.isNotEmpty())
  }

  @Test
  fun aWholeGroupWaitingAtALightIsNotABreakdown() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    var ts = 1L
    r.run(40_000, speed = 0.0) { now ->
      r.detector.updatePeers(peersAt(r.lat, r.lon, 0.0, ts++), now)
    }
    assertTrue(r.rec.stopped.isNotEmpty())
    assertTrue(r.rec.alerts.none { it.type == PackEventType.BREAKDOWN })
  }

  @Test
  fun breakdownRecoversWhenTheRiderMovesOff() {
    val r = rig()
    r.run(30_000, speed = 15.0)
    var ts = 1L
    val feed = { now: Long -> r.detector.updatePeers(peersAt(r.lat, r.lon, 16.0, ts++), now) }
    r.run(30_000, speed = 0.0, onSecond = feed)
    assertEquals(1, r.rec.alerts.count { it.type == PackEventType.BREAKDOWN })
    r.run(3_000, speed = 6.0, onSecond = feed)
    assertTrue(r.rec.recovered.any { it.first == PackEventType.BREAKDOWN && it.second == PackSeparationDetector.SELF_ID })
  }

  // --- separation against the convoy centroid ---

  /** A rig that is travelling at [selfSpeed] with two peers [metres] north, each heard every second. */
  private fun separationRun(r: Rig, metres: Double, seconds: Int, selfSpeed: Double, groupSpeed: Double?) {
    var ts = r.now
    r.run(seconds * 1000L, speed = selfSpeed) { now ->
      r.detector.updatePeers(peersAt(r.lat + metres / metresPerDegree, r.lon, groupSpeed, ts++), now)
    }
  }

  @Test
  fun separationIsRaisedBeyondTheThresholdAndNotBefore() {
    val under = rig()
    separationRun(under, metres = 450.0, seconds = 20, selfSpeed = 15.0, groupSpeed = 15.0)
    assertTrue(under.rec.alerts.isEmpty())

    val over = rig()
    separationRun(over, metres = 620.0, seconds = 20, selfSpeed = 15.0, groupSpeed = 15.0)
    val event = over.rec.alerts.single { it.type == PackEventType.SEPARATION }
    assertTrue(event.self)
    assertEquals(620.0, event.distanceMeters!!, 15.0)
  }

  @Test
  fun separationNeedsTheConditionToHoldNotJustAGlitch() {
    val r = rig()
    separationRun(r, metres = 620.0, seconds = 3, selfSpeed = 15.0, groupSpeed = 15.0)
    separationRun(r, metres = 100.0, seconds = 10, selfSpeed = 15.0, groupSpeed = 15.0)
    assertTrue(r.rec.alerts.isEmpty())
  }

  @Test
  fun separationClearsOnlyWellInsideTheThreshold() {
    val r = rig()
    separationRun(r, metres = 650.0, seconds = 15, selfSpeed = 15.0, groupSpeed = 15.0)
    assertEquals(1, r.rec.alerts.size)
    // 450 m is under 500 m but not under 400 m (80%): the alert stays.
    separationRun(r, metres = 450.0, seconds = 15, selfSpeed = 15.0, groupSpeed = 15.0)
    assertTrue(r.rec.recovered.isEmpty())
    separationRun(r, metres = 300.0, seconds = 15, selfSpeed = 15.0, groupSpeed = 15.0)
    assertEquals(1, r.rec.recovered.count { it.first == PackEventType.SEPARATION })
  }

  @Test
  fun aFastGroupLeavingASlowRiderBehindTriggersBeforeTheDistanceThreshold() {
    val r = rig()
    // 300 m back is inside the 500 m limit, but the group does 50 km/h and this rider 20 km/h.
    separationRun(r, metres = 300.0, seconds = 20, selfSpeed = 5.5, groupSpeed = 14.0)
    assertEquals(1, r.rec.alerts.count { it.type == PackEventType.SEPARATION })
  }

  @Test
  fun aSlowGroupDoesNotTriggerTheSpeedLagRule() {
    val r = rig()
    separationRun(r, metres = 300.0, seconds = 20, selfSpeed = 3.0, groupSpeed = 8.0)
    assertTrue(r.rec.alerts.none { it.type == PackEventType.SEPARATION })
  }

  @Test
  fun distanceHelperMatchesAKnownLength() {
    val d = PackSeparationDetector.distanceMeters(12.0, 77.0, 12.0 + 1.0, 77.0)
    assertEquals(metresPerDegree, d, 150.0)
  }

  // --- heartbeat / lost contact ---

  @Test
  fun aSilentPeerBecomesLostContactAfterTheTimeoutAndKeepsItsLastPosition() {
    val r = rig()
    // The peer reports a new fix every 5 s for 20 s, then goes quiet.
    var ts = 0L
    r.run(60_000, speed = 10.0) { now ->
      val sec = (now - r.t0) / 1000
      if (sec <= 20 && sec % 5 == 0L) ts++
      r.detector.updatePeers(
        listOf(PeerFix("alex", "Alex", 12.01 + sec * 0.0, 77.02, 11.0, ts)),
        now,
      )
    }
    val event = r.rec.lost.single()
    assertEquals("alex", event.riderId)
    assertEquals("Alex", event.riderName)
    assertEquals(12.01, event.latitude!!, 1e-9)
    assertEquals(77.02, event.longitude!!, 1e-9)
    assertEquals(11.0, event.speedMps!!, 1e-9)
    val silence = event.at - event.lastSeenAt!!
    assertTrue("silence was $silence ms", silence in 30_000..32_500)
    // Retained for an emergency recall.
    val kept = r.detector.peerSnapshot().single()
    assertTrue(kept.lostContact)
    assertEquals(12.01, kept.latitude, 1e-9)
  }

  @Test
  fun repeatedlyPushingTheSameFixDoesNotCountAsAHeartbeat() {
    val r = rig()
    r.run(45_000, speed = 10.0) { now ->
      r.detector.updatePeers(listOf(PeerFix("alex", "Alex", 12.0, 77.0, 10.0, 12345L)), now)
    }
    assertEquals(1, r.rec.lost.size)
  }

  @Test
  fun heartbeatsJudgedOnThisPhonesClockIgnoreTheSendersClock() {
    val r = rig()
    // A sender whose clock is years off still counts as alive while its fixes keep changing.
    r.run(60_000, speed = 10.0) { now ->
      r.detector.updatePeers(listOf(PeerFix("alex", "Alex", 12.0, 77.0, 10.0, 915_148_800_000L + now / 1000)), now)
    }
    assertTrue(r.rec.lost.isEmpty())
  }

  @Test
  fun aPeerThatIsHeardAgainIsRestored() {
    val r = rig()
    var ts = 1L
    r.run(40_000, speed = 10.0) { now ->
      if (now - r.t0 < 5_000) r.detector.updatePeers(listOf(PeerFix("alex", "Alex", 12.0, 77.0, 10.0, ts++)), now)
    }
    assertEquals(1, r.rec.lost.size)
    r.detector.updatePeers(listOf(PeerFix("alex", "Alex", 12.1, 77.1, 10.0, ts)), r.now)
    assertEquals(1, r.rec.recovered.count { it.first == PackEventType.LOST_CONTACT && it.second == "alex" })
    assertFalse(r.detector.peerSnapshot().single().lostContact)
  }

  @Test
  fun everyoneGoingSilentAtOnceIsFlaggedAsThisPhonesLink() {
    val r = rig()
    var ts = 1L
    r.run(45_000, speed = 10.0) { now ->
      if (now - r.t0 < 5_000) {
        r.detector.updatePeers(
          listOf(
            PeerFix("a", "A", 12.0, 77.0, 10.0, ts),
            PeerFix("b", "B", 12.0, 77.0, 10.0, ts),
          ),
          now,
        )
        ts++
      }
    }
    assertEquals(2, r.rec.lost.size)
    assertTrue(r.rec.lost.all { it.groupSilent })
  }

  @Test
  fun oneQuietPeerAmongLiveOnesIsNotAGroupWideSilence() {
    val r = rig()
    var ts = 1L
    r.run(45_000, speed = 10.0) { now ->
      val sec = (now - r.t0) / 1000
      val list = mutableListOf(PeerFix("live", "Live", 12.0, 77.0, 10.0, ts++))
      if (sec < 5) list += PeerFix("quiet", "Quiet", 12.0, 77.0, 10.0, 1L + sec)
      else list += PeerFix("quiet", "Quiet", 12.0, 77.0, 10.0, 1L + 4)
      r.detector.updatePeers(list, now)
    }
    val event = r.rec.lost.single()
    assertEquals("quiet", event.riderId)
    assertFalse(event.groupSilent)
    assertNotNull(event.lastSeenAt)
    assertNull(r.rec.lost.firstOrNull { it.riderId == "live" })
  }

  @Test
  fun ignoresBadPositionsAndSamples() {
    val r = rig()
    r.detector.addAccel(t0, Double.NaN, 0.0, g)
    r.detector.addGyro(t0, Double.POSITIVE_INFINITY, 0.0, 0.0)
    r.detector.addGnss(t0, 5.0, Double.NaN, 77.0)
    r.detector.updatePeers(listOf(PeerFix("x", null, Double.NaN, 77.0, null, 1L)), t0)
    r.detector.tick(t0 + 60_000)
    assertTrue(r.detector.peerSnapshot().isEmpty())
    assertTrue(r.rec.alerts.isEmpty() && r.rec.lost.isEmpty() && r.rec.stopped.isEmpty())
  }
}
