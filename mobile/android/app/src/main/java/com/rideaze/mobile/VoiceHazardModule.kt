package com.rideaze.mobile

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import org.vosk.android.StorageService

/**
 * Offline, on-device speech recognition (Vosk) used for hazard-word detection. Works with zero
 * connectivity. Emits raw Vosk hypothesis JSON to JS:
 *   onSpeechPartial -> {"partial": "..."}    onSpeechResult -> {"text": "..."}
 *   onSpeechError   -> error message string
 * Keyword matching/dedup lives in JS (SpeechHazardService.ts).
 *
 * The model must be bundled at android/app/src/main/assets/vosk-model-small-en-us-0.15/ (it is
 * unpacked to app-private storage on first use).
 */
class VoiceHazardModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), RecognitionListener {

  companion object {
    private const val MODEL_ASSET_DIR = "vosk-model-small-en-us-0.15"
    private const val MODEL_TARGET_DIR = "vosk-model"
    private const val SAMPLE_RATE = 16000.0f
  }

  private val lock = Any()
  private var model: Model? = null
  private var speechService: SpeechService? = null
  private var unpacking = false
  // Set by start, cleared by stop -- lets a stop that arrives mid-unpack cancel the pending start.
  private var wantListening = false
  private val pendingStarts = mutableListOf<Promise>()

  override fun getName(): String = "VoiceHazardModule"

  @ReactMethod
  fun startListening(promise: Promise) {
    if (ContextCompat.checkSelfPermission(reactContext, Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("voice_permission_denied", "RECORD_AUDIO permission is required")
      return
    }

    var loaded: Model? = null
    synchronized(lock) {
      wantListening = true
      if (speechService != null) {
        promise.resolve(null)
        return
      }
      loaded = model
      if (loaded == null) {
        pendingStarts.add(promise)
        if (unpacking) return
        unpacking = true
      }
    }

    loaded?.let {
      beginRecognition(it, listOf(promise))
      return
    }

    StorageService.unpack(
      reactContext,
      MODEL_ASSET_DIR,
      MODEL_TARGET_DIR,
      { unpacked -> onModelReady(unpacked) },
      { e -> onModelFailed(e) },
    )
  }

  @ReactMethod
  fun stopListening(promise: Promise) {
    stopInternal()
    promise.resolve(null)
  }

  private fun onModelReady(unpacked: Model) {
    var waiting: List<Promise> = emptyList()
    synchronized(lock) {
      model = unpacked
      unpacking = false
      waiting = pendingStarts.toList()
      pendingStarts.clear()
    }
    beginRecognition(unpacked, waiting)
  }

  private fun onModelFailed(e: Exception) {
    var waiting: List<Promise> = emptyList()
    synchronized(lock) {
      unpacking = false
      waiting = pendingStarts.toList()
      pendingStarts.clear()
    }
    waiting.forEach {
      it.reject(
        "voice_model_unavailable",
        "Could not load Vosk model '$MODEL_ASSET_DIR' from assets: ${e.message}",
        e,
      )
    }
  }

  private fun beginRecognition(m: Model, promises: List<Promise>) {
    var failure: Exception? = null
    synchronized(lock) {
      // A stop may have arrived while the model was unpacking; then there is nothing to start.
      if (wantListening && speechService == null) {
        try {
          val service = SpeechService(Recognizer(m, SAMPLE_RATE), SAMPLE_RATE)
          service.startListening(this)
          speechService = service
        } catch (e: Exception) {
          failure = e
        }
      }
    }
    val error = failure
    promises.forEach {
      if (error == null) it.resolve(null) else it.reject("voice_start_failed", error.message, error)
    }
  }

  private fun stopInternal() {
    var service: SpeechService? = null
    synchronized(lock) {
      wantListening = false
      service = speechService
      speechService = null
    }
    service?.stop()
    service?.shutdown()
  }

  override fun invalidate() {
    stopInternal()
    synchronized(lock) {
      model?.close()
      model = null
    }
    super.invalidate()
  }

  private fun emit(event: String, payload: String?) {
    if (payload == null || !reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, payload)
  }

  // --- RecognitionListener ---
  override fun onPartialResult(hypothesis: String?) = emit("onSpeechPartial", hypothesis)

  override fun onResult(hypothesis: String?) = emit("onSpeechResult", hypothesis)

  override fun onFinalResult(hypothesis: String?) = emit("onSpeechResult", hypothesis)

  override fun onError(exception: Exception?) {
    emit("onSpeechError", exception?.message ?: "Speech recognition error")
    stopInternal()
  }

  override fun onTimeout() {}
}

class VoiceHazardPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(VoiceHazardModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
