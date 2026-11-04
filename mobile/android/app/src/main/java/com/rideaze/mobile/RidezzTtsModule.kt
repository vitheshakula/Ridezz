package com.rideaze.mobile

import android.media.AudioManager
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

class RidezzTtsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {
  private var tts: TextToSpeech? = null
  private var ready = false
  private var failed = false
  private val pending = mutableListOf<Pair<String, Promise>>()
  private val inFlight = ConcurrentHashMap<String, Promise>()
  private val nextUtteranceId = AtomicInteger(0)

  override fun getName(): String = "RidezzTtsModule"

  @ReactMethod
  fun speak(text: String, promise: Promise) {
    val engine = tts
    when {
      failed ->
        promise.reject("tts_unavailable", "No usable text-to-speech engine on this device")
      ready && engine != null -> speakNow(engine, text, promise)
      else -> {
        pending.add(text to promise)
        if (engine == null) {
          initEngine()
        }
      }
    }
  }

  private fun initEngine() {
    tts =
      TextToSpeech(reactContext) { status ->
        val engine = tts
        if (status != TextToSpeech.SUCCESS || engine == null) {
          failed = true
          val queued = pending.toList()
          pending.clear()
          queued.forEach { (_, promise) ->
            promise.reject("tts_unavailable", "Text-to-speech engine failed to initialize")
          }
          return@TextToSpeech
        }
        engine.setLanguage(Locale.US)
        engine.setOnUtteranceProgressListener(
          object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}

            override fun onDone(utteranceId: String?) {
              inFlight.remove(utteranceId)?.resolve(null)
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
              inFlight.remove(utteranceId)?.reject("tts_speak_failed", "TextToSpeech playback failed")
            }
          },
        )
        ready = true
        val queued = pending.toList()
        pending.clear()
        queued.forEach { (text, promise) -> speakNow(engine, text, promise) }
      }
  }

  private fun speakNow(engine: TextToSpeech, text: String, promise: Promise) {
    val params =
      Bundle().apply {
        putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_VOICE_CALL)
      }
    val utteranceId = nextUtteranceId.getAndIncrement().toString()
    inFlight[utteranceId] = promise
    if (engine.speak(text, TextToSpeech.QUEUE_ADD, params, utteranceId) != TextToSpeech.SUCCESS) {
      inFlight.remove(utteranceId)?.reject("tts_speak_failed", "TextToSpeech.speak() was rejected by the engine")
    }
  }

  override fun invalidate() {
    tts?.stop()
    tts?.shutdown()
    tts = null
    ready = false
    failed = false
    pending.clear()
    val stillInFlight = inFlight.values.toList()
    inFlight.clear()
    stillInFlight.forEach { it.resolve(null) }
    super.invalidate()
  }
}

class RidezzTtsPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(RidezzTtsModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
