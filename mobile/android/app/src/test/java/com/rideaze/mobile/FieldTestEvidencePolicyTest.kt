package com.rideaze.mobile

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FieldTestEvidencePolicyTest {
  @Test
  fun keepsNewestEntriesWithinBound() {
    val result = FieldTestEvidencePolicy.append(
      listOf("one", "two", "three"),
      "four",
      maxEntries = 3,
      maxEntryBytes = 32,
    )
    assertEquals(listOf("two", "three", "four"), result)
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsOversizedEntry() {
    FieldTestEvidencePolicy.append(emptyList(), "12345", maxEntries = 3, maxEntryBytes = 4)
  }

  @Test
  fun buildVariantBoundaryAndStorageGuardsArePinned() {
    val gradle = File("build.gradle").readText()
    val debuggableBlock = gradle
      .substringAfter("debuggableVariants = [")
      .substringBefore("]")
    val debuggableVariants = Regex("\"([^\"]+)\"")
      .findAll(debuggableBlock)
      .map { match -> match.groupValues[1] }
      .toSet()
    val expectedDevelopmentDebugVariants = setOf(
      "devDevelopmentDebug",
      "stagingDevelopmentDebug",
      "prodDevelopmentDebug",
    )
    val fieldBlock = gradle.substringAfter("fieldTest {").substringBefore("release {")
    val fieldToolsDisabled = "buildConfigField \"boolean\", \"FIELD_TEST_TOOLS\", \"false\""
    val fieldToolsEnabled = "buildConfigField \"boolean\", \"FIELD_TEST_TOOLS\", \"true\""

    assertTrue(
      "all DevelopmentDebug variants must retain Metro behavior",
      debuggableVariants.containsAll(expectedDevelopmentDebugVariants),
    )
    assertTrue(
      "field-test variants must bundle JavaScript",
      debuggableVariants.none { variant -> variant.contains("FieldTest", ignoreCase = true) },
    )
    assertTrue(
      "release variants must bundle JavaScript",
      debuggableVariants.none { variant -> variant.contains("Release", ignoreCase = true) },
    )
    assertTrue(gradle.contains(fieldToolsDisabled))
    assertTrue(fieldBlock.contains(fieldToolsEnabled))
    assertEquals(
      "FIELD_TEST_TOOLS may be enabled only by the fieldTest build type",
      1,
      Regex(Regex.escape(fieldToolsEnabled)).findAll(gradle).count(),
    )
    assertTrue(fieldBlock.contains("signingConfig signingConfigs.debug"))

    val module = File(
      "src/main/java/com/rideaze/mobile/RideazeFieldTestEvidenceModule.kt",
    ).readText()
    assertTrue(module.contains("BuildConfig.FIELD_TEST_TOOLS"))
    assertFalse(module.contains("BroadcastReceiver"))

    val store = File("src/main/java/com/rideaze/mobile/FieldTestEvidenceStore.kt").readText()
    assertTrue(store.contains("MAX_ENTRIES = 512"))
    assertTrue(store.contains("containsForbiddenKey"))
    assertTrue(store.contains("\"payload\""))
    assertTrue(store.contains("\"latitude\""))
    assertTrue(store.contains("\"token\""))
  }
}
