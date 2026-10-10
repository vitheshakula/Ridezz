package com.rideaze.mobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DebugLinkFilterTest {
  private val c = "3f9a1b2c" // a native rider id: UUID().toString().take(8)
  private val b = "7d00e4aa"

  @Test
  fun disabledByDefault() {
    val filter = DebugLinkFilter(debuggable = true)
    assertTrue(filter.snapshot().isEmpty())
    assertTrue(filter.allows(c))
    assertTrue(filter.allows(b))
  }

  @Test
  fun emptyListAllowsNormalConnections() {
    val filter = DebugLinkFilter(debuggable = true)
    assertTrue(filter.configure(listOf("")))
    assertTrue(filter.allows(c))
    assertTrue(filter.deniedEndpoints(mapOf("EP01" to c, "EP02" to b)).isEmpty())
  }

  @Test
  fun deniedRiderIsNeitherDialledNorAccepted() {
    // The dial path (connectToDiscovered) and the accept path (onConnectionInitiated) both ask
    // allows() with the advertised rider id; the wiring guard below pins both call sites.
    val filter = DebugLinkFilter(debuggable = true)
    assertTrue(filter.configure(listOf(c)))
    assertFalse(filter.allows(c))
    assertTrue(filter.allows(b))
    assertEquals(setOf(c), filter.snapshot())
  }

  @Test
  fun existingDeniedConnectionsAreSelectedForDisconnect() {
    val filter = DebugLinkFilter(debuggable = true)
    filter.configure(listOf(c, "  $b  "))
    val links = mapOf("EP03" to c, "EP01" to "11112222", "EP02" to b, "EP04" to "")
    assertEquals(listOf("EP02", "EP03"), filter.deniedEndpoints(links))
  }

  @Test
  fun reconfiguringReplacesTheList() {
    val filter = DebugLinkFilter(debuggable = true)
    filter.configure(listOf(c))
    filter.configure(listOf(b))
    assertTrue(filter.allows(c))
    assertFalse(filter.allows(b))
  }

  @Test
  fun resetClearsTheListAndReportsWhetherItWasActive() {
    val filter = DebugLinkFilter(debuggable = true)
    assertFalse(filter.reset())
    filter.configure(listOf(c))
    assertTrue(filter.reset())
    assertTrue(filter.allows(c))
    assertTrue(filter.snapshot().isEmpty())
  }

  @Test
  fun nonDebuggableBuildRefusesConfigurationAndDeniesNothing() {
    val filter = DebugLinkFilter(debuggable = false)
    assertFalse(filter.configure(listOf(c, b)))
    assertTrue(filter.snapshot().isEmpty())
    assertTrue(filter.allows(c))
    assertTrue(filter.deniedEndpoints(mapOf("EP01" to c)).isEmpty())
  }

  @Test
  fun legacyBehaviourWhenDisabled() {
    val filter = DebugLinkFilter(debuggable = true)
    // Unknown/blank ids and malformed entries never block anything.
    assertTrue(filter.allows(null))
    assertTrue(filter.allows(""))
    assertTrue(filter.configure(listOf("not a rider id!", "x".repeat(40), "")))
    assertTrue(filter.snapshot().isEmpty())
    assertTrue(filter.allows("not a rider id!"))
  }

  /** Pins the module wiring, which needs React Native and Nearby and cannot run on the JVM. */
  @Test
  fun moduleWiringGuard() {
    val source = File("src/main/java/com/rideaze/mobile/NearbyMeshModule.kt").readText()
    // Outgoing: denied riders are skipped when dialling discovered endpoints.
    val dial = source.substringAfter("private fun connectToDiscovered()").substringBefore("Log.d(")
    assertTrue("dial path must consult the filter", dial.contains("!linkFilter.allows(remoteId)"))
    // Incoming: denied riders are rejected before being accepted.
    val accept = source.substringAfter("override fun onConnectionInitiated")
      .substringBefore("acceptConnection(")
    assertTrue(
      "accept path must reject denied riders",
      accept.contains("!linkFilter.allows(parsed.second)") && accept.contains("rejectConnection"),
    )
    // Reset on stop.
    val stop = source.substringAfter("private fun stopInternal()").substringBefore("override fun")
    assertTrue("stopInternal must reset the filter", stop.contains("linkFilter.reset()"))
    // Debug-only: the receiver is registered only after the debuggable check.
    val init = source.substringAfter("override fun initialize()").substringBefore("registerReceiver(")
    assertTrue("receiver must be debug-only", init.contains("if (!debuggable) return"))
    assertTrue(
      "debuggable must come from FLAG_DEBUGGABLE",
      source.contains("ApplicationInfo.FLAG_DEBUGGABLE"),
    )
  }
}
