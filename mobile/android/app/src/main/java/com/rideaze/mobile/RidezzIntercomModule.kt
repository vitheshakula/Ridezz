package com.rideaze.mobile

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

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
