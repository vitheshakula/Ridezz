package com.rideaze.bench.measure

import android.bluetooth.BluetoothManager
import android.content.Context
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import com.rideaze.bench.core.platform.RadioState

/**
 * Reads (never changes) the radio and location-services state. A value that cannot be read is null, which the readiness check
 * reports as a warning instead of assuming "on". Requires ACCESS_WIFI_STATE; BluetoothAdapter.isEnabled needs no runtime permission
 * (assumption: if it throws SecurityException on some Android version the value is simply null).
 */
class AndroidRadioState(private val ctx: Context) {
    fun read(): RadioState = RadioState(
        wifi = runCatching { (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).isWifiEnabled }.getOrNull(),
        bluetooth = runCatching { (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter?.isEnabled }.getOrNull(),
        locationServices = runCatching {
            val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
            if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled
            else lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }.getOrNull(),
    )
}
