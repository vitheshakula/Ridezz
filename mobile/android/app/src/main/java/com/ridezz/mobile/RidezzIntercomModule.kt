package com.ridezz.mobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS-callable start/stop for RidezzIntercomService. Errors are surfaced as rejected promises
 * rather than swallowed, so the JS side can show the rider a real error instead of silently
 * running without background survival.
 */
class RidezzIntercomModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RidezzIntercomService"

  @ReactMethod
  fun startIntercomService(promise: Promise) {
    try {
      RidezzIntercomService.start(reactApplicationContext)
      promise.resolve(null)
    } catch (e: SecurityException) {
      promise.reject("intercom_service_security_error", e.message, e)
    } catch (e: IllegalStateException) {
      // e.g. ForegroundServiceStartNotAllowedException on API 31+ when not called from a
      // foreground context -- shouldn't happen given how we call this, but don't hide it.
      promise.reject("intercom_service_start_not_allowed", e.message, e)
    } catch (e: Exception) {
      promise.reject("intercom_service_start_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stopIntercomService(promise: Promise) {
    try {
      RidezzIntercomService.stop(reactApplicationContext)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("intercom_service_stop_failed", e.message, e)
    }
  }
}
