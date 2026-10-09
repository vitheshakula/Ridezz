package com.rideaze.mobile.crash

import android.content.pm.ApplicationInfo
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.rideaze.mobile.RidezzIntercomService

/**
 * JS bridge for crash / laydown detection (native module name `CrashDetection`).
 *
 * Methods (all return Promises):
 *   startMonitoring(options?)   -> { accelMaxRangeG, hasGyroscope, hasGravity, gnss, samplingHz,
 *                                    foregroundServiceActive, alreadyRunning }
 *   stopMonitoring()            -- also drops any running countdown WITHOUT sending an alert
 *   cancelCrashAlert()          -> boolean   "I'm OK" (tap or voice): cancels a running countdown
 *   sendAlertNow()              -> boolean   skip the rest of the countdown and alert now
 *   acknowledgeAlert()          -> boolean   dismiss the "alert sent" state
 *   calibrateRidingAngle()      -> { success, reason?, deltaDeg? }   pin the riding reference
 *   clearRidingCalibration()    -> boolean   back to automatic reference learning
 *   consumePendingSos()         -> SOS payload | null   an alert whose event may have been missed
 *   getStatus()                 -> { monitoring, phase, ... }
 *   simulateCrash()             -- debuggable builds only
 *
 * Events (DeviceEventEmitter):
 *   onCrashCandidateDetected  { countdownMs, confidence, severity, path, evidence }
 *                             every pipeline stage agreed; start the "Are you OK?" countdown UI
 *   onCrashCancelled          { reason }      "user" | "riding_resumed"
 *   onCountdownExpired        SOS payload     dispatch to the mesh / cloud layer (see SosPayload)
 *   onCrashStateChanged       { phase }       idle | countdown | sos | cancelled
 *   onCrashDecision           { outcome, ... }   every finished candidate, for tuning
 *   onCrashMonitorStatus      { sensorsStalled, gnss }
 *
 * The countdown is owned by the native side and keeps running if JS is busy; if the alert fires
 * while no React instance is attached, it is held and returned by consumePendingSos().
 */
class CrashDetectionModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), CrashMonitor.Listener {

  companion object {
    private const val SAMPLING_HZ = 100
  }

  private val monitor = CrashMonitor(reactContext, this)

  @Volatile private var pendingSos: SosPayload? = null
  @Volatile private var lastPhase = CrashPhase.IDLE
  @Volatile private var calibrationPromise: Promise? = null

  override fun getName(): String = "CrashDetection"

  // --- JS API -------------------------------------------------------------------------------

  @ReactMethod
  fun startMonitoring(options: ReadableMap?, promise: Promise) {
    val wasRunning = monitor.isRunning
    try {
      val info = monitor.start(configFrom(options))
      val caps = info.capabilities
      val map = Arguments.createMap()
      map.putDouble("accelMaxRangeG", caps.accelMaxRange / STANDARD_GRAVITY)
      map.putBoolean("hasGyroscope", caps.hasGyroscope)
      map.putBoolean("hasGravity", caps.hasGravity)
      map.putString("gnss", info.gnss.wire)
      map.putInt("samplingHz", SAMPLING_HZ)
      // False means Android may freeze the process once the app is backgrounded.
      map.putBoolean("foregroundServiceActive", RidezzIntercomService.isRunning)
      map.putBoolean("alreadyRunning", wasRunning)
      promise.resolve(map)
    } catch (e: CrashMonitor.UnsupportedDeviceException) {
      promise.reject(e.code, e.message, e)
    } catch (e: Exception) {
      promise.reject("crash_start_failed", e.message, e)
    }
  }

  @ReactMethod
  fun stopMonitoring(promise: Promise) {
    monitor.stop()
    lastPhase = CrashPhase.IDLE
    failCalibration("interrupted")
    promise.resolve(null)
  }

  @ReactMethod
  fun cancelCrashAlert(promise: Promise) {
    monitor.cancel("user") { promise.resolve(it) }
  }

  @ReactMethod
  fun sendAlertNow(promise: Promise) {
    monitor.sendNow { promise.resolve(it) }
  }

  @ReactMethod
  fun acknowledgeAlert(promise: Promise) {
    monitor.acknowledge { promise.resolve(it) }
  }

  @ReactMethod
  fun calibrateRidingAngle(promise: Promise) {
    if (calibrationPromise != null) {
      promise.resolve(calibrationMap(CalibrationResult(false, "busy")))
      return
    }
    calibrationPromise = promise
    monitor.calibrate { started ->
      if (!started) failCalibration("not_monitoring")
    }
  }

  @ReactMethod
  fun clearRidingCalibration(promise: Promise) {
    monitor.clearCalibration { promise.resolve(it) }
  }

  @ReactMethod
  fun consumePendingSos(promise: Promise) {
    val sos = pendingSos
    pendingSos = null
    promise.resolve(sos?.let { sosMap(it) })
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    val status = monitor.status()
    monitor.currentState { state ->
      val map = Arguments.createMap()
      map.putBoolean("monitoring", monitor.isRunning)
      map.putString("phase", (state?.phase ?: CrashPhase.IDLE).wire)
      map.putBoolean("sensorsStalled", status.sensorsStalled)
      map.putString("gnss", status.gnss.wire)
      map.putBoolean("foregroundServiceActive", RidezzIntercomService.isRunning)
      map.putBoolean("pendingSos", pendingSos != null)
      promise.resolve(map)
    }
  }

  @ReactMethod
  fun simulateCrash(promise: Promise) {
    val debuggable = (reactContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
    if (!debuggable) {
      promise.reject("crash_simulate_disabled", "simulateCrash is only available in debug builds")
      return
    }
    monitor.simulate { ok ->
      if (ok) promise.resolve(null)
      else promise.reject("crash_not_monitoring", "Crash monitoring is not running")
    }
  }

  override fun invalidate() {
    monitor.stop()
    failCalibration("interrupted")
    super.invalidate()
  }

  // --- CrashDetectorListener (sensor thread) ------------------------------------------------

  override fun onStateChanged(state: CrashState) {
    val previous = lastPhase
    lastPhase = state.phase
    if (previous == state.phase && state.phase != CrashPhase.COUNTDOWN) return

    emit("onCrashStateChanged", Arguments.createMap().apply { putString("phase", state.phase.wire) })
    when (state.phase) {
      CrashPhase.COUNTDOWN -> emit("onCrashCandidateDetected", candidateMap(state))
      CrashPhase.CANCELLED ->
        emit(
          "onCrashCancelled",
          Arguments.createMap().apply { putString("reason", state.cancelReason ?: "user") },
        )
      else -> Unit
    }
  }

  override fun onCountdownExpired(sos: SosPayload) {
    // Held until JS consumes it, so a missed event (no React instance attached) is not lost.
    pendingSos = sos
    emit("onCountdownExpired", sosMap(sos))
  }

  override fun onDecision(decision: CrashDecision) {
    val map = Arguments.createMap()
    map.putDouble("at", decision.at.toDouble())
    when (decision) {
      is CrashDecision.Confirmed -> {
        map.putString("outcome", "confirmed")
        map.putMap("evidence", evidenceMap(decision.evidence))
      }
      is CrashDecision.Rejected -> {
        map.putString("outcome", "rejected")
        map.putString("reason", decision.reason.wire)
        map.putDouble("peakG", decision.peakG)
      }
    }
    emit("onCrashDecision", map)
  }

  override fun onCalibration(result: CalibrationResult) {
    val promise = calibrationPromise ?: return
    calibrationPromise = null
    promise.resolve(calibrationMap(result))
  }

  override fun onMonitorStatus(status: CrashMonitor.MonitorStatus) {
    emit(
      "onCrashMonitorStatus",
      Arguments.createMap().apply {
        putBoolean("sensorsStalled", status.sensorsStalled)
        putString("gnss", status.gnss.wire)
      },
    )
  }

  // --- helpers ------------------------------------------------------------------------------

  private fun failCalibration(reason: String) {
    val promise = calibrationPromise ?: return
    calibrationPromise = null
    promise.resolve(calibrationMap(CalibrationResult(false, reason)))
  }

  private fun emit(event: String, payload: WritableMap) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, payload)
  }

  /** Optional tuning overrides from JS; anything absent or out of range keeps its default. */
  private fun configFrom(options: ReadableMap?): CrashConfig {
    var config = CrashConfig()
    if (options == null) return config
    fun number(key: String, min: Double, max: Double): Double? =
      if (options.hasKey(key) && !options.isNull(key)) {
        options.getDouble(key).takeIf { it in min..max }
      } else {
        null
      }
    number("impactG", 2.0, 8.0)?.let { config = config.copy(impactG = it) }
    number("rotationRadS", 1.0, 20.0)?.let { config = config.copy(rotationRadS = it) }
    number("tiltDeg", 30.0, 90.0)?.let { config = config.copy(tiltDeg = it) }
    number("countdownSeconds", 10.0, 60.0)?.let {
      val ms = (it * 1000).toLong()
      config = config.copy(countdownMsHigh = ms, countdownMsMedium = (ms * 3) / 2)
    }
    if (options.hasKey("enableLowSpeedLaydown") && !options.isNull("enableLowSpeedLaydown")) {
      config = config.copy(enableLowSpeedLaydown = options.getBoolean("enableLowSpeedLaydown"))
    }
    return config
  }

  private fun evidenceMap(e: CrashEvidence): WritableMap =
    Arguments.createMap().apply {
      putString("path", e.path.wire)
      putString("confidence", e.confidence.wire)
      putDouble("impactAt", e.impactAt.toDouble())
      putDouble("peakG", e.peakG)
      e.maxGyroRadS?.let { putDouble("maxGyroRadS", it) } ?: putNull("maxGyroRadS")
      e.tiltDeg?.let { putDouble("tiltDeg", it) } ?: putNull("tiltDeg")
      e.preSpeedMps?.let { putDouble("preSpeedMps", it) } ?: putNull("preSpeedMps")
      e.postSpeedMps?.let { putDouble("postSpeedMps", it) } ?: putNull("postSpeedMps")
      putDouble("stillMs", e.stillMs.toDouble())
      putBoolean("freeFallBeforeImpact", e.freeFallBeforeImpact)
    }

  private fun candidateMap(state: CrashState): WritableMap =
    Arguments.createMap().apply {
      // Remaining time, not an absolute timestamp: JS counts down on its own clock.
      putDouble("countdownMs", (state.countdownMs ?: 0L).toDouble())
      putString("confidence", (state.confidence ?: CrashConfidence.MEDIUM).wire)
      putString("severity", state.severity ?: "UNKNOWN")
      putString("path", (state.evidence?.path ?: CrashPath.MANUAL).wire)
      state.evidence?.let { putMap("evidence", evidenceMap(it)) }
    }

  private fun sosMap(s: SosPayload): WritableMap =
    Arguments.createMap().apply {
      putString("sosId", s.sosId)
      putDouble("timestamp", s.timestamp.toDouble())
      putDouble("impactTimestamp", s.impactTimestamp.toDouble())
      s.latitude?.let { putDouble("latitude", it) } ?: putNull("latitude")
      s.longitude?.let { putDouble("longitude", it) } ?: putNull("longitude")
      s.locationAgeMs?.let { putDouble("locationAgeMs", it.toDouble()) } ?: putNull("locationAgeMs")
      s.speedBeforeImpactMps?.let {
        putDouble("speedBeforeImpactMps", it)
        putDouble("speedBeforeImpactKmh", it * 3.6)
      }
        ?: run {
          putNull("speedBeforeImpactMps")
          putNull("speedBeforeImpactKmh")
        }
      putString("severity", s.severity)
      putString("confidence", s.confidence.wire)
      putString("path", s.path.wire)
      putDouble("peakG", s.peakG)
      putString("trigger", s.trigger)
    }

  private fun calibrationMap(r: CalibrationResult): WritableMap =
    Arguments.createMap().apply {
      putBoolean("success", r.success)
      r.reason?.let { putString("reason", it) } ?: putNull("reason")
      r.deltaDeg?.let { putDouble("deltaDeg", it) } ?: putNull("deltaDeg")
    }
}
