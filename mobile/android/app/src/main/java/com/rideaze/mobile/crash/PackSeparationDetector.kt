package com.rideaze.mobile.crash

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Thresholds for pack separation, breakdown and lost-contact detection. First-draft design numbers,
 * not tuned on real rides.
 */
data class PackConfig(
  /** GNSS speed at or below this (m/s, ~1.8 km/h) counts as "not moving" (a parked bike jitters). */
  val stopSpeedMps: Double = 0.5,
  /** Everything must be still for this long (ms) before the rider counts as stopped. */
  val stillMs: Long = 5_000,
  /** Stillness: mean |a| must be within this of 1 g (m/s^2). */
  val stillGravityBias: Double = 0.1 * STANDARD_GRAVITY,
  /** Stillness: standard deviation of |a| per second must be below this (m/s^2). Idle-engine buzz is lower. */
  val stillAccelStd: Double = 0.6,
  /** Stillness: peak gyroscope rate per second must be below this (rad/s). */
  val stillGyroRadS: Double = 0.35,
  /** Speed (m/s) that counts as "in transit" (15 km/h). A rider who never travelled is just parked. */
  val transitMps: Double = 15.0 / 3.6,
  /** ...and the transit must have been this recent (ms). */
  val transitMemoryMs: Long = 120_000,
  /** Speed (m/s) at which a stopped rider counts as moving again. */
  val resumeSpeedMps: Double = 2.0,
  /** The latest GNSS fix must be no older than this (ms) for any stop / separation decision. */
  val gnssMaxAgeMs: Long = 5_000,
  /** A stop becomes a BREAKDOWN after this long (ms) if the group is not stopped too. */
  val breakdownAfterMs: Long = 15_000,
  /** The group counts as moving when the median peer speed is above this (m/s, 20 km/h). */
  val groupMovingMps: Double = 20.0 / 3.6,
  /** Distance from the group centroid (m) beyond which this rider is separated. */
  val separationMeters: Double = 500.0,
  /** Separation clears once the distance is back under this fraction of [separationMeters]. */
  val separationClearFraction: Double = 0.8,
  /** Speed-lag rule: the group must be moving faster than this (m/s, 40 km/h)... */
  val lagGroupSpeedMps: Double = 40.0 / 3.6,
  /** ...while this rider is at or below this fraction of the group speed... */
  val lagSelfFraction: Double = 0.5,
  /** ...and already at least this far (m) from the centroid. */
  val lagMinMeters: Double = 250.0,
  /** A separation condition must hold this long (ms) before it is raised or cleared. */
  val separationConfirmMs: Long = 5_000,
  /** A peer silent for longer than this (ms) is LOST_CONTACT. */
  val staleMs: Long = 30_000,
  /** A condition that persists is announced again after this long (ms). */
  val repeatMs: Long = 60_000,
)

enum class PackEventType(val wire: String) {
  BREAKDOWN("BREAKDOWN"),
  SEPARATION("SEPARATION"),
  LOST_CONTACT("LOST_CONTACT"),
}

/** One event about a rider. For this rider's own events [riderId] is [PackSeparationDetector.SELF_ID]. */
data class PackEvent(
  val type: PackEventType,
  val riderId: String,
  val riderName: String?,
  val self: Boolean,
  /** Last known position of the affected rider (the rider's own fix, or the peer's last one). */
  val latitude: Double?,
  val longitude: Double?,
  val speedMps: Double?,
  /** Distance from this rider to the group centroid (separation / breakdown), when known. */
  val distanceMeters: Double?,
  val groupSpeedMps: Double?,
  /** Local epoch ms. */
  val at: Long,
  /** LOST_CONTACT: local epoch ms of the last heartbeat from that rider. */
  val lastSeenAt: Long?,
  /** LOST_CONTACT: every known peer is silent, which usually means THIS phone lost the link. */
  val groupSilent: Boolean = false,
)

interface PackListener {
  /** This rider has been still for [PackConfig.stillMs] after travelling: the RIDER_STOPPED state. */
  fun onRiderStopped(at: Long, latitude: Double?, longitude: Double?)

  /** A stopped rider is moving again. */
  fun onRiderMoving(at: Long)

  /** This rider has broken down or fallen away from the pack (BREAKDOWN / SEPARATION). */
  fun onPackAlert(event: PackEvent)

  /** A peer's heartbeat has been silent for [PackConfig.staleMs]. */
  fun onRiderLostContact(event: PackEvent)

  /** A condition ended: the rider moved, rejoined the pack, or the peer was heard again. */
  fun onPackRecovered(type: PackEventType, riderId: String, at: Long)
}

/** A peer position as handed over by the app. [timestamp] is the SENDER's clock and only used to notice a new fix. */
data class PeerFix(
  val id: String,
  val name: String?,
  val latitude: Double,
  val longitude: Double,
  val speedMps: Double?,
  val timestamp: Long,
)

/** What is remembered about a peer, including the last known position kept for an emergency recall. */
data class PeerStatus(
  val id: String,
  val name: String?,
  val latitude: Double,
  val longitude: Double,
  val speedMps: Double?,
  /** Local epoch ms the last NEW fix from this peer arrived. */
  val lastSeenAt: Long,
  val lostContact: Boolean,
)

/**
 * Convoy awareness for one rider. Pure Kotlin and single-threaded: feed it on the sensor thread.
 *
 *  - Stop / breakdown: GNSS speed at ~0 AND the accelerometer still (|a| within 0.1 g of 1 g, low
 *    variance) AND the gyroscope near zero, for [PackConfig.stillMs], after a recent stretch of
 *    travel -> RIDER_STOPPED. If the group is still moving (or unknown) [PackConfig.breakdownAfterMs]
 *    later it is a BREAKDOWN, so a red light the whole group is waiting at is not.
 *  - Separation: distance to the centroid of the peers heard recently exceeds
 *    [PackConfig.separationMeters], or the group is doing 40+ km/h while this rider is at half that
 *    speed and already 250 m out. Hysteresis and a confirm delay stop it flickering.
 *  - Lost contact: a peer is alive while NEW fixes keep arriving. Liveness is judged on this phone's
 *    clock from the moment a different fix appears, so clock differences between phones cannot fake
 *    or hide a silence. The last known position is kept.
 */
class PackSeparationDetector(
  private val config: PackConfig,
  private val listener: PackListener,
) {

  companion object {
    const val SELF_ID = "self"
    private const val BUCKET_MS = 1_000L
    private const val MIN_SAMPLES_PER_BUCKET = 20
    private const val KEEP_BUCKETS = 12
    private const val EVAL_INTERVAL_MS = 1_000L
    private const val EARTH_RADIUS_M = 6_371_000.0

    fun distanceMeters(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
      val dLat = Math.toRadians(lat2 - lat1)
      val dLon = Math.toRadians(lon2 - lon1)
      val a = sin(dLat / 2) * sin(dLat / 2) +
        cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2) * sin(dLon / 2)
      return 2 * EARTH_RADIUS_M * atan2(sqrt(a), sqrt(1 - a))
    }
  }

  private class Bucket(val index: Long, val still: Boolean)

  private class Peer(
    var name: String?,
    var latitude: Double,
    var longitude: Double,
    var speedMps: Double?,
    var timestamp: Long,
    var lastSeenAt: Long,
    var lost: Boolean = false,
  )

  // --- accelerometer / gyroscope stillness, per 1 s bucket ---
  private var curIndex = Long.MIN_VALUE
  private var curN = 0
  private var curSum = 0.0
  private var curSumSq = 0.0
  private val gyroPeak = HashMap<Long, Double>()
  private var gyroSeen = false
  private val buckets = ArrayDeque<Bucket>()

  // --- GNSS ---
  private var fixAt = Long.MIN_VALUE
  private var fixSpeed: Double? = null
  private var fixLat: Double? = null
  private var fixLon: Double? = null
  private var slowSince = -1L
  private var lastTransitAt = Long.MIN_VALUE

  // --- stop / breakdown ---
  private var stopped = false
  private var stoppedAt = 0L
  private var breakdownActive = false
  private var lastBreakdownAt = 0L

  // --- separation ---
  private var sepCandidateSince = -1L
  private var sepClearSince = -1L
  private var sepActive = false
  private var lastSepAt = 0L

  private val peers = LinkedHashMap<String, Peer>()
  private var lastEvalAt = Long.MIN_VALUE

  val isStopped: Boolean get() = stopped

  fun setGyroAvailable(available: Boolean) {
    gyroSeen = available
  }

  fun addAccel(t: Long, x: Double, y: Double, z: Double) {
    if (!x.isFinite() || !y.isFinite() || !z.isFinite()) return
    val index = t / BUCKET_MS
    if (index != curIndex) {
      finishBucket()
      curIndex = index
    }
    val mag = sqrt(x * x + y * y + z * z)
    curN++
    curSum += mag
    curSumSq += mag * mag
  }

  fun addGyro(t: Long, x: Double, y: Double, z: Double) {
    if (!x.isFinite() || !y.isFinite() || !z.isFinite()) return
    gyroSeen = true
    val index = t / BUCKET_MS
    val rate = sqrt(x * x + y * y + z * z)
    val prev = gyroPeak[index]
    if (prev == null || rate > prev) gyroPeak[index] = rate
  }

  /** [speedMps] may be null when the fix carries no speed; the position is still recorded. */
  fun addGnss(t: Long, speedMps: Double?, lat: Double, lon: Double) {
    if (!lat.isFinite() || !lon.isFinite()) return
    fixAt = t
    fixLat = lat
    fixLon = lon
    fixSpeed = speedMps?.takeIf { it.isFinite() && it >= 0 }
    val speed = fixSpeed ?: return
    if (speed >= config.transitMps) lastTransitAt = t
    if (speed <= config.stopSpeedMps) {
      if (slowSince < 0) slowSince = t
    } else {
      slowSince = -1
    }
  }

  /** Replaces/refreshes the peer table. A peer is "heard" only when its [PeerFix.timestamp] changes. */
  fun updatePeers(fixes: List<PeerFix>, now: Long) {
    for (f in fixes) {
      if (!f.latitude.isFinite() || !f.longitude.isFinite()) continue
      val peer = peers[f.id]
      if (peer == null) {
        peers[f.id] = Peer(f.name, f.latitude, f.longitude, f.speedMps, f.timestamp, now)
        continue
      }
      if (f.timestamp != peer.timestamp) {
        peer.timestamp = f.timestamp
        peer.lastSeenAt = now
        peer.latitude = f.latitude
        peer.longitude = f.longitude
        peer.speedMps = f.speedMps
        if (f.name != null) peer.name = f.name
        if (peer.lost) {
          peer.lost = false
          listener.onPackRecovered(PackEventType.LOST_CONTACT, f.id, now)
        }
      }
    }
  }

  fun peerSnapshot(): List<PeerStatus> =
    peers.map { (id, p) ->
      PeerStatus(id, p.name, p.latitude, p.longitude, p.speedMps, p.lastSeenAt, p.lost)
    }

  fun tick(now: Long) {
    if (lastEvalAt != Long.MIN_VALUE && now - lastEvalAt < EVAL_INTERVAL_MS) return
    lastEvalAt = now
    checkLostContact(now)
    checkStop(now)
    checkSeparation(now)
  }

  fun reset() {
    curIndex = Long.MIN_VALUE
    curN = 0
    curSum = 0.0
    curSumSq = 0.0
    gyroPeak.clear()
    buckets.clear()
    fixAt = Long.MIN_VALUE
    fixSpeed = null
    fixLat = null
    fixLon = null
    slowSince = -1
    lastTransitAt = Long.MIN_VALUE
    stopped = false
    breakdownActive = false
    sepCandidateSince = -1
    sepClearSince = -1
    sepActive = false
    peers.clear()
    lastEvalAt = Long.MIN_VALUE
  }

  // ------------------------------------------------------------------------------------------

  private fun finishBucket() {
    if (curN > 0 && curIndex != Long.MIN_VALUE) {
      val mean = curSum / curN
      val variance = (curSumSq / curN - mean * mean).coerceAtLeast(0.0)
      val gyroOk = !gyroSeen || (gyroPeak[curIndex] ?: 0.0) <= config.stillGyroRadS
      val still =
        curN >= MIN_SAMPLES_PER_BUCKET &&
          abs(mean - STANDARD_GRAVITY) <= config.stillGravityBias &&
          sqrt(variance) <= config.stillAccelStd &&
          gyroOk
      buckets.addLast(Bucket(curIndex, still))
      while (buckets.size > KEEP_BUCKETS) buckets.removeFirst()
      gyroPeak.keys.removeAll { it < curIndex - KEEP_BUCKETS }
    }
    curN = 0
    curSum = 0.0
    curSumSq = 0.0
  }

  private fun gnssFresh(now: Long) = fixAt != Long.MIN_VALUE && now - fixAt <= config.gnssMaxAgeMs

  /** The last whole seconds are all still, with no gaps, and recent. */
  private fun imuStill(now: Long): Boolean {
    val needed = ((config.stillMs + BUCKET_MS - 1) / BUCKET_MS).toInt()
    if (buckets.size < needed) return false
    val tail = buckets.toList().takeLast(needed)
    if (tail.last().index < now / BUCKET_MS - 2) return false
    for (i in 1 until tail.size) if (tail[i].index != tail[i - 1].index + 1) return false
    return tail.all { it.still }
  }

  private fun checkStop(now: Long) {
    if (!stopped) {
      val travelled = lastTransitAt != Long.MIN_VALUE && now - lastTransitAt <= config.transitMemoryMs
      if (travelled && gnssFresh(now) && slowSince >= 0 && now - slowSince >= config.stillMs && imuStill(now)) {
        stopped = true
        stoppedAt = now
        listener.onRiderStopped(now, fixLat, fixLon)
      }
      return
    }

    val speed = fixSpeed
    if (gnssFresh(now) && speed != null && speed >= config.resumeSpeedMps) {
      stopped = false
      slowSince = -1
      listener.onRiderMoving(now)
      if (breakdownActive) {
        breakdownActive = false
        listener.onPackRecovered(PackEventType.BREAKDOWN, SELF_ID, now)
      }
      return
    }

    if (now - stoppedAt < config.breakdownAfterMs) return
    val fresh = freshPeers(now)
    val groupSpeed = medianSpeed(fresh)
    val groupMoving = fresh.isEmpty() || (groupSpeed != null && groupSpeed >= config.groupMovingMps)
    if (!groupMoving) return
    if (breakdownActive && now - lastBreakdownAt < config.repeatMs) return
    breakdownActive = true
    lastBreakdownAt = now
    listener.onPackAlert(
      PackEvent(
        type = PackEventType.BREAKDOWN,
        riderId = SELF_ID,
        riderName = null,
        self = true,
        latitude = fixLat,
        longitude = fixLon,
        speedMps = speed ?: 0.0,
        distanceMeters = centroidDistance(fresh),
        groupSpeedMps = groupSpeed,
        at = now,
        lastSeenAt = null,
      ),
    )
  }

  private fun checkSeparation(now: Long) {
    // A stopped, broken-down rider is already reported as such.
    if (stopped && breakdownActive) {
      sepCandidateSince = -1
      return
    }
    val fresh = freshPeers(now)
    val lat = fixLat
    val lon = fixLon
    if (fresh.isEmpty() || lat == null || lon == null || now - fixAt > config.gnssMaxAgeMs * 2) {
      sepCandidateSince = -1
      sepClearSince = -1
      return
    }
    val centroidLat = fresh.sumOf { it.latitude } / fresh.size
    val centroidLon = fresh.sumOf { it.longitude } / fresh.size
    val distance = distanceMeters(lat, lon, centroidLat, centroidLon)
    val groupSpeed = medianSpeed(fresh)
    val selfSpeed = fixSpeed
    val lagging =
      groupSpeed != null && selfSpeed != null &&
        groupSpeed >= config.lagGroupSpeedMps &&
        selfSpeed <= config.lagSelfFraction * groupSpeed &&
        distance >= config.lagMinMeters
    val separated = distance > config.separationMeters || lagging

    if (separated) {
      sepClearSince = -1
      if (sepCandidateSince < 0) sepCandidateSince = now
      val confirmed = now - sepCandidateSince >= config.separationConfirmMs
      val due = !sepActive || now - lastSepAt >= config.repeatMs
      if (confirmed && due) {
        sepActive = true
        lastSepAt = now
        listener.onPackAlert(
          PackEvent(
            type = PackEventType.SEPARATION,
            riderId = SELF_ID,
            riderName = null,
            self = true,
            latitude = lat,
            longitude = lon,
            speedMps = selfSpeed,
            distanceMeters = distance,
            groupSpeedMps = groupSpeed,
            at = now,
            lastSeenAt = null,
          ),
        )
      }
      return
    }

    sepCandidateSince = -1
    if (!sepActive) return
    // Between the clear fraction and the threshold the alert simply stays up (hysteresis).
    if (distance <= config.separationMeters * config.separationClearFraction) {
      if (sepClearSince < 0) sepClearSince = now
      if (now - sepClearSince >= config.separationConfirmMs) {
        sepActive = false
        sepClearSince = -1
        listener.onPackRecovered(PackEventType.SEPARATION, SELF_ID, now)
      }
    } else {
      sepClearSince = -1
    }
  }

  private fun checkLostContact(now: Long) {
    if (peers.isEmpty()) return
    val silent = peers.values.all { now - it.lastSeenAt > config.staleMs }
    for ((id, peer) in peers) {
      if (peer.lost || now - peer.lastSeenAt <= config.staleMs) continue
      peer.lost = true
      listener.onRiderLostContact(
        PackEvent(
          type = PackEventType.LOST_CONTACT,
          riderId = id,
          riderName = peer.name,
          self = false,
          latitude = peer.latitude,
          longitude = peer.longitude,
          speedMps = peer.speedMps,
          distanceMeters =
            fixLat?.let { la -> fixLon?.let { lo -> distanceMeters(la, lo, peer.latitude, peer.longitude) } },
          groupSpeedMps = null,
          at = now,
          lastSeenAt = peer.lastSeenAt,
          groupSilent = silent,
        ),
      )
    }
  }

  private fun freshPeers(now: Long): List<Peer> =
    peers.values.filter { !it.lost && now - it.lastSeenAt <= config.staleMs }

  private fun medianSpeed(list: List<Peer>): Double? {
    val speeds = list.mapNotNull { it.speedMps }.sorted()
    if (speeds.isEmpty()) return null
    val mid = speeds.size / 2
    return if (speeds.size % 2 == 1) speeds[mid] else (speeds[mid - 1] + speeds[mid]) / 2
  }

  private fun centroidDistance(list: List<Peer>): Double? {
    val lat = fixLat ?: return null
    val lon = fixLon ?: return null
    if (list.isEmpty()) return null
    return distanceMeters(lat, lon, list.sumOf { it.latitude } / list.size, list.sumOf { it.longitude } / list.size)
  }
}
