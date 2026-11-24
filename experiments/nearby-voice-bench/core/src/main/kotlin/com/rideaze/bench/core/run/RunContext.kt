package com.rideaze.bench.core.run

/** What a session needs from its environment beyond the link: isolation findings, device state, platform API failures. */
interface RunContext {
    fun isolationBreaches(): List<String>
    /** Evaluated when the session finalises, so conditions that changed during the run (e.g. Play services update) are included. */
    fun deviceFlags(): Set<DeviceFlag>
    /** Platform API failures observed by the host at any time (pairing, advertising, accept...). Classified API. */
    fun apiFailures(): List<String> = emptyList()
    /** Environment preconditions that were not met (e.g. Nearby reported a radio error). Classified CONFIGURATION. */
    fun configErrors(): List<String> = emptyList()
    /** Must include "simulated" (true for the JVM fake link, false on a phone) so analysis never mixes them up. */
    fun deviceInfo(): Map<String, Any?>
}

object NoContext : RunContext {
    override fun isolationBreaches() = emptyList<String>()
    override fun deviceFlags() = emptySet<DeviceFlag>()
    override fun deviceInfo(): Map<String, Any?> = mapOf("model" to "jvm-test", "sdk" to 0, "simulated" to true)
}
