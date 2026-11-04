package com.rideaze.mobile

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

class RidezzIntercomService : Service() {
  companion object {
    private const val CHANNEL_ID = "ridezz_intercom"
    private const val NOTIFICATION_ID = 1001

    @Volatile var isRunning: Boolean = false
      private set

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
    isRunning = true
    createNotificationChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    isRunning = false
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
        "Rideaze intercom",
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
      .setContentTitle("Rideaze")
      .setContentText("Intercom active")
      .setSmallIcon(R.mipmap.ic_launcher)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .build()
  }
}
