package com.rideaze.mobile.crash

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock

class EpochClock {
  private val offsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()

  fun now(): Long = SystemClock.elapsedRealtime() + offsetMs

  fun fromElapsedNanos(nanos: Long): Long = nanos / 1_000_000L + offsetMs
}

interface ImuSink {
  fun onAccel(t: Long, x: Double, y: Double, z: Double)

  fun onGyro(t: Long, x: Double, y: Double, z: Double)

  fun onGravity(t: Long, x: Double, y: Double, z: Double)

  fun onTick(now: Long)
}

data class SensorCapabilities(
  val hasAccelerometer: Boolean,
  val hasGyroscope: Boolean,
  val hasGravity: Boolean,
  val accelMaxRange: Double,
  val accelMinDelayUs: Int,
  val accelResolution: Double,
  val gyroMaxRange: Double,
  val gyroMinDelayUs: Int,
)

class RiderSensorManager(
  context: Context,
  private val clock: EpochClock,
  private val sink: ImuSink,
  private val onStallChanged: (stalled: Boolean) -> Unit,
) : SensorEventListener {
  companion object {
    const val SAMPLING_PERIOD_US = 10_000
    const val MAX_REPORT_LATENCY_US = 50_000
    const val TICK_MS = 250L
    private const val STALL_MS = 2_000L
    private const val REREGISTER_MIN_GAP_MS = 5_000L
    private const val WAKE_LOCK_TIMEOUT_MS = 12L * 60 * 60 * 1000
    private const val WAKE_LOCK_TAG = "rideaze:crash-monitor"

    fun probe(context: Context): SensorCapabilities {
      val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
      val a = sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
      val g = sm.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
      val gr = sm.getDefaultSensor(Sensor.TYPE_GRAVITY)
      return SensorCapabilities(
        hasAccelerometer = a != null,
        hasGyroscope = g != null,
        hasGravity = gr != null,
        accelMaxRange = a?.maximumRange?.toDouble() ?: 0.0,
        accelMinDelayUs = a?.minDelay ?: 0,
        accelResolution = a?.resolution?.toDouble() ?: 0.0,
        gyroMaxRange = g?.maximumRange?.toDouble() ?: 0.0,
        gyroMinDelayUs = g?.minDelay ?: 0,
      )
    }
  }

  private val appContext = context.applicationContext
  private val sensorManager = appContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val powerManager = appContext.getSystemService(Context.POWER_SERVICE) as PowerManager

  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var wakeLock: PowerManager.WakeLock? = null

  @Volatile private var running = false
  private var stalled = false
  private var lastAccelAt = 0L
  private var lastReregisterAt = 0L

  val looper: Looper?
    get() = thread?.looper

  fun post(block: () -> Unit): Boolean = handler?.post(block) ?: false

  fun start(): Boolean {
    if (running) return true
    val t = HandlerThread("ridezz-sensors", android.os.Process.THREAD_PRIORITY_FOREGROUND)
    t.start()
    val h = Handler(t.looper)
    thread = t
    handler = h

    if (!registerAll(h)) {
      sensorManager.unregisterListener(this)
      t.quitSafely()
      thread = null
      handler = null
      return false
    }
    wakeLock =
      powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
        setReferenceCounted(false)
        acquire(WAKE_LOCK_TIMEOUT_MS)
      }
    running = true
    stalled = false
    lastAccelAt = clock.now()
    h.postDelayed(tickRunnable, TICK_MS)
    return true
  }

  fun stop() {
    running = false
    sensorManager.unregisterListener(this)
    handler?.removeCallbacksAndMessages(null)
    thread?.quitSafely()
    thread = null
    handler = null
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }

  private fun registerAll(h: Handler): Boolean {
    val accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return false
    if (!register(accel, h)) return false
    sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { register(it, h) }
    sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY)?.let { register(it, h) }
    return true
  }

  private fun register(sensor: Sensor, h: Handler): Boolean {
    val period = maxOf(SAMPLING_PERIOD_US, sensor.minDelay)
    return sensorManager.registerListener(this, sensor, period, MAX_REPORT_LATENCY_US, h)
  }

  private val tickRunnable =
    object : Runnable {
      override fun run() {
        if (!running) return
        val now = clock.now()
        checkStall(now)
        sink.onTick(now)
        handler?.postDelayed(this, TICK_MS)
      }
    }

  private fun checkStall(now: Long) {
    val silent = now - lastAccelAt > STALL_MS
    if (silent && !stalled) {
      stalled = true
      onStallChanged(true)
    }
    if (silent && now - lastReregisterAt > REREGISTER_MIN_GAP_MS) {
      lastReregisterAt = now
      val h = handler ?: return
      sensorManager.unregisterListener(this)
      registerAll(h)
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (!running) return
    val t = clock.fromElapsedNanos(event.timestamp)
    val v = event.values
    val x = v[0].toDouble()
    val y = v[1].toDouble()
    val z = v[2].toDouble()
    when (event.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> {
        lastAccelAt = clock.now()
        if (stalled) {
          stalled = false
          onStallChanged(false)
        }
        sink.onAccel(t, x, y, z)
      }
      Sensor.TYPE_GYROSCOPE -> sink.onGyro(t, x, y, z)
      Sensor.TYPE_GRAVITY -> sink.onGravity(t, x, y, z)
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
