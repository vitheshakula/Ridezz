package com.rideaze.bench.core.platform

/**
 * Classifies Nearby status codes. DOCUMENTED (search snippet of the ConnectionsStatusCodes reference): STATUS_RADIO_ERROR = 8013
 * ("a problem using the phone's Bluetooth/Wi-Fi/NFC") and STATUS_BLUETOOTH_ERROR = 8007 (deprecated in favour of the radio
 * code). Every other code is reported as unknown rather than guessed. A radio error is an environment precondition failure
 * (radio off or unusable), not evidence about transport capacity.
 */
object NearbyStatus {
    const val STATUS_BLUETOOTH_ERROR = 8007
    const val STATUS_RADIO_ERROR = 8013

    data class Info(val code: Int?, val name: String, val radio: Boolean)

    fun describe(code: Int?): Info = when (code) {
        STATUS_RADIO_ERROR -> Info(code, "STATUS_RADIO_ERROR", true)
        STATUS_BLUETOOTH_ERROR -> Info(code, "STATUS_BLUETOOTH_ERROR(deprecated)", true)
        else -> Info(code, "UNKNOWN(${code ?: "none"})", false)
    }
}
