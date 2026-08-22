package com.ridezz.mobile

import android.view.WindowManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Toggles FLAG_KEEP_SCREEN_ON on the current Activity's window -- the standard
 * Android mechanism for "don't let the display sleep while this screen is
 * visible." Scoped to this Activity's window only: it does not touch the
 * system-wide display timeout setting, and is automatically void (Android
 * discards window flags) if the Activity is destroyed, so a crash or force-kill
 * can never leave the screen pinned on.
 */
class RidezzKeepAwakeModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RidezzKeepAwake"

  @ReactMethod
  fun enable(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("keep_awake_no_activity", "No current activity")
      return
    }
    UiThreadUtil.runOnUiThread {
      activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    promise.resolve(null)
  }

  @ReactMethod
  fun disable(promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("keep_awake_no_activity", "No current activity")
      return
    }
    UiThreadUtil.runOnUiThread {
      activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
    promise.resolve(null)
  }
}
