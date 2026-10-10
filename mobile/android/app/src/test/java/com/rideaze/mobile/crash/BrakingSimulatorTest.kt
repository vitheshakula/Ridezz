package com.rideaze.mobile.crash

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrakingSimulatorTest {
  @Test
  fun thirtyToFiveKmhRaisesOneImuAlertThatGnssConfirms() {
    val events = mutableListOf<BrakingEvent>()
    val decisions = mutableListOf<BrakingDecision>()
    val d =
      HardBrakingDetector(
        HardBrakingConfig(),
        object : HardBrakingListener {
          override fun onHardBraking(event: BrakingEvent) { events += event }
          override fun onBrakingDecision(decision: BrakingDecision) { decisions += decision }
        },
      )
    val end = 1_800_000_000_000L
    BrakingSimulator.play(d, end)
    assertEquals(decisions.toString(), 1, events.size)
    assertEquals(BrakingSource.IMU, events[0].source)
    assertEquals(30.0, events[0].speedMps * 3.6, 0.1)
    assertTrue(events[0].raisedAt <= end)
    assertTrue(decisions.any { it is BrakingDecision.Confirmed })
  }
}
