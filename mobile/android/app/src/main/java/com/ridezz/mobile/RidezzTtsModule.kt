package com.ridezz.mobile

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

/**
 * Reads a hazard alert aloud through whatever audio route the ride's LiveKit call is already
 * using (helmet Bluetooth SCO, wired, or phone speaker), via Android's built-in text-to-speech
 * engine -- so a rider doesn't have to look at the screen to hear "Alex. Pothole. Please slow
 * down." Speech is spoken on STREAM_VOICE_CALL so it follows the same SCO route RideScreen's
 * AudioSession already established for the intercom, instead of the separate media stream.
 *
 * `speak()`'s promise resolves only once the utterance has actually finished playing (or failed),
 * not merely once it's queued -- JS uses that to duck other riders' call audio for exactly the
 * duration of the announcement and restore it once the promise settles (see
 * SpeechHazardService.speakHazardAudio / RideScreen's duckRemoteAudio).
 *
 * Utterances queue (QUEUE_ADD): several hazards arriving close together are read out one after
 * another instead of talking over or cutting each other off. Calls made before the engine
 * finishes initializing are held and flushed once it's ready; if the device has no usable engine
 * or voice, they're dropped -- a missed announcement is never worth surfacing as an error (the
 * hazard banner in JS is shown either way, independent of this).
 */
class RidezzTtsModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private var tts: TextToSpeech? = null
  private var ready = false
  private var failed = false
  private val pending = mutableListOf<Pair<String, Promise>>()
  // Keyed by utteranceId; resolved/rejected from the progress listener once speech finishes.
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
        // An unsupported/missing language pack still leaves a default voice able to speak --
        // not worth failing the whole feature over.
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
        // Routes through the same audio path as the intercom call (Bluetooth SCO / wired /
        // earpiece) instead of the media stream, so it's heard through the rider's headset.
        putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_VOICE_CALL)
      }
    val utteranceId = nextUtteranceId.getAndIncrement().toString()
    inFlight[utteranceId] = promise
    // A rejection here means the engine never queued it at all, so no onDone/onError will ever
    // arrive for this id -- settle (and remove) the promise ourselves rather than leaving it
    // hanging, which would otherwise duck the call audio forever.
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
    // Settle anything still in flight so a caller awaiting it (e.g. to un-duck call audio) isn't
    // left hanging because the module was torn down mid-utterance.
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
