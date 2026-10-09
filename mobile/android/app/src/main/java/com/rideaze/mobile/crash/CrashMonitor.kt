package com.rideaze.mobile.crash

import android.content.Context

/**
 * Wires the sensor foundation, GNSS speed and the detector together and owns their lifecycle.
 * Free of React Native types, so it can be started from a bridge module today and from a service
 * tomorrow.
 *
 * Threading: the detector runs on the sensor thread. Public control methods may be called from any
 * thread; they hop onto the sensor thread and report their result through a callback.
 */
class CrashMonitor(
  context: Context,
  private val listener: Listener,
) {

  interface Listener : CrashDetectorListener {
    /** Sensor stall / GNSS availability changed. May be called from the sensor thread. */
    fun onMonitorStatus(status: MonitorStatus)
  }

  data class MonitorStatus(val sensorsStalled: Boolean, val gnss: GnssStatus)

  data class StartInfo(val capabilities: SensorCapabilities, val gnss: GnssStatus)

  /** Thrown by [start] when crash detection cannot run on this phone. [code] is JS-facing. */
  class UnsupportedDeviceException(val code: String, message: String) : Exception(message)

  private val appContext = context.applicationContext

  private var clock: EpochClock? = null
  private var core: CrashDetectorCore? = null
  private var sensors: RiderSensorManager? = null
  private var gnssProvider: GnssSpeedProvider? = null
  private var stalled = false
  private var gnssStatus = GnssStatus.STOPPED

  val isRunning: Boolean
    @Synchronized get() = sensors != null

  @Synchronized
  fun start(config: CrashConfig): StartInfo {
    val caps = RiderSensorManager.probe(appContext)
    if (!caps.hasAccelerometer) {
      throw UnsupportedDeviceException("crash_no_accelerometer", "This phone has no accelerometer")
    }
    // A sensor that saturates below the impact threshold could never see a crash.
    val minRange = config.impactG * STANDARD_GRAVITY * 1.1
    if (caps.accelMaxRange < minRange) {
      throw UnsupportedDeviceException(
        "crash_unsupported_accelerometer",
        "Accelerometer range ${"%.1f".format(caps.accelMaxRange / STANDARD_GRAVITY)} g is below " +
          "the ${"%.1f".format(minRange / STANDARD_GRAVITY)} g needed to detect an impact",
      )
    }
    if (sensors != null) {
      return StartInfo(caps, gnssStatus)
    }

    val clk = EpochClock()
    val detector = CrashDetectorCore(config, listener)
    detector.setGyroAvailable(caps.hasGyroscope)
    stalled = false

    val sink =
      object : ImuSink {
        override fun onAccel(t: Long, x: Double, y: Double, z: Double) = detector.addAccel(t, x, y, z)

        override fun onGyro(t: Long, x: Double, y: Double, z: Double) = detector.addGyro(t, x, y, z)

        override fun onGravity(t: Long, x: Double, y: Double, z: Double) =
          detector.addGravity(t, x, y, z)

        override fun onTick(now: Long) = detector.tick(now)
      }

    val manager =
      RiderSensorManager(appContext, clk, sink) { isStalled ->
        stalled = isStalled
        publishStatus()
      }
    if (!manager.start()) {
      throw UnsupportedDeviceException(
        "crash_sensor_register_failed",
        "Android refused the sensor registration",
      )
    }

    val gnss =
      GnssSpeedProvider(
        appContext,
        clk,
        onFix = { t, speed, lat, lon -> detector.addGnss(t, speed, lat, lon) },
        onStatus = { status ->
          gnssStatus = status
          publishStatus()
        },
      )
    // Registered with the sensor thread's looper so GNSS and IMU share one thread.
    gnssStatus = manager.looper?.let { gnss.start(it) } ?: GnssStatus.UNAVAILABLE

    clock = clk
    core = detector
    sensors = manager
    gnssProvider = gnss
    return StartInfo(caps, gnssStatus)
  }

  @Synchronized
  fun stop() {
    gnssProvider?.stop()
    sensors?.stop()
    gnssProvider = null
    sensors = null
    core = null
    clock = null
    gnssStatus = GnssStatus.STOPPED
    stalled = false
  }

  fun status(): MonitorStatus = MonitorStatus(stalled, gnssStatus)

  private fun publishStatus() = listener.onMonitorStatus(status())

  /** Runs [block] on the sensor thread and passes its result to [done]; false if not running. */
  private fun <T> onSensorThread(fallback: T, done: (T) -> Unit, block: (CrashDetectorCore, Long) -> T) {
    val manager: RiderSensorManager?
    val detector: CrashDetectorCore?
    val clk: EpochClock?
    synchronized(this) {
      manager = sensors
      detector = core
      clk = clock
    }
    if (manager == null || detector == null || clk == null ||
      !manager.post { done(block(detector, clk.now())) }
    ) {
      done(fallback)
    }
  }

  fun cancel(reason: String, done: (Boolean) -> Unit) =
    onSensorThread(false, done) { c, now -> c.cancel(now, reason) }

  fun sendNow(done: (Boolean) -> Unit) = onSensorThread(false, done) { c, now -> c.sendNow(now) }

  fun acknowledge(done: (Boolean) -> Unit) =
    onSensorThread(false, done) { c, now -> c.acknowledge(now) }

  /** Dev/demo only: starts a countdown with no sensor evidence. */
  fun simulate(done: (Boolean) -> Unit) =
    onSensorThread(false, done) { c, now ->
      c.simulate(now)
      true
    }

  /** The result arrives via [CrashDetectorListener.onCalibration]. */
  fun calibrate(done: (Boolean) -> Unit) =
    onSensorThread(false, done) { c, now ->
      c.startCalibration(now)
      true
    }

  fun clearCalibration(done: (Boolean) -> Unit) =
    onSensorThread(false, done) { c, _ ->
      c.clearCalibration()
      true
    }

  fun currentState(done: (CrashState?) -> Unit) =
    onSensorThread<CrashState?>(null, done) { c, _ -> c.getState() }
}
