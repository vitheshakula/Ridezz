package com.rideaze.bench.measure

import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Debug
import android.os.PowerManager
import android.system.Os
import android.system.OsConstants
import com.rideaze.bench.core.measure.ProcStat
import com.rideaze.bench.core.measure.ResourceSample
import java.io.File

/**
 * Samples THIS process and the device. Returns null for anything the device does not expose.
 * Not collected (no verified method): radio airtime, platform retransmissions, physical medium, and
 * Google Play services CPU/memory (the operator can record those host-side with adb dumpsys).
 * Battery current/charge are indicative only: sign and units vary by device and are not calibrated.
 */
class AndroidResourceSampler(private val ctx: Context) {
    private val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    private val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    private val clkTck: Long? = runCatching { Os.sysconf(OsConstants._SC_CLK_TCK) }.getOrNull()

    fun sample(): ResourceSample {
        val ticks = runCatching { ProcStat.parseCpuTicks(File("/proc/self/stat").readText()) }.getOrNull()
        val pss = runCatching { Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }.totalPss.toLong() }.getOrNull()
        val batt: Intent? = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val temp = batt?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Int.MIN_VALUE)?.takeIf { it != Int.MIN_VALUE }
        return ResourceSample(
            cpuUserTicks = ticks?.first, cpuSystemTicks = ticks?.second, clockTicksPerSecond = clkTck, pssKb = pss,
            batteryPercent = prop(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.toInt(),
            batteryChargeCounterUah = prop(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER),
            batteryCurrentNowUa = prop(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW),
            batteryTempDeciC = temp,
            thermalStatus = if (Build.VERSION.SDK_INT >= 29) runCatching { pm.currentThermalStatus }.getOrNull() else null,
            powerSave = runCatching { pm.isPowerSaveMode }.getOrNull(),
            screenInteractive = runCatching { pm.isInteractive }.getOrNull(),
            wifiEnabled = runCatching { (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).isWifiEnabled }.getOrNull(),
            bluetoothEnabled = runCatching { (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter?.isEnabled }.getOrNull(),
        )
    }

    /** Integer battery property, or null if unsupported (BatteryManager returns Integer.MIN_VALUE / 0 for unsupported). */
    private fun prop(id: Int): Long? =
        runCatching { bm.getLongProperty(id) }.getOrNull()?.takeIf { it != Long.MIN_VALUE && it != Int.MIN_VALUE.toLong() }

    fun playServicesVersion(): String? =
        runCatching { ctx.packageManager.getPackageInfo("com.google.android.gms", 0).versionName }.getOrNull()
}
