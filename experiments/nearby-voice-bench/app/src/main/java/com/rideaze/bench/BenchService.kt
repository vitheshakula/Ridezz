package com.rideaze.bench

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Keeps the process in the foreground during a run. Contains no benchmark logic. */
class BenchService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Bench run", NotificationManager.IMPORTANCE_LOW))
            Notification.Builder(this, CHANNEL)
        } else {
            @Suppress("DEPRECATION") Notification.Builder(this)
        }
        val n = builder.setContentTitle("Rideaze Bench").setContentText("Benchmark session active")
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth).setOngoing(true).build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        else startForeground(ID, n)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        (application as BenchApp).controller.stop("service_destroyed")
        super.onDestroy()
    }

    private companion object { const val CHANNEL = "bench_run"; const val ID = 4201 }
}
