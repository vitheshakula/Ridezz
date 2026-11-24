package com.rideaze.bench.core

import com.rideaze.bench.core.measure.Json
import com.rideaze.bench.core.measure.MemorySink
import com.rideaze.bench.core.measure.ProcStat
import com.rideaze.bench.core.measure.RecordSchema
import com.rideaze.bench.core.measure.Recorder
import com.rideaze.bench.core.measure.ResourceSample
import com.rideaze.bench.core.pairing.Decision
import com.rideaze.bench.core.pairing.Initiated
import com.rideaze.bench.core.pairing.PairRole
import com.rideaze.bench.core.pairing.PairingGate
import com.rideaze.bench.core.run.AcceptanceProposal
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingGateTest {
    private fun gate(role: PairRole = PairRole.SENDER) = PairingGate("run7", role, 60_000)
    private val peerName = "BENCH1|run7|R|ab12"

    @Test fun happyPath() {
        val g = gate(); g.open(1000)
        assertTrue(g.shouldRequest("ep1", peerName, 1100))
        val i = g.onConnectionInitiated("ep1", peerName, "4821", 1200) as Initiated.AwaitOperator
        assertEquals("4821", i.digits)
        assertTrue(g.operatorDecision("ep1", true, 5000) is Decision.Accept)
        g.onConnectionResult("ep1", true, 5100)
        assertEquals("ep1", g.connectedPeer); assertEquals(emptyList<String>(), g.isolationBreaches())
        assertFalse("window closes after pairing", g.isOpen(5200))
    }

    @Test fun nameParsingAndAdvertisedName() {
        val g = gate(PairRole.RECEIVER)
        assertEquals("BENCH1|run7|R|x9", g.advertisedName("x9"))
        assertNull(g.parseName("ROOM|rider|Bob")); assertNull(g.parseName("BENCH1|run7|X|n")); assertNull(g.parseName("BENCH1|run7|R"))
        assertEquals(PairRole.SENDER, g.parseName("BENCH1|run7|S|n")!!.role)
    }

    @Test fun productionStyleEndpointNamesAreNeverAccepted() {
        val g = gate(); g.open(0)
        assertFalse(g.shouldRequest("e", "ROOM123|rider-1|Alice", 10))
        assertTrue(g.onConnectionInitiated("e", "ROOM123|rider-1|Alice", "1234", 10) is Initiated.Reject)
        assertEquals(1, g.isolationBreaches().size)
    }

    @Test fun wrongLabelOrSameRoleRejectedAndRecordedAsBreach() {
        val g = gate(); g.open(0)
        assertTrue(g.onConnectionInitiated("a", "BENCH1|other|R|n", "1111", 1) is Initiated.Reject)
        assertTrue(g.onConnectionInitiated("b", "BENCH1|run7|S|n", "1111", 1) is Initiated.Reject)
        assertEquals(2, g.isolationBreaches().size)
    }

    @Test fun windowExpiryBlocksInitiationAndConfirmation() {
        val g = gate(); g.open(0)
        assertTrue(g.onConnectionInitiated("a", peerName, "1111", 60_001) is Initiated.Reject)
        val h = gate(); h.open(0)
        h.onConnectionInitiated("a", peerName, "1111", 59_000)
        assertTrue(h.operatorDecision("a", true, 60_500) is Decision.Reject)
    }

    @Test fun neverOpenedMeansNothingIsAccepted() {
        val g = gate()
        assertFalse(g.shouldRequest("a", peerName, 0))
        assertTrue(g.onConnectionInitiated("a", peerName, "1234", 0) is Initiated.Reject)
    }

    @Test fun missingAuthenticationDigitsIsRejectedNotSkipped() {
        val g = gate(); g.open(0)
        val r = g.onConnectionInitiated("a", peerName, null, 1) as Initiated.Reject
        assertEquals("no_authentication_digits", r.reason)
        assertTrue(g.onConnectionInitiated("a", peerName, "  ", 2) is Initiated.Reject)
    }

    @Test fun operatorMismatchRejectsAndInvalidatesRun() {
        val g = gate(); g.open(0)
        g.onConnectionInitiated("a", peerName, "1234", 1)
        assertTrue(g.operatorDecision("a", false, 2) is Decision.Reject)
        assertEquals(1, g.isolationBreaches().size)
        assertNull(g.connectedPeer)
    }

    @Test fun secondPeerRejectedWhileOneIsPendingOrConnected() {
        val g = gate(); g.open(0)
        g.onConnectionInitiated("a", peerName, "1234", 1)
        assertTrue(g.onConnectionInitiated("b", peerName, "9999", 2) is Initiated.Reject)
        g.operatorDecision("a", true, 3); g.onConnectionResult("a", true, 4)
        g.open(10)
        assertTrue(g.onConnectionInitiated("c", peerName, "0000", 11) is Initiated.Reject)
        assertEquals(2, g.isolationBreaches().size)
    }

    @Test fun connectionWithoutPairingIsABreach() {
        val g = gate(); g.open(0)
        g.onConnectionResult("stray", true, 1)
        assertEquals(1, g.isolationBreaches().size)
    }

    @Test fun decisionForUnknownEndpointRejected() {
        val g = gate(); g.open(0)
        assertTrue(g.operatorDecision("ghost", true, 1) is Decision.Reject)
    }

    @Test fun disconnectClearsPeer() {
        val g = gate(); g.open(0)
        g.onConnectionInitiated("a", peerName, "1234", 1); g.operatorDecision("a", true, 2); g.onConnectionResult("a", true, 3)
        g.onDisconnected("a", 9); assertNull(g.connectedPeer)
    }

    @Test fun endpointHashIsStableSaltedAndShort() {
        val g = gate(); val h = g.hash("endpoint-123")
        assertEquals(8, h.length); assertEquals(h, g.hash("endpoint-123")); assertNotEquals("endpoint-123", h)
        assertNotEquals(h, PairingGate("run8", PairRole.SENDER).hash("endpoint-123"))
        assertTrue(g.log().none { it.endpointHash == "endpoint-123" })
    }

    @Test fun labelMustBeShortAlphanumeric() {
        for (bad in listOf("", "a|b", "toolonglabel1", "sp ace")) {
            try { PairingGate(bad, PairRole.SENDER); throw AssertionError("accepted $bad") } catch (_: IllegalArgumentException) {}
        }
    }
}

class RecorderSchemaTest {
    private val clock = MonotonicClock { 42L }

    private fun allRecordTypes(rec: Recorder) {
        rec.runStart(mapOf("id" to "e1"), 0, 3, 123L, mapOf("model" to "x", "sdk" to 34), AcceptanceProposal.toMap(), 20)
        rec.pairing("connected", "ab12cd34", "")
        rec.probe(0, 1, 2, 3, 4, 5, 1.5, true)
        rec.sample(ResourceSample(1, 2, 100, 3, 4, 5, 6, 7, 8, true, true, true, false))
        rec.event("stall_submit", "ms=300")
        val tx = com.rideaze.bench.core.measure.SenderLedger().also { it.generated(0, 0, 80) }.get(0)!!
        rec.frameTx(tx)
        rec.frameRx(com.rideaze.bench.core.measure.RxRecord(0, 1, 2, com.rideaze.bench.core.measure.RxClass.ON_TIME, 3.0, 4.0, 80))
        rec.runEnd(mapOf("status" to "complete", "counts" to mapOf("a" to 1), "bytes" to mapOf("b" to 2), "invariants" to emptyList<String>(), "parser" to mapOf<String, Any?>(), "probes" to mapOf<String, Any?>(), "stalls" to mapOf<String, Any?>(), "verdict" to mapOf("failure_class" to "NONE")))
    }

    @Test fun everyRecordTypeValidatesAndRoundTripsThroughJson() {
        val sink = MemorySink(); allRecordTypes(Recorder(sink, "rid", "sender", clock, strict = true))
        assertEquals(RecordSchema.TYPES.keys, sink.lines.map { (MiniJson.parse(it) as Map<*, *>)["type"] }.toSet())
        for (l in sink.lines) {
            @Suppress("UNCHECKED_CAST") val m = MiniJson.parse(l) as Map<String, Any?>
            assertEquals(emptyList<String>(), RecordSchema.validate(m)); assertEquals(1L, m["v"]); assertEquals("rid", m["run_id"]); assertEquals(42L, m["t_ms"])
        }
    }

    @Test fun schemaRejectsUnknownMissingAndForbiddenKeys() {
        val ok = linkedMapOf<String, Any?>("v" to 1, "type" to "event", "run_id" to "r", "role" to "sender", "t_ms" to 1, "name" to "n", "detail" to "d")
        assertEquals(emptyList<String>(), RecordSchema.validate(ok))
        assertTrue(RecordSchema.validate(ok + ("extra" to 1)).isNotEmpty())
        assertTrue(RecordSchema.validate(ok - "detail").isNotEmpty())
        assertTrue(RecordSchema.validate(ok + ("type" to "bogus")).isNotEmpty())
        for (k in listOf("device_serial", "android_id", "jwt_token", "room_code", "rider_id", "livekit_url", "wifi_ssid", "user_email"))
            assertTrue("$k allowed?", RecordSchema.validate(ok + ("name" to mapOf(k to 1))).any { it.contains("forbidden") })
    }

    @Test fun locationSettingStateIsAllowedButLocationDataIsStillForbidden() {
        val ok = linkedMapOf<String, Any?>("v" to 1, "type" to "event", "run_id" to "r", "role" to "sender", "t_ms" to 1, "name" to "n", "detail" to "d")
        for (v in listOf<Any?>(true, false, null)) assertEquals(emptyList<String>(), RecordSchema.validate(ok + ("name" to mapOf("location_services" to v))))
        assertTrue(RecordSchema.validate(ok + ("name" to mapOf("location_services" to "52.1,0.1"))).any { it.contains("Boolean or null") })
        for (k in listOf("location", "location_lat", "last_location", "location_services_lat", "latitude"))
            assertTrue("$k must stay forbidden", RecordSchema.validate(ok + ("name" to mapOf(k to 1))).any { it.contains("forbidden") })
    }

    @Test fun deviceInfoFieldsDoNotContainIdentifiers() {
        val sink = MemorySink(); allRecordTypes(Recorder(sink, "rid", "sender", clock, strict = true))
        val joined = sink.lines.joinToString("\n").lowercase()
        for (w in listOf("serial", "android_id", "email", "ssid", "latitude", "livekit", "token")) assertFalse(w, joined.contains(w))
    }

    @Test fun strictRecorderRefusesNonSchemaRecord() {
        val r = Recorder(MemorySink(), "r", "sender", clock, strict = true)
        try { r.runEnd(mapOf("status" to "x")); throw AssertionError("accepted incomplete run_end") } catch (_: IllegalStateException) {}
    }

    @Test fun jsonEscapingNumbersAndNonFinite() {
        val s = Json.write(mapOf("q" to "a\"b\\c\n\u0001é", "d" to Double.NaN, "i" to Double.POSITIVE_INFINITY, "n" to null, "l" to listOf(1, 2.5, true), "e" to com.rideaze.bench.core.measure.DropCode.SRC_FULL))
        @Suppress("UNCHECKED_CAST") val m = MiniJson.parse(s) as Map<String, Any?>
        assertEquals("a\"b\\c\n\u0001é", m["q"]); assertNull(m["d"]); assertNull(m["i"]); assertNull(m["n"])
        assertEquals(listOf(1L, 2.5, true), m["l"]); assertEquals("SRC_FULL", m["e"])
    }

    @Test fun resourceSampleKeysMatchSchemaAndNullsMeanUnavailable() {
        val keys = ResourceSample(null, null, null, null, null, null, null, null, null, null, null, null, null).toMap()
        assertEquals(RecordSchema.TYPES.getValue("sample").first, keys.keys)
        assertTrue(keys.values.all { it == null })
        assertTrue(ResourceSample.UNAVAILABLE_METRICS.containsAll(listOf("radio_airtime", "platform_retransmissions")))
    }

    @Test fun procStatParsing() {
        val line = "1234 (bench app (x)) S 1 1 1 0 -1 4194560 100 0 0 0 150 70 0 0 20 0 5 0 99 1000 200"
        assertEquals(150L to 70L, ProcStat.parseCpuTicks(line))
        assertNull(ProcStat.parseCpuTicks("garbage")); assertNull(ProcStat.parseCpuTicks("1 (x) S 1 2"))
        assertNotNull(ProcStat.parseCpuTicks("1 (x) S 1 1 1 0 -1 0 0 0 0 0 7 8 0"))
    }
}
