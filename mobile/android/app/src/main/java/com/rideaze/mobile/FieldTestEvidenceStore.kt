package com.rideaze.mobile

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.nio.charset.StandardCharsets

internal object FieldTestEvidencePolicy {
  fun validateEntry(serialized: String, maxEntryBytes: Int) {
    require(maxEntryBytes > 0) { "Evidence bound must be positive" }
    val bytes = serialized.toByteArray(StandardCharsets.UTF_8)
    require(bytes.isNotEmpty() && bytes.size <= maxEntryBytes) { "Evidence entry is too large" }
  }

  fun append(
    existing: List<String>,
    serialized: String,
    maxEntries: Int,
    maxEntryBytes: Int,
  ): List<String> {
    require(maxEntries > 0) { "Evidence bound must be positive" }
    validateEntry(serialized, maxEntryBytes)
    return (existing + serialized).takeLast(maxEntries)
  }
}

/**
 * Small app-private store for the offline connectivity field-test build. Entries are already
 * sanitized JSON objects; this class adds a hard size bound and rejects sensitive-field names.
 * It is intentionally separate from the encrypted delivery outbox.
 */
class FieldTestEvidenceStore(
  context: Context,
  private val enabled: Boolean,
  private val maxEntries: Int = MAX_ENTRIES,
  private val maxEntryBytes: Int = MAX_ENTRY_BYTES,
) {
  private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
  private val lock = Any()

  fun append(serialized: String) {
    check(enabled) { "Field-test evidence is disabled in this build" }
    FieldTestEvidencePolicy.validateEntry(serialized, maxEntryBytes)
    val value = JSONObject(serialized)
    require(!containsForbiddenKey(value)) { "Evidence entry contains a forbidden field" }

    synchronized(lock) {
      val entries = FieldTestEvidencePolicy.append(
        readLocked(),
        serialized,
        maxEntries,
        maxEntryBytes,
      )
      preferences.edit().putString(VALUE_KEY, JSONArray(entries).toString()).apply()
    }
  }

  fun read(): List<String> {
    check(enabled) { "Field-test evidence is disabled in this build" }
    return synchronized(lock) { readLocked().toList() }
  }

  fun clear() {
    check(enabled) { "Field-test evidence is disabled in this build" }
    synchronized(lock) {
      preferences.edit().remove(VALUE_KEY).apply()
    }
  }

  private fun readLocked(): MutableList<String> {
    val serialized = preferences.getString(VALUE_KEY, null) ?: return mutableListOf()
    return try {
      val array = JSONArray(serialized)
      MutableList(array.length()) { index -> array.getString(index) }
    } catch (_: Exception) {
      // Corrupt diagnostics must never affect the application or protocol.
      mutableListOf()
    }
  }

  private fun containsForbiddenKey(value: Any?): Boolean = when (value) {
    is JSONObject -> value.keys().asSequence().any { key ->
      key.lowercase() in FORBIDDEN_KEYS || containsForbiddenKey(value.opt(key))
    }
    is JSONArray -> (0 until value.length()).any { index -> containsForbiddenKey(value.opt(index)) }
    else -> false
  }

  companion object {
    const val MAX_ENTRIES = 512
    const val MAX_ENTRY_BYTES = 2_048
    private const val PREFERENCES = "rideaze_field_test_evidence"
    private const val VALUE_KEY = "events_v1"
    private val FORBIDDEN_KEYS = setOf(
      "payload",
      "location",
      "latitude",
      "longitude",
      "token",
      "credential",
      "email",
      "phone",
      "displayname",
      "rideid",
    )
  }
}
