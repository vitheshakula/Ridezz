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

/**
 * One timeline for everything: sensor and GNSS timestamps are both elapsed-realtime based, and
 * this maps them to epoch milliseconds with a single offset fixed at construction. A later wall
 * clock change (NTP step, user edit) therefore cannot reorder or skew samples mid-ride.
 */
class EpochClock {
  private val offsetMs = System.currentTimeMillis() - SystemClock.elapsedRealtime()

  fun now(): Long = SystemClock.elapsedRealtime() + offsetMs

  fun fromElapsedNanos(nanos: Long): Long = nanos / 1_000_000L + offsetMs
}

/** Receives the raw streams on the sensor thread. */
interface ImuSink {
  fun onAccel(t: Long, x: Double, y: Double, z: Double)

  fun onGyro(t: Long, x: Double, y: Double, z: Double)

  /** Fused gravity (Sensor.TYPE_GRAVITY); only called when the phone has that sensor. */
  fun onGravity(t: Long, x: Double, y: Double, z: Double)

  /** Every [RiderSensorManager.TICK_MS], on the same thread as the samples. */
  fun onTick(now: Long)
}

data class SensorCapabilities(
  val hasAccelerometer: Boolean,
  val hasGyroscope: Boolean,
  val hasGravity: Boolean,
  /** Accelerometer full-scale range, m/s^2 (about 78 for +-8 g, 19.6 for +-2 g). */
  val accelMaxRange: Double,
  val accelMinDelayUs: Int,
  val accelResolution: Double,
  val gyroMaxRange: Double,
  val gyroMinDelayUs: Int,
)

/**
 * Shared sensor foundation for the safety features. Streams the standard accelerometer, gyroscope
 * and fused-gravity sensors at 100 Hz (10,000 us) on one dedicated HandlerThread, so detection
 * never competes with the React Native threads.
 *
 *  - Standard sensor types only (never vendor virtual sensors), so it behaves the same on any phone.
 *  - Registration asks for [MAX_REPORT_LATENCY_US] of hardware batching: the sensor hub may deliver
 *    samples in groups up to that late (the samples keep their true timestamps). That lets the CPU
 *    wake less often; 50 ms is far below anything the crash pipeline cares about.
 *  - The process is kept alive by RidezzIntercomService (a foreground service of type
 *    microphone|location), which is what stops Android 9+ delivering sensor events to a backgrounded
 *    app. This class additionally holds a PARTIAL_WAKE_LOCK while running: non-wakeup sensor events
 *    queue up in the hub FIFO while the CPU sleeps, which would delay an impact by however long the
 *    CPU stayed suspended.
 *  - A watchdog notices when the accelerometer goes silent (some OEM power managers freeze sensor
 *    delivery) and re-registers, reporting the stall through [onStallChanged].
 *
 * The 2-3 s pre-impact history lives in the detector's SampleRing buffers, which this class feeds.
 */
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
    // A ride never lasts this long; the timeout only guarantees the lock cannot leak forever.
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

  /** Runs [block] on the sensor thread (where the detector lives). False if not running. */
  fun post(block: () -> Unit): Boolean = handler?.post(block) ?: false

  /** Registers the sensors and starts ticking. Returns false if the accelerometer is unusable. */
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
    // Gyro and gravity are optional: the pipeline degrades without them.
    sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let { register(it, h) }
    sensorManager.getDefaultSensor(Sensor.TYPE_GRAVITY)?.let { register(it, h) }
    return true
  }

  private fun register(sensor: Sensor, h: Handler): Boolean {
    // Never ask for a faster period than the sensor supports.
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
