package com.ridezz.mobile

import android.media.AudioAttributes
import android.media.SoundPool
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Plays short, pre-bundled tone cues (join/leave/disconnect/reconnect) through
 * whatever audio route the ongoing LiveKit call is already using.
 *
 * Uses SoundPool with USAGE_VOICE_COMMUNICATION_SIGNALLING -- the same attribute
 * Android itself uses for in-call tones like DTMF -- rather than a general media
 * stream. This rides the existing call's audio route (Bluetooth SCO, wired,
 * earpiece/speaker) automatically and, critically, does not request or abandon
 * audio focus and does not touch AudioManager mode, so it can never interrupt or
 * restart the already-running LiveKit AudioSession.
 */
class RidezzAudioCuesModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "RidezzAudioCues"

  // SoundPool.setOnLoadCompleteListener replaces any previous listener, so it's
  // registered exactly once here (not per playCue call) and dispatches to whichever
  // sound IDs are currently awaiting their first play -- otherwise two different
  // cues both loading for the first time in quick succession (e.g. a join right
  // before a reconnect) could clobber each other's "play once loaded" callback.
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

  // Loaded lazily and cached by cue name so a cold first play of each cue only
  // pays the (small, ~10KB) decode cost once per app process.
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
      // A cue failing to play is never worth surfacing to the rider -- it's a
      // non-essential notification, not the ride itself.
      promise.reject("audio_cue_play_failed", e.message, e)
    }
  }
}
