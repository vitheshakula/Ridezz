package com.rideaze.mobile

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Process
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.StorageService

class VoiceHazardModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {
  companion object {
    private const val MODEL_ASSET_DIR = "vosk-model-small-en-us-0.15"
    private const val MODEL_TARGET_DIR = "vosk-model"
    private const val GRAMMAR_ASSET = "vosk-grammar.json"
    private const val SAMPLE_RATE_HZ = 16000
    private const val SAMPLE_RATE = 16000.0f
    private const val CHUNK_SAMPLES = SAMPLE_RATE_HZ / 10
    private const val STOP_JOIN_MS = 2000L
    private const val TAG = "VoiceHazard"
  }

  private val lock = Any()
  private var model: Model? = null
  private var worker: Thread? = null
  private var unpacking = false
  @Volatile private var wantListening = false
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
      if (worker?.isAlive == true) {
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
    var started = false
    synchronized(lock) {
      if (wantListening && worker?.isAlive != true) {
        worker = Thread({ run(m, promises) }, "vosk-hazard").also { it.start() }
        started = true
      }
    }
    if (!started) promises.forEach { it.resolve(null) }
  }

  private fun run(m: Model, promises: List<Promise>) {
    Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO)
    var free: Recognizer? = null
    var grammar: Recognizer? = null
    var record: AudioRecord? = null
    var started = false
    try {
      free = Recognizer(m, SAMPLE_RATE).also { it.setWords(true) }
      grammar = newGrammarRecognizer(m)

      val minBytes = AudioRecord.getMinBufferSize(
        SAMPLE_RATE_HZ, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
      )
      if (minBytes <= 0) throw IllegalStateException("AudioRecord rejects 16 kHz mono PCM16")
      record = AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        SAMPLE_RATE_HZ,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBytes, CHUNK_SAMPLES * 2 * 4),
      )
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        throw IllegalStateException("Microphone is unavailable (AudioRecord not initialized)")
      }

      if (wantListening) {
        record.startRecording()
        started = true
      }
      promises.forEach { it.resolve(null) }

      val buf = ShortArray(CHUNK_SAMPLES)
      while (wantListening && started) {
        val n = record.read(buf, 0, buf.size)
        if (n < 0) throw IllegalStateException("AudioRecord.read failed ($n)")
        if (n == 0) continue
        if (free.acceptWaveForm(buf, n)) emitResult("free", free.result)
        grammar?.let { if (it.acceptWaveForm(buf, n)) emitResult("grammar", it.result) }
      }
    } catch (t: Throwable) {
      if (started) {
        emit("onSpeechError", t.message ?: "Speech recognition error")
      } else {
        promises.forEach { it.reject("voice_start_failed", t.message ?: t.javaClass.simpleName, t) }
      }
    } finally {
      try {
        if (started) record?.stop()
      } catch (_: Exception) {}
      record?.release()
      grammar?.close()
      free?.close()
      synchronized(lock) {
        if (worker === Thread.currentThread()) worker = null
      }
    }
  }

  private fun newGrammarRecognizer(m: Model): Recognizer? =
    try {
      val grammar = reactContext.assets.open(GRAMMAR_ASSET).bufferedReader().use { it.readText() }
      Recognizer(m, SAMPLE_RATE, grammar).also { it.setWords(true) }
    } catch (e: Exception) {
      Log.w(TAG, "vosk grammar unavailable, using the full vocabulary only: ${e.message}")
      null
    }

  private fun emitResult(source: String, json: String?) {
    if (json == null) return
    try {
      val result = JSONObject(json)
      if (result.optString("text").isEmpty()) return
      emit("onSpeechResult", result.put("source", source).toString())
    } catch (e: Exception) {
      Log.w(TAG, "could not read a $source result: ${e.message}")
    }
  }

  private fun stopInternal() {
    val t: Thread?
    synchronized(lock) {
      wantListening = false
      t = worker
    }
    if (t != null && t !== Thread.currentThread()) {
      try {
        t.join(STOP_JOIN_MS)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
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
}

class VoiceHazardPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(VoiceHazardModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
