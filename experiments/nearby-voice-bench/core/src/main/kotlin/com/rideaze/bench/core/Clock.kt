package com.rideaze.bench.core

/** Monotonic millisecond clock. Android: SystemClock.elapsedRealtime(). Tests: virtual time. */
fun interface MonotonicClock {
    fun nowMs(): Long
}

/** 32-bit unsigned millisecond arithmetic used by the wire protocol (wraps every ~49.7 days). */
object U32 {
    const val MOD: Long = 1L shl 32
    private const val HALF: Long = 1L shl 31

    fun wrap(x: Long): Long = x and 0xFFFFFFFFL

    /** Signed difference a - b interpreted modulo 2^32, result in [-2^31, 2^31). */
    fun signedDiff(a: Long, b: Long): Long {
        val d = (a - b) and 0xFFFFFFFFL
        return if (d >= HALF) d - MOD else d
    }
}
