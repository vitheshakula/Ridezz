package com.rideaze.bench.core.measure

/**
 * One 1 Hz resource observation of the BENCH process and device. Every field is nullable: null means
 * "not available on this device/API level", never zero. Battery figures are indicative, not calibrated.
 *
 * Deliberately absent (no verified method): radio airtime, platform-level retransmissions, physical medium,
 * Google Play services CPU/memory (operator-side `adb shell dumpsys`, outside this app).
 */
data class ResourceSample(
    val cpuUserTicks: Long?,
    val cpuSystemTicks: Long?,
    val clockTicksPerSecond: Long?,
    val pssKb: Long?,
    val batteryPercent: Int?,
    val batteryChargeCounterUah: Long?,
    val batteryCurrentNowUa: Long?,
    val batteryTempDeciC: Int?,
    val thermalStatus: Int?,
    val powerSave: Boolean?,
    val screenInteractive: Boolean?,
    val wifiEnabled: Boolean?,
    val bluetoothEnabled: Boolean?,
) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "cpu_user_ticks" to cpuUserTicks, "cpu_system_ticks" to cpuSystemTicks, "clk_tck" to clockTicksPerSecond,
        "pss_kb" to pssKb, "batt_pct" to batteryPercent, "batt_charge_uah" to batteryChargeCounterUah,
        "batt_current_ua" to batteryCurrentNowUa, "batt_temp_deci_c" to batteryTempDeciC,
        "thermal_status" to thermalStatus, "power_save" to powerSave, "screen_on" to screenInteractive,
        "wifi_on" to wifiEnabled, "bt_on" to bluetoothEnabled,
    )

    companion object {
        val UNAVAILABLE_METRICS = listOf(
            "radio_airtime", "platform_retransmissions", "physical_medium", "play_services_cpu", "play_services_memory",
        )
    }
}

object ProcStat {
    /**
     * Parses `/proc/self/stat`: returns (utime, stime) in clock ticks. The comm field (2nd) is parenthesised and
     * may contain spaces or parentheses, so parsing starts after the LAST ')'. Fields after it start at field 3
     * (state), so utime/stime (fields 14/15) are indices 11/12 of the remainder.
     */
    fun parseCpuTicks(line: String): Pair<Long, Long>? {
        val close = line.lastIndexOf(')')
        if (close < 0) return null
        val rest = line.substring(close + 1).trim().split(' ').filter { it.isNotEmpty() }
        if (rest.size < 13) return null
        val u = rest[11].toLongOrNull() ?: return null
        val s = rest[12].toLongOrNull() ?: return null
        return u to s
    }
}
