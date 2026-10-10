package com.rideaze.mobile.crash

/**
 * Fixed-capacity circular buffer of 3-axis samples (t, x, y, z) kept in primitive arrays, so
 * sampling at 100-200 Hz allocates nothing. The oldest sample is overwritten when full. Index 0 is
 * the oldest retained sample.
 *
 * Capacity [IMU_RING_CAPACITY] holds just over 3 s at 200 Hz, so the seconds before an impact are
 * still available when the pipeline evaluates it. Not thread-safe: one thread owns it.
 */
class SampleRing(private val capacity: Int = IMU_RING_CAPACITY) {
  private val ts = LongArray(capacity)
  private val xs = DoubleArray(capacity)
  private val ys = DoubleArray(capacity)
  private val zs = DoubleArray(capacity)
  private var head = 0
  var size = 0
    private set

  fun add(t: Long, x: Double, y: Double, z: Double) {
    if (size == capacity) {
      head = (head + 1) % capacity
      size--
    }
    val i = (head + size) % capacity
    ts[i] = t
    xs[i] = x
    ys[i] = y
    zs[i] = z
    size++
  }

  fun clear() {
    head = 0
    size = 0
  }

  private fun at(index: Int): Int = (head + index) % capacity

  fun timeAt(index: Int): Long = ts[at(index)]

  fun xAt(index: Int): Double = xs[at(index)]

  fun yAt(index: Int): Double = ys[at(index)]

  fun zAt(index: Int): Double = zs[at(index)]

  fun magnitudeAt(index: Int): Double {
    val i = at(index)
    return Math.sqrt(xs[i] * xs[i] + ys[i] * ys[i] + zs[i] * zs[i])
  }

  /** Index of the first sample with time >= [sinceMs], or [size] if there is none. */
  fun firstIndexAtOrAfter(sinceMs: Long): Int {
    var i = size
    while (i > 0 && ts[at(i - 1)] >= sinceMs) {
      i--
    }
    return i
  }

  companion object {
    /** ~3.2 s at 200 Hz, ~6.4 s at the 100 Hz the app actually requests. */
    const val IMU_RING_CAPACITY = 640
  }
}
