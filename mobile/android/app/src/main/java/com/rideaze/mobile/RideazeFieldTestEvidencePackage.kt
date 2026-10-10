package com.rideaze.mobile

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class RideazeFieldTestEvidencePackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == RideazeFieldTestEvidenceModule.NAME) {
      RideazeFieldTestEvidenceModule(reactContext)
    } else {
      null
    }

  override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
    mapOf(
      RideazeFieldTestEvidenceModule.NAME to ReactModuleInfo(
        RideazeFieldTestEvidenceModule.NAME,
        RideazeFieldTestEvidenceModule::class.java.name,
        false,
        false,
        false,
        false,
      ),
    )
  }
}
