package com.rideaze.mobile

import android.media.AudioAttributes
import android.media.SoundPool
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class RidezzAudioCuesModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "RidezzAudioCues"

  private val soundPool: SoundPool by lazy {
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION_SIGNALLING)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    SoundPool.Builder()
      .setMaxStreams(2)
      .setAudioAttributes(attributes)
      .build()
      .apply {
        setOnLoadCompleteListener { pool, id, status ->
          if (status == 0 && pendingPlayIds.remove(id)) {
            pool.play(id, 1f, 1f, 0, 0, 1f)
          }
        }
      }
  }

  private val soundIds = HashMap<String, Int>()
  private val pendingPlayIds = HashSet<Int>()

  private fun resourceIdFor(cueName: String): Int? {
    val resId = reactContext.resources.getIdentifier(cueName, "raw", reactContext.packageName)
    return if (resId != 0) resId else null
  }

  @ReactMethod
  fun playCue(cueName: String, promise: Promise) {
    try {
      val existingId = soundIds[cueName]
      if (existingId != null) {
        soundPool.play(existingId, 1f, 1f, 0, 0, 1f)
        promise.resolve(null)
        return
      }

      val resId = resourceIdFor(cueName)
      if (resId == null) {
        promise.reject("audio_cue_not_found", "No bundled cue named \"$cueName\"")
        return
      }

      val soundId = soundPool.load(reactContext, resId, 1)
      soundIds[cueName] = soundId
      pendingPlayIds.add(soundId)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("audio_cue_play_failed", e.message, e)
    }
  }
}
