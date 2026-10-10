package com.rideaze.mobile

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/** Native boundary for bounded evidence that exists only in the self-contained field-test build. */
class RideazeFieldTestEvidenceModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val store = FieldTestEvidenceStore(reactContext, BuildConfig.FIELD_TEST_TOOLS)

  override fun getName(): String = NAME

  override fun getConstants(): MutableMap<String, Any> =
    mutableMapOf("enabled" to BuildConfig.FIELD_TEST_TOOLS)

  @ReactMethod
  fun append(serialized: String, promise: Promise) {
    try {
      store.append(serialized)
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("field_test_evidence_rejected", "Evidence entry was rejected")
    }
  }

  @ReactMethod
  fun read(promise: Promise) {
    try {
      val result = Arguments.createArray()
      store.read().forEach(result::pushString)
      promise.resolve(result)
    } catch (_: Exception) {
      promise.reject("field_test_evidence_unavailable", "Evidence is unavailable in this build")
    }
  }

  @ReactMethod
  fun clear(promise: Promise) {
    try {
      store.clear()
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("field_test_evidence_unavailable", "Evidence is unavailable in this build")
    }
  }

  /** Prints sanitized records after USB reconnection; no active Logcat stream is required. */
  @ReactMethod
  fun printToLogcat(promise: Promise) {
    try {
      val entries = store.read()
      Log.i(LOG_TAG, "BEGIN count=${entries.size}")
      entries.forEachIndexed { index, entry -> Log.i(LOG_TAG, "EVENT ${index + 1} $entry") }
      Log.i(LOG_TAG, "END count=${entries.size}")
      promise.resolve(entries.size)
    } catch (_: Exception) {
      promise.reject("field_test_evidence_unavailable", "Evidence is unavailable in this build")
    }
  }

  companion object {
    const val NAME = "RideazeFieldTestEvidence"
    private const val LOG_TAG = "RideazeFieldEvidence"
  }
}
