package com.rideaze.bench.core.platform

/** Radio / location-services state read from the device. null = could not be read (never silently treated as "on"). */
data class RadioState(val wifi: Boolean?, val bluetooth: Boolean?, val locationServices: Boolean?) {
    fun toMap(): Map<String, Any?> = linkedMapOf("wifi" to wifi, "bluetooth" to bluetooth, "location_services" to locationServices)
}

data class Readiness(val blockers: List<String>, val warnings: List<String>) {
    val ok: Boolean get() = blockers.isEmpty()
}

/**
 * Pre-pairing readiness check. The benchmark NEVER toggles a radio: it tells the operator what to switch on.
 *
 * Why this exists. DOCUMENTED (search snippets of the Android Developers Blog "Upcoming Changes to the Nearby Connections API",
 * primary page unreachable from the authoring environment): Nearby Connections will stop turning Wi-Fi and Bluetooth on
 * for apps (stated as late 2026, no exact date or Play services version found); apps must check and prompt.
 * ASSUMPTIONS (not verified against primary documentation): P2P_CLUSTER needs both Bluetooth and Wi-Fi enabled (Wi-Fi need
 * not be associated with an access point); location services are a hard requirement for BLE discovery only before Android 12
 * (SDK 31). From SDK 31 the app declares BLUETOOTH_SCAN with neverForLocation, like production, so a disabled location
 * service is reported as a warning, not a blocker.
 */
object ReadinessCheck {
    const val FIRST_SDK_WITHOUT_LOCATION_SERVICES_REQUIREMENT = 31

    fun evaluate(sdk: Int, s: RadioState): Readiness {
        val blockers = ArrayList<String>(); val warnings = ArrayList<String>()
        fun off(name: String, how: String) =
            "$name is OFF. Nearby Connections does not switch radios on for the app and this benchmark will not either. $how, then press Start pairing again."
        fun unknown(name: String) = "$name state could not be read; make sure it is ON (pairing will fail with a radio error otherwise)."

        when (s.bluetooth) {
            false -> blockers.add(off("Bluetooth", "Turn Bluetooth ON in Quick Settings"))
            null -> warnings.add(unknown("Bluetooth"))
            else -> {}
        }
        when (s.wifi) {
            false -> blockers.add(off("Wi-Fi", "Turn Wi-Fi ON in Quick Settings (it does not need to be connected to a network)"))
            null -> warnings.add(unknown("Wi-Fi"))
            else -> {}
        }
        when {
            s.locationServices == false && sdk < FIRST_SDK_WITHOUT_LOCATION_SERVICES_REQUIREMENT ->
                blockers.add(off("Location services", "Turn Location ON in Quick Settings (Android $sdk needs it for Bluetooth discovery)"))
            s.locationServices == false ->
                warnings.add("Location services are OFF. Not required on this Android version (assumption); if pairing fails, turn Location ON.")
            s.locationServices == null && sdk < FIRST_SDK_WITHOUT_LOCATION_SERVICES_REQUIREMENT -> warnings.add(unknown("Location services"))
            else -> {}
        }
        return Readiness(blockers, warnings)
    }
}
