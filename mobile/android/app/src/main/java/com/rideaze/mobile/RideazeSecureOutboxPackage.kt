package com.rideaze.mobile

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class RideazeSecureOutboxPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == RideazeSecureOutboxModule.NAME) RideazeSecureOutboxModule(reactContext) else null

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      RideazeSecureOutboxModule.NAME to ReactModuleInfo(
        RideazeSecureOutboxModule.NAME,
        RideazeSecureOutboxModule::class.java.name,
        false,
        false,
        false,
        false,
      ),
    )
  }
}
