package com.rideaze.bench.core.run

/**
 * Why a run did not produce a clean measurement. Ordered by priority: a higher-priority class explains the
 * result first. Only TRANSPORT_LIMITATION is a statement about the transport, and even that is limited to the
 * tested conditions. A failed run is never, by itself, evidence that Nearby cannot carry voice.
 */
enum class FailureClass(val priority: Int) {
    NONE(0),
    TRANSPORT_LIMITATION(1),
    DEVICE_DEPENDENT(2),
    API(3),
    IMPLEMENTATION(4),
    CONFIGURATION(5),
}

enum class DeviceFlag {
    SCREEN_OFF, POWER_SAVE, THERMAL_SEVERE, BATTERY_LOW, PEER_DISCONNECTED, SERVICE_VERSION_CHANGED,
    PROCESS_RESTARTED, RADIO_DISABLED,
}

data class ClassifierInput(
    val configErrors: List<String> = emptyList(),
    val isolationBreaches: List<String> = emptyList(),
    val scenarioMismatch: Boolean = false,
    val invariantViolations: List<String> = emptyList(),
    val apiFailures: List<String> = emptyList(),
    val deviceFlags: Set<DeviceFlag> = emptySet(),
    val thresholdMisses: List<String> = emptyList(),
)

data class RunVerdict(val primary: FailureClass, val reasons: Map<FailureClass, List<String>>, val interpretation: String) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "failure_class" to primary.name,
        "reasons" to reasons.entries.sortedByDescending { it.key.priority }.associate { it.key.name to it.value },
        "interpretation" to interpretation,
    )
}

object RunClassifier {
    fun classify(i: ClassifierInput): RunVerdict {
        val r = LinkedHashMap<FailureClass, List<String>>()
        val cfg = i.configErrors + i.isolationBreaches + (if (i.scenarioMismatch) listOf("scenario fingerprint mismatch between phones") else emptyList())
        if (cfg.isNotEmpty()) r[FailureClass.CONFIGURATION] = cfg
        if (i.invariantViolations.isNotEmpty()) r[FailureClass.IMPLEMENTATION] = i.invariantViolations
        if (i.apiFailures.isNotEmpty()) r[FailureClass.API] = i.apiFailures
        if (i.deviceFlags.isNotEmpty()) r[FailureClass.DEVICE_DEPENDENT] = i.deviceFlags.map { it.name }.sorted()
        if (i.thresholdMisses.isNotEmpty()) r[FailureClass.TRANSPORT_LIMITATION] = i.thresholdMisses
        val primary = r.keys.maxByOrNull { it.priority } ?: FailureClass.NONE
        val text = when (primary) {
            FailureClass.NONE -> "Clean run. Targets met or not evaluated on this device."
            FailureClass.TRANSPORT_LIMITATION ->
                "Measured limitation under the tested conditions only. Not a general statement about Nearby: repeat (>=3 of 5), and check on a second device pair, before generalising."
            else ->
                "Run is INVALID for transport conclusions (${primary.name}). Do not read it as evidence that Nearby cannot support voice; fix the cause and repeat."
        }
        return RunVerdict(primary, r, text)
    }
}
