package com.rideaze.bench.core.measure

object Stats {
    /** Nearest-rank percentile (same definition as analysis/analyse_runs.py). Null for an empty list. */
    fun percentile(values: List<Long>, p: Int): Long? {
        if (values.isEmpty()) return null
        val s = values.sorted()
        val k = maxOf(1, Math.ceil(p / 100.0 * s.size).toInt())
        return s[k - 1]
    }
}
