package com.rideaze.bench.core.run

import com.rideaze.bench.core.measure.ResourceSample

/**
 * Turns 1 Hz resource samples into device-condition flags. A flag marks the run DEVICE_DEPENDENT (invalid for
 * transport conclusions): the OS or user changed conditions the benchmark assumes (screen on, no power saving,
 * radios enabled, no severe throttling).
 */
class DeviceFlagTracker {
    private val flags = LinkedHashSet<DeviceFlag>()

    companion object {
        /** android.os.PowerManager.THERMAL_STATUS_SEVERE */
        const val THERMAL_SEVERE = 3
        const val BATTERY_LOW_PERCENT = 15
    }

    @Synchronized fun observe(s: ResourceSample) {
        if (s.screenInteractive == false) flags.add(DeviceFlag.SCREEN_OFF)
        if (s.powerSave == true) flags.add(DeviceFlag.POWER_SAVE)
        if ((s.thermalStatus ?: 0) >= THERMAL_SEVERE) flags.add(DeviceFlag.THERMAL_SEVERE)
        if ((s.batteryPercent ?: 100) < BATTERY_LOW_PERCENT) flags.add(DeviceFlag.BATTERY_LOW)
        if (s.wifiEnabled == false || s.bluetoothEnabled == false) flags.add(DeviceFlag.RADIO_DISABLED)
    }

    /** Google Play services updating mid-campaign can change Nearby behaviour. */
    @Synchronized fun compareServiceVersion(before: String?, after: String?) {
        if (before != null && after != null && before != after) flags.add(DeviceFlag.SERVICE_VERSION_CHANGED)
    }

    @Synchronized fun flags(): Set<DeviceFlag> = flags.toSet()
}
