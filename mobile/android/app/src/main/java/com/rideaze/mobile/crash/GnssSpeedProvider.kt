package com.rideaze.mobile.crash

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import androidx.core.content.ContextCompat

/** Why GNSS is or is not feeding the detector. Surfaced to JS as a plain string. */
enum class GnssStatus(val wire: String) {
  ACTIVE("active"),
  PERMISSION_MISSING("permission_missing"),
  PROVIDER_DISABLED("provider_disabled"),
  UNAVAILABLE("unavailable"),
  STOPPED("stopped"),
}

/**
 * 1 Hz GPS fixes for the crash pipeline's speed correlation (stage 4), delivered on the sensor
 * thread's looper so the detector stays single-threaded. Timestamps use the same elapsed-realtime
 * timeline as the sensors via [EpochClock].
 *
 * Deliberately separate from the JS location-sharing watch: that one uses a 15 m distance filter
 * and a 4 s interval and stops delivering once the bike stops, which is exactly the moment this
 * needs a fresh speed. Both read the same GNSS hardware, so the extra cost is small. Fixes are used
 * in memory only; nothing is logged or stored here.
 */
class GnssSpeedProvider(
  context: Context,
  private val clock: EpochClock,
  private val onFix: (t: Long, speedMps: Double?, lat: Double, lon: Double, bearingDeg: Double?) -> Unit,
  private val onStatus: (GnssStatus) -> Unit,
) : LocationListener {

  companion object {
    private const val MIN_TIME_MS = 1_000L
    /** Fixes less accurate than this (m) are ignored: their speed is not trustworthy. */
    private const val MAX_ACCURACY_M = 100f
  }

  private val appContext = context.applicationContext
  private val locationManager = appContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
  private var active = false

  fun start(looper: Looper): GnssStatus {
    if (ContextCompat.checkSelfPermission(appContext, Manifest.permission.ACCESS_FINE_LOCATION) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      return GnssStatus.PERMISSION_MISSING
    }
    if (!locationManager.allProviders.contains(LocationManager.GPS_PROVIDER)) {
      return GnssStatus.UNAVAILABLE
    }
    return try {
      locationManager.requestLocationUpdates(
        LocationManager.GPS_PROVIDER,
        MIN_TIME_MS,
        0f,
        this,
        looper,
      )
      active = true
      if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) GnssStatus.ACTIVE
      else GnssStatus.PROVIDER_DISABLED
    } catch (e: SecurityException) {
      GnssStatus.PERMISSION_MISSING
    } catch (e: IllegalArgumentException) {
      GnssStatus.UNAVAILABLE
    }
  }

  fun stop() {
    if (!active) return
    active = false
    try {
      locationManager.removeUpdates(this)
    } catch (e: SecurityException) {
      // Permission revoked while running: nothing left to remove.
    }
  }

  override fun onLocationChanged(location: Location) {
    if (!active) return
    if (location.hasAccuracy() && location.accuracy > MAX_ACCURACY_M) return
    onFix(
      clock.fromElapsedNanos(location.elapsedRealtimeNanos),
      if (location.hasSpeed()) location.speed.toDouble() else null,
      location.latitude,
      location.longitude,
      if (location.hasBearing()) location.bearing.toDouble() else null,
    )
  }

  override fun onProviderEnabled(provider: String) {
    if (provider == LocationManager.GPS_PROVIDER) onStatus(GnssStatus.ACTIVE)
  }

  override fun onProviderDisabled(provider: String) {
    if (provider == LocationManager.GPS_PROVIDER) onStatus(GnssStatus.PROVIDER_DISABLED)
  }

  @Deprecated("Required below API 29; never called on newer releases.")
  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit
}
