package com.rideaze.bench.core.platform

/**
 * Runtime permissions the operator screen must request, per Android API level. The manifest must declare every one of
 * them for every SDK where it is requested (a test cross-checks this against app/src/main/AndroidManifest.xml).
 *
 * Provenance. DOCUMENTED (search snippets of Google's Nearby "Get started" guide): location and Bluetooth permissions are
 * runtime requests; BLUETOOTH_ADVERTISE/CONNECT/SCAN from Android 12 (SDK 31); only location before that.
 * ASSUMPTIONS: ACCESS_COARSE_LOCATION must be requested together with ACCESS_FINE_LOCATION on SDK 31-32 because the app targets
 * SDK 36 (Android platform rule, recalled); NEARBY_WIFI_DEVICES from SDK 33 (production Rideaze declares it; the guide's text was
 * not retrievable); POST_NOTIFICATIONS (SDK 33) is for the bench's foreground-service notification, not for Nearby.
 */
object PermissionPlan {
    const val BLUETOOTH_ADVERTISE = "android.permission.BLUETOOTH_ADVERTISE"
    const val BLUETOOTH_CONNECT = "android.permission.BLUETOOTH_CONNECT"
    const val BLUETOOTH_SCAN = "android.permission.BLUETOOTH_SCAN"
    const val FINE_LOCATION = "android.permission.ACCESS_FINE_LOCATION"
    const val COARSE_LOCATION = "android.permission.ACCESS_COARSE_LOCATION"
    const val NEARBY_WIFI_DEVICES = "android.permission.NEARBY_WIFI_DEVICES"
    const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"

    /** Last SDK on which the location permissions are requested. */
    const val LAST_SDK_WITH_LOCATION_PERMISSION = 32

    fun runtimePermissions(sdk: Int): List<String> {
        val l = ArrayList<String>()
        if (sdk >= 31) l += listOf(BLUETOOTH_ADVERTISE, BLUETOOTH_CONNECT, BLUETOOTH_SCAN)
        if (sdk <= LAST_SDK_WITH_LOCATION_PERMISSION) l += listOf(FINE_LOCATION, COARSE_LOCATION)
        if (sdk >= 33) l += listOf(NEARBY_WIFI_DEVICES, POST_NOTIFICATIONS)
        return l
    }
}
