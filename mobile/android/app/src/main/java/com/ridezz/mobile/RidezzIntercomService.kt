package com.ridezz.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the Ridezz process at foreground priority for the duration of an active ride, so Android
 * doesn't freeze/kill it (and with it, the LiveKit room + WebRTC mic capture) when the Activity is
 * backgrounded or the screen locks.
 *
 * This service does not talk to LiveKit itself -- the existing `<LiveKitRoom>` / `AudioSession`
 * JS-side session is left untouched and keeps running in the same process. This service's only
 * job is to hold that process at foreground priority via the notification below.
 *
 * Start/stop is driven entirely from JS (see RidezzIntercomModule), tied to the user's own
 * Join Ride / Leave Ride actions while the Activity is visible -- never started for the first
 * time after backgrounding.
 */
class RidezzIntercomService : Service() {

  companion object {
    private const val CHANNEL_ID = "ridezz_intercom"
    private const val NOTIFICATION_ID = 1001

    fun start(context: Context) {
      val intent = Intent(context, RidezzIntercomService::class.java)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, RidezzIntercomService::class.java))
    }
  }

  override fun onCreate() {
    super.onCreate()
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    // If the system kills this process, there's no active ride to resume into -- don't restart.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    // Some OEM ROMs don't reliably clear the startForeground() notification just because the
    // service is being destroyed/stopped -- remove it explicitly so it doesn't linger after
    // Leave Ride. (STOP_FOREGROUND_REMOVE has existed since API 24, our minSdk.)
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel =
      NotificationChannel(
        CHANNEL_ID,
        "Ridezz intercom",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Shows while your ride intercom is active"
        setShowBadge(false)
      }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(): android.app.Notification {
    val openAppIntent =
      packageManager.getLaunchIntentForPackage(packageName)?.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
      }
    val contentIntent =
      PendingIntent.getActivity(
        this,
        0,
        openAppIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Ridezz")
      .setContentText("Intercom active")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }
}
