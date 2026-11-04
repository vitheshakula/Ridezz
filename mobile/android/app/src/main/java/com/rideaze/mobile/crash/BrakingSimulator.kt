package com.rideaze.mobile.crash

import kotlin.math.floor
import kotlin.math.sin

object BrakingSimulator {
  private const val G = STANDARD_GRAVITY

  private interface Sink {
    fun gravity(t: Long)
    fun accel(t: Long, fwd: Double, jitter: Double)
    fun gnss(t: Long, speedMps: Double)
  }

  fun play(detector: HardBrakingDetector, endAt: Long, cruiseKmh: Double = 30.0, finalKmh: Double = 5.0) {
    val noop =
      object : Sink {
        override fun gravity(t: Long) = Unit
        override fun accel(t: Long, fwd: Double, jitter: Double) = Unit
        override fun gnss(t: Long, speedMps: Double) = Unit
      }
    val duration = run(0L, noop, cruiseKmh, finalKmh)
    val live =
      object : Sink {
        override fun gravity(t: Long) = detector.addGravity(t, 0.0, 0.0, G)
        override fun accel(t: Long, fwd: Double, jitter: Double) =
          detector.addAccel(t, 0.12 * jitter, fwd + 0.12 * jitter, G + 0.15 * jitter)
        override fun gnss(t: Long, speedMps: Double) = detector.addGnss(t, speedMps, 90.0)
      }
    run(endAt - duration, live, cruiseKmh, finalKmh)
  }

  private fun noise(t: Long): Double {
    val x = sin((t / 10.0) * 127.1) * 43758.5453
    return (x - floor(x)) * 2 - 1
  }

  private fun run(start: Long, sink: Sink, cruiseKmh: Double, finalKmh: Double): Long {
    var t = start
    var v = 6.0
    var sinceFix = 0L
    fun step(fwd: Double) {
      t += 10
      v = (v + fwd * 0.01).coerceAtLeast(0.0)
      sink.gravity(t)
      sink.accel(t, fwd, noise(t))
      sinceFix += 10
      if (sinceFix >= 1000) {
        sinceFix = 0
        sink.gnss(t, v)
      }
    }
    fun hold(ms: Long, fwd: Double) = repeat((ms / 10).toInt()) { step(fwd) }

    val cruise = cruiseKmh / 3.6
    val end = finalKmh / 3.6
    repeat(4) {
      hold(3000, 2.0)
      hold(3000, -2.0)
    }
    while (v < cruise) step(1.5)
    v = cruise
    hold(4500, 0.0)
    while (sinceFix != 0L) step(0.0)
    hold(1000, -(cruise - end))
    hold(1500, 0.0)
    return t - start
  }
}
