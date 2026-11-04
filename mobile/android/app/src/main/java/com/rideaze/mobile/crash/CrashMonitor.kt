package com.rideaze.mobile.crash

import android.content.Context

class CrashMonitor(
  context: Context,
  private val listener: Listener,
) {
  interface Listener : CrashDetectorListener, HardBrakingListener {
    fun onMonitorStatus(status: MonitorStatus)
  }

  data class MonitorStatus(val sensorsStalled: Boolean, val gnss: GnssStatus)

  data class StartInfo(val capabilities: SensorCapabilities, val gnss: GnssStatus)

  class UnsupportedDeviceException(val code: String, message: String) : Exception(message)

  private val appContext = context.applicationContext

  private var clock: EpochClock? = null
  private var core: CrashDetectorCore? = null
  private var braking: HardBrakingDetector? = null
  private var sensors: RiderSensorManager? = null
  private var gnssProvider: GnssSpeedProvider? = null
  private var stalled = false
  @Volatile private var simulatedUntil = 0L
  private var gnssStatus = GnssStatus.STOPPED

  val isRunning: Boolean
    @Synchronized get() = sensors != null

  @Synchronized
  fun start(
    config: CrashConfig,
    brakingConfig: HardBrakingConfig = HardBrakingConfig(),
    brakingEnabled: Boolean = true,
  ): StartInfo {
    val caps = RiderSensorManager.probe(appContext)
    if (!caps.hasAccelerometer) {
      throw UnsupportedDeviceException("crash_no_accelerometer", "This phone has no accelerometer")
    }
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
    val brake = if (brakingEnabled) HardBrakingDetector(brakingConfig, listener) else null
    stalled = false

    val sink =
      object : ImuSink {
        override fun onAccel(t: Long, x: Double, y: Double, z: Double) {
          detector.addAccel(t, x, y, z)
          if (!simulating()) brake?.addAccel(t, x, y, z)
        }

        override fun onGyro(t: Long, x: Double, y: Double, z: Double) = detector.addGyro(t, x, y, z)

        override fun onGravity(t: Long, x: Double, y: Double, z: Double) {
          detector.addGravity(t, x, y, z)
          if (!simulating()) brake?.addGravity(t, x, y, z)
        }

        override fun onTick(now: Long) {
          detector.tick(now)
          brake?.tick(now)
        }
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
        onFix = { t, speed, lat, lon, bearing ->
          detector.addGnss(t, speed, lat, lon)
          if (!simulating()) brake?.addGnss(t, speed, bearing)
        },
        onStatus = { status ->
          gnssStatus = status
          publishStatus()
        },
      )
    gnssStatus = manager.looper?.let { gnss.start(it) } ?: GnssStatus.UNAVAILABLE

    clock = clk
    core = detector
    braking = brake
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
    braking = null
    clock = null
    gnssStatus = GnssStatus.STOPPED
    stalled = false
  }

  fun status(): MonitorStatus = MonitorStatus(stalled, gnssStatus)

  private fun publishStatus() = listener.onMonitorStatus(status())

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

  fun simulate(done: (Boolean) -> Unit) =
    onSensorThread(false, done) { c, now ->
      c.simulate(now)
      true
    }

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

  private fun simulating() = android.os.SystemClock.elapsedRealtime() < simulatedUntil

  fun simulateBraking(cruiseKmh: Double = 30.0, finalKmh: Double = 5.0, done: (Boolean) -> Unit) {
    val manager: RiderSensorManager?
    val detector: HardBrakingDetector?
    val clk: EpochClock?
    synchronized(this) {
      manager = sensors
      detector = braking
      clk = clock
    }
    if (manager == null || detector == null || clk == null) {
      done(false)
      return
    }
    simulatedUntil = android.os.SystemClock.elapsedRealtime() + 3_000
    if (!manager.post {
        detector.reset()
        BrakingSimulator.play(detector, clk.now(), cruiseKmh, finalKmh)
        done(true)
      }
    ) {
      simulatedUntil = 0
      done(false)
    }
  }

  fun resetBrakingMount(done: (Boolean) -> Unit) {
    val manager: RiderSensorManager?
    val detector: HardBrakingDetector?
    synchronized(this) {
      manager = sensors
      detector = braking
    }
    if (manager == null || detector == null || !manager.post { detector.resetMount(); done(true) }) done(false)
  }

  fun currentState(done: (CrashState?) -> Unit) =
    onSensorThread<CrashState?>(null, done) { c, _ -> c.getState() }
}
