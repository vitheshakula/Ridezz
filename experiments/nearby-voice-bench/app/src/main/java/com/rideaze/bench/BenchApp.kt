package com.rideaze.bench

import android.app.Application
import com.rideaze.bench.run.RunController

/** Holds the single run controller so the activity and the foreground service share one run. */
class BenchApp : Application() {
    val controller: RunController by lazy { RunController(this) }

    override fun onTerminate() {
        controller.stop("app_terminate")
        super.onTerminate()
    }
}
