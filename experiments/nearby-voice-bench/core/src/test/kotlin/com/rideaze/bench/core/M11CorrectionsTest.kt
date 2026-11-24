package com.rideaze.bench.core

import com.rideaze.bench.core.platform.NearbyStatus
import com.rideaze.bench.core.platform.PermissionPlan
import com.rideaze.bench.core.platform.RadioState
import com.rideaze.bench.core.platform.ReadinessCheck
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.run.DeviceFlag
import com.rideaze.bench.core.run.Mode
import com.rideaze.bench.core.run.Phase
import com.rideaze.bench.core.run.RunContext
import com.rideaze.bench.core.run.Scenarios
import com.rideaze.bench.core.run.WindowRelease
import com.rideaze.bench.core.protocol.Wire
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Finding 1: radio and location readiness (pure logic; the Android reader is only stub-compiled). */
class ReadinessTest {
    private fun on() = RadioState(wifi = true, bluetooth = true, locationServices = true)

    @Test fun everythingOnIsReadyWithNoWarnings() {
        for (sdk in listOf(24, 28, 30, 31, 33, 36)) { val r = ReadinessCheck.evaluate(sdk, on()); assertTrue("sdk $sdk", r.ok); assertTrue(r.warnings.isEmpty()) }
    }

    @Test fun bluetoothOffBlocksWithAnOperatorInstructionAndNeverOffersToToggle() {
        val r = ReadinessCheck.evaluate(34, on().copy(bluetooth = false))
        assertFalse(r.ok); val m = r.blockers.single()
        assertTrue(m, m.startsWith("Bluetooth is OFF") && m.contains("Turn Bluetooth ON") && m.contains("will not either") && m.contains("press Start pairing again"))
    }

    @Test fun wifiOffBlocksAndSaysItNeedsNoNetwork() {
        val r = ReadinessCheck.evaluate(34, on().copy(wifi = false))
        assertFalse(r.ok); assertTrue(r.blockers.single().let { it.startsWith("Wi-Fi is OFF") && it.contains("does not need to be connected") })
    }

    @Test fun locationServicesAreABlockerBeforeAndroid12AndOnlyAWarningFromAndroid12() {
        val off = on().copy(locationServices = false)
        for (sdk in listOf(24, 28, 30)) {
            val r = ReadinessCheck.evaluate(sdk, off); assertFalse("sdk $sdk", r.ok)
            assertTrue(r.blockers.single(), r.blockers.single().startsWith("Location services is OFF") && r.blockers.single().contains("Turn Location ON"))
        }
        for (sdk in listOf(31, 32, 33, 36)) { val r = ReadinessCheck.evaluate(sdk, off); assertTrue("sdk $sdk", r.ok); assertEquals(1, r.warnings.size); assertTrue(r.warnings[0].contains("assumption")) }
    }

    @Test fun everyProblemIsListedNotJustTheFirst() {
        val r = ReadinessCheck.evaluate(29, RadioState(false, false, false))
        assertEquals(3, r.blockers.size); assertTrue(r.blockers.any { it.contains("Bluetooth") } && r.blockers.any { it.contains("Wi-Fi") } && r.blockers.any { it.contains("Location") })
    }

    @Test fun anUnreadableStateIsAWarningNeverSilentlyTreatedAsOn() {
        val r = ReadinessCheck.evaluate(30, RadioState(null, null, null))
        assertTrue(r.ok); assertEquals(3, r.warnings.size); assertTrue(r.warnings.all { it.contains("could not be read") })
        assertEquals(2, ReadinessCheck.evaluate(33, RadioState(null, null, null)).warnings.size)     // location unknown is irrelevant from Android 12
    }

    @Test fun stateIsRecordedWithStableKeys() {
        assertEquals(linkedMapOf<String, Any?>("wifi" to true, "bluetooth" to false, "location_services" to null), RadioState(true, false, null).toMap())
    }

    @Test fun radioStatusCodesAreEnvironmentPreconditionsAndOthersAreNotGuessed() {
        assertTrue(NearbyStatus.describe(8013).radio); assertEquals("STATUS_RADIO_ERROR", NearbyStatus.describe(8013).name)
        assertTrue(NearbyStatus.describe(8007).radio); assertTrue(NearbyStatus.describe(8007).name.contains("deprecated"))
        assertFalse(NearbyStatus.describe(8001).radio); assertEquals("UNKNOWN(8001)", NearbyStatus.describe(8001).name)
        assertFalse(NearbyStatus.describe(null).radio); assertEquals("UNKNOWN(none)", NearbyStatus.describe(null).name)
    }
}

/** Finding 4: permission plan per API level, cross-checked against the real manifest files. */
class PermissionPlanTest {
    private val androidNs = "http://schemas.android.com/apk/res/android"
    private val bt = listOf(PermissionPlan.BLUETOOTH_ADVERTISE, PermissionPlan.BLUETOOTH_CONNECT, PermissionPlan.BLUETOOTH_SCAN)
    private val loc = listOf(PermissionPlan.FINE_LOCATION, PermissionPlan.COARSE_LOCATION)

    private data class Decl(val name: String, val maxSdk: Int?, val flags: String?)

    private fun parse(f: File): List<Decl> {
        val dbf = DocumentBuilderFactory.newInstance(); dbf.isNamespaceAware = true
        val nodes = dbf.newDocumentBuilder().parse(f).getElementsByTagName("uses-permission")
        return (0 until nodes.length).map {
            val e = nodes.item(it) as org.w3c.dom.Element
            Decl(e.getAttributeNS(androidNs, "name"), e.getAttributeNS(androidNs, "maxSdkVersion").toIntOrNull(), e.getAttributeNS(androidNs, "usesPermissionFlags").ifEmpty { null })
        }
    }

    private val bench = File("../app/src/main/AndroidManifest.xml")

    @Test fun runtimePermissionsPerApiLevelAreExactlyThese() {
        for (sdk in listOf(24, 28, 30)) assertEquals("sdk $sdk", loc, PermissionPlan.runtimePermissions(sdk))
        for (sdk in listOf(31, 32)) assertEquals("sdk $sdk", bt + loc, PermissionPlan.runtimePermissions(sdk))
        for (sdk in listOf(33, 34, 36)) assertEquals("sdk $sdk", bt + listOf(PermissionPlan.NEARBY_WIFI_DEVICES, PermissionPlan.POST_NOTIFICATIONS), PermissionPlan.runtimePermissions(sdk))
    }

    @Test fun coarseIsAlwaysRequestedTogetherWithFineAndNeverBeyondTheirShareSdkRange() {
        for (sdk in 24..36) {
            val p = PermissionPlan.runtimePermissions(sdk)
            assertEquals("sdk $sdk: FINE and COARSE must travel together", PermissionPlan.FINE_LOCATION in p, PermissionPlan.COARSE_LOCATION in p)
        }
    }

    @Test fun everyRequestedPermissionIsDeclaredInTheManifestForThatApiLevel() {
        assertTrue("run from the :core module directory", bench.exists())
        val decl = parse(bench)
        for (sdk in 24..36) for (perm in PermissionPlan.runtimePermissions(sdk)) {
            val d = decl.filter { it.name == perm }
            assertTrue("sdk $sdk: $perm not declared", d.isNotEmpty())
            assertTrue("sdk $sdk: $perm declared with maxSdkVersion below $sdk: $d", d.any { it.maxSdk == null || it.maxSdk >= sdk })
        }
    }

    @Test fun legacyBluetoothPermissionsAreCappedAtApi30AndNothingForbiddenIsDeclared() {
        val decl = parse(bench)
        for (n in listOf("android.permission.BLUETOOTH", "android.permission.BLUETOOTH_ADMIN")) assertEquals(n, 30, decl.single { it.name == n }.maxSdk)
        assertTrue("no INTERNET: the bench must not be able to reach a network", decl.none { it.name == "android.permission.INTERNET" })
        assertTrue(decl.none { it.name.contains("RECORD_AUDIO") })
        assertNotNull(decl.firstOrNull { it.name == "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE" })
        assertNotNull(decl.firstOrNull { it.name == "android.permission.CHANGE_WIFI_STATE" })
    }

    @Test fun scanAndNearbyWifiAssertNeverForLocationLikeProduction() {
        val decl = parse(bench)
        assertEquals("neverForLocation", decl.single { it.name == PermissionPlan.BLUETOOTH_SCAN }.flags)
        assertEquals("neverForLocation", decl.single { it.name == PermissionPlan.NEARBY_WIFI_DEVICES }.flags)
    }

    @Test fun benchAgreesWithProductionWhereTheSamePermissionAppearsAndWhereApiLevelsDoNot() {
        val prodFile = File("../../../mobile/android/app/src/main/AndroidManifest.xml")      // READ ONLY comparison
        assumeTrue("production manifest not present in this checkout", prodFile.exists())
        val prod = parse(prodFile).associateBy { it.name }; val b = parse(bench).associateBy { it.name }
        for (n in listOf(PermissionPlan.BLUETOOTH_SCAN, PermissionPlan.NEARBY_WIFI_DEVICES)) assertEquals("$n flags differ from production", prod.getValue(n).flags, b.getValue(n).flags)
        assertEquals(prod.getValue("android.permission.BLUETOOTH").maxSdk, b.getValue("android.permission.BLUETOOTH").maxSdk)
        // intentionally different: production has no cap on location (it targets all API levels with its own handling); the bench caps both at 32
        assertNull(prod.getValue(PermissionPlan.FINE_LOCATION).maxSdk); assertEquals(32, b.getValue(PermissionPlan.FINE_LOCATION).maxSdk); assertEquals(32, b.getValue(PermissionPlan.COARSE_LOCATION).maxSdk)
        // production-only permissions the bench must NOT inherit (different purpose)
        for (n in listOf("android.permission.RECORD_AUDIO", "android.permission.INTERNET", "android.permission.WAKE_LOCK")) assertFalse("$n copied from production", n in b.keys)
    }
}

/** Finding 2: distinct scenario ids per window-release policy. */
class WindowPolicyScenarioTest {
    @Test fun everyBaseScenarioHasAnAckTwinWithItsOwnIdAndOtherwiseIdenticalParameters() {
        for (k in Scenarios.E1_BITRATES_KBPS) for (mode in Mode.values()) {
            val base = Scenarios.e1Bytes(k, mode); val ack = Scenarios.e1Bytes(k, mode, WindowRelease.ACCEPTED)
            assertEquals(WindowRelease.TRANSFER_RESULT, base.windowRelease); assertEquals(WindowRelease.ACCEPTED, ack.windowRelease)
            assertEquals(base.id + "-ack", ack.id)
            assertEquals(base, ack.copy(id = base.id, windowRelease = WindowRelease.TRANSFER_RESULT))
            assertNotNull(Scenarios.byId(base.id)); assertEquals(ack, Scenarios.byId(ack.id))
            assertEquals(emptyList<String>(), base.validate()); assertEquals(emptyList<String>(), ack.validate())
        }
        assertEquals("e1-bytes-rt-24k-ack", Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED).id)
        assertEquals("e1-bytes-raw-96k", Scenarios.e1Bytes(96, Mode.RAW).id)
    }

    @Test fun anIdThatDisagreesWithItsPolicyIsAConfigurationError() {
        val base = Scenarios.e1Bytes(24, Mode.REALTIME); val ack = Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED)
        assertTrue(base.copy(windowRelease = WindowRelease.ACCEPTED).validate().any { it.contains("does not match windowRelease") })
        assertTrue(ack.copy(windowRelease = WindowRelease.TRANSFER_RESULT).validate().any { it.contains("does not match windowRelease") })
    }

    @Test fun thePolicyIsPartOfTheFingerprintSoMismatchedPhonesDetectIt() {
        val a = Scenarios.e1Bytes(24, Mode.REALTIME); val b = Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED)
        assertNotEquals(a.fingerprint(0), b.fingerprint(0))
        assertNotEquals(a.fingerprint(0), a.copy(windowRelease = WindowRelease.ACCEPTED).fingerprint(0))   // even with the same id
    }

    @Test fun phonesOnDifferentPoliciesAreAConfigurationFailureOnBothSides() {
        val a = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5); val b = Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED).copy(durationS = 5)
        val s = Sim(a, receiverSpec = b); s.run(25_000); s.receiver.stop()
        assertEquals("CONFIGURATION", s.verdictOf(s.sinkA)); assertEquals("CONFIGURATION", s.verdictOf(s.sinkB))
    }

    @Test fun ackScenarioRunsEndToEndAndRecordsItsPolicyOnBothPhones() {
        val spec = Scenarios.e1Bytes(24, Mode.REALTIME, WindowRelease.ACCEPTED).copy(durationS = 5)
        val s = Sim(spec); s.run(20_000)
        for (sink in listOf(s.sinkA, s.sinkB)) {
            @Suppress("UNCHECKED_CAST") val start = sink.lines.map { MiniJson.parse(it) as Map<String, Any?> }.first { it["type"] == "run_start" }
            @Suppress("UNCHECKED_CAST") val sc = start["scenario"] as Map<String, Any?>
            assertEquals("e1-bytes-rt-24k-ack", sc["id"]); assertEquals("ACCEPTED", sc["window_release"])
        }
        assertEquals("complete", s.sender.status); assertEquals("NONE", s.verdictOf(s.sinkA))
        // acceptance, transfer result and receiver-confirmed delivery remain three separate numbers
        val c = s.sender.ledger.counts(); val r = s.receiver.ledger.counts()
        assertEquals(250L, c.accepted); assertEquals(250L, c.transferSuccess); assertEquals(250L, r.intact)
    }
}

/** Findings 6 and 7. */
class TeardownOrderingTest {
    private val rt = Scenarios.e1Bytes(24, Mode.REALTIME).copy(durationS = 5)
    private fun doneFrame() = FrameCodec.encode(Wire.KIND_DONE, Wire.FLAG_FINAL, 3, Wire.STREAM_CONTROL, 0, 0, ByteArray(0))
    private fun endFrame(n: Long) = FrameCodec.encode(Wire.KIND_END, Wire.FLAG_FINAL, 3, Wire.STREAM_AUDIO, n, 0, ByteArray(4).also { FrameCodec.putU32(it, 0, n) })

    @Suppress("UNCHECKED_CAST") private fun cb(s: Sim) = s.endRecord(s.sinkA)["callbacks"] as Map<String, Any?>

    // ---- Finding 6: premature DONE -----------------------------------------------------------------------------
    @Test fun aDoneBeforeEndIsIgnoredAndCountedAndTheRunContinues() {
        val s = Sim(rt)
        s.run(20_000, hook = { t -> if (t == 4000L) { s.linkA.onBytes(doneFrame(), s.clockA.nowMs()); assertEquals(Phase.RUNNING, s.sender.phase) } })
        assertEquals(250L, s.sender.ledger.counts().generated)
        assertEquals(1L, cb(s)["premature_done_ignored"])
        assertEquals("complete", s.sender.status); assertEquals(true, s.endRecord(s.sinkA)["peer_done_ack"])        // the REAL DONE completed it
    }

    @Test fun aStaleDoneCannotCompleteASessionWhoseRealDoneNeverArrives() {
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 5 }                            // the real DONE is lost
        val s = Sim(rt, f, teardown = false)
        s.run(30_000, hook = { t -> if (t == 4000L) s.linkA.onBytes(doneFrame(), s.clockA.nowMs()) })
        assertEquals("must wait out its timeout, not complete on the stale DONE", "complete_no_done", s.sender.status)
        assertEquals(false, s.endRecord(s.sinkA)["peer_done_ack"]); assertEquals(1L, cb(s)["premature_done_ignored"])
    }

    @Test fun aDoneDuringDrainingIsAlsoIgnored() {
        var injected = false
        val f = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 5 }
        val s = Sim(rt, f, teardown = false)
        s.run(30_000, hook = { _ -> if (!injected && s.senderPhase == Phase.DRAINING) { injected = true; s.linkA.onBytes(doneFrame(), s.clockA.nowMs()) } })
        assertTrue(injected); assertEquals("complete_no_done", s.sender.status); assertEquals(1L, cb(s)["premature_done_ignored"])
    }

    @Test fun aDoneAfterEndStillCompletesAndIsNotCountedAsPremature() {
        val s = Sim(rt); s.run(20_000)
        assertEquals(0L, cb(s)["premature_done_ignored"]); assertEquals("complete", s.sender.status)
    }

    // ---- Finding 7: END rejection classification ---------------------------------------------------------------
    @Test fun anEndResendRejectedBecauseThePeerAlreadyClosedIsNormalTeardown() {
        // resend interval 3540 ms lands in the 20 ms window between the receiver closing (END+3530) and the sender being told (END+3550)
        val spec = rt.copy(endResendIntervalMs = 3_540)
        val lostDone = object : Faults() { override fun lose(kind: Int, seq: Long) = kind == 5 }
        val s = Sim(spec, lostDone); s.run(30_000)
        assertEquals("complete_peer_closed", s.sender.status)
        assertEquals("NONE", s.verdictOf(s.sinkA))
        assertTrue("the rejection must have happened", (cb(s)["end_rejected"] as Long) >= 1L)
        assertEquals("benign: peer closed after END (normal teardown)", cb(s)["end_rejection_disposition"])
    }

    @Test fun endRejectedWhileConnectedAndNeverConfirmedIsAGenuineApiFailure() {
        val reject = object : Faults() { override fun rejectCode(kind: Int, seq: Long) = if (kind == 2) 8012 else null }
        val s = Sim(rt, reject); s.run(30_000)
        assertEquals("complete_no_done", s.sender.status)
        assertTrue((cb(s)["end_rejected"] as Long) >= 3L)
        assertTrue((cb(s)["end_rejection_disposition"] as String).startsWith("ERROR"))
        assertEquals("API", s.verdictOf(s.sinkA))
        @Suppress("UNCHECKED_CAST") val reasons = ((s.endRecord(s.sinkA)["verdict"] as Map<String, Any?>)["reasons"] as Map<String, List<String>>)
        assertTrue(reasons.getValue("API").any { it.contains("END could not be delivered") })
    }

    @Test fun anEarlierRejectedEndThatWasRecoveredAndConfirmedByDoneIsInformationalOnly() {
        var n = 0
        val f = object : Faults() { override fun rejectCode(kind: Int, seq: Long) = if (kind == 2 && n++ == 0) 8012 else null }
        val s = Sim(rt, f); s.run(30_000)
        assertEquals("complete", s.sender.status); assertEquals(1L, cb(s)["end_rejected"])
        assertEquals("benign: receiver confirmed completion with DONE", cb(s)["end_rejection_disposition"])
        assertEquals("NONE", s.verdictOf(s.sinkA)); assertEquals("complete", s.receiver.status)
    }

    @Test fun noEndRejectionMeansNone() { val s = Sim(rt); s.run(20_000); assertEquals("none", cb(s)["end_rejection_disposition"]) }

    // ---- Finding 7: deterministic DONE-versus-disconnect ordering ------------------------------------------------
    private fun bothOrders(disconnectFirst: Boolean): Sim {
        val s = Sim(rt, teardown = false); var fired = false
        s.run(20_000, hook = { _ ->
            if (!fired && s.senderPhase == Phase.ENDING) {
                fired = true
                if (disconnectFirst) { s.linkA.onPeerDisconnected(); s.linkA.onBytes(doneFrame(), s.clockA.nowMs()) }
                else { s.linkA.onBytes(doneFrame(), s.clockA.nowMs()); s.linkA.onPeerDisconnected() }
            }
        })
        return s
    }

    @Test fun doneAndDisconnectRecordedTogetherAlwaysMeanCompleteWhicheverCallbackCameFirst() {
        for (first in listOf(true, false)) {
            val s = bothOrders(first)
            assertEquals("disconnectFirst=$first", "complete", s.sender.status)
            assertEquals(true, s.endRecord(s.sinkA)["peer_done_ack"]); assertEquals("NONE", s.verdictOf(s.sinkA))
        }
    }

    @Test fun aDisconnectWithoutDoneStillMeansCompletePeerClosedAfterEnd() {
        val s = Sim(rt, teardown = false); var fired = false
        s.run(20_000, hook = { _ -> if (!fired && s.senderPhase == Phase.ENDING) { fired = true; s.linkA.onPeerDisconnected() } })
        assertEquals("complete_peer_closed", s.sender.status); assertEquals(false, s.endRecord(s.sinkA)["peer_done_ack"])
    }

    @Test fun receiverCountsAnEndThatArrivedBeforeTheDisconnectWasProcessedWhicheverCallbackCameFirst() {
        for (disconnectFirst in listOf(true, false)) {
            val s = Sim(rt, teardown = false); var fired = false
            s.run(20_000, hook = { _ ->
                if (!fired && s.senderPhase == Phase.ENDING) {
                    fired = true
                    if (disconnectFirst) { s.linkB.onPeerDisconnected(); s.linkB.onBytes(endFrame(250), s.clockB.nowMs()) }
                    else { s.linkB.onBytes(endFrame(250), s.clockB.nowMs()); s.linkB.onPeerDisconnected() }
                }
            })
            assertEquals("disconnectFirst=$disconnectFirst", "complete", s.receiver.status)
            assertEquals("NONE", s.verdictOf(s.sinkB)); assertEquals(250L, s.endRecord(s.sinkB)["expected_frames"])
        }
    }

    @Test fun receiverTreatsADisconnectProcessedBeforeEndAsAnEarlyDisconnect() {
        val s = Sim(rt, teardown = false); var fired = false
        s.run(20_000, hook = { _ -> if (!fired && s.senderPhase == Phase.ENDING) { fired = true; s.linkB.onPeerDisconnected() } })   // real END arrives 30 ms later
        assertEquals("aborted:peer_disconnected", s.receiver.status); assertEquals("DEVICE_DEPENDENT", s.verdictOf(s.sinkB))
    }

    // ---- Finding 1 plumbing: radio failures and readiness metadata reach the run record --------------------------
    @Test fun aRadioFailureReportedByThePlatformIsAConfigurationErrorNotAnApiDefect() {
        val ctx = object : RunContext {
            override fun isolationBreaches() = emptyList<String>(); override fun deviceFlags() = emptySet<DeviceFlag>()
            override fun configErrors() = listOf("radio unavailable: startAdvertising failed STATUS_RADIO_ERROR (turn Bluetooth and Wi-Fi ON and repeat the run)")
            override fun deviceInfo(): Map<String, Any?> = mapOf("model" to "m", "sdk" to 1, "simulated" to false)
        }
        val s = Sim(rt, ctxA = ctx); s.run(20_000)
        assertEquals("CONFIGURATION", s.verdictOf(s.sinkA))
        @Suppress("UNCHECKED_CAST") val reasons = ((s.endRecord(s.sinkA)["verdict"] as Map<String, Any?>)["reasons"] as Map<String, List<String>>)
        assertTrue(reasons.getValue("CONFIGURATION").single().contains("STATUS_RADIO_ERROR")); assertFalse("API" in reasons.keys)
    }

    @Test fun radioAndLocationStateAreWrittenIntoRunStartForBothPhones() {
        fun ctxOf(r: RadioState) = object : RunContext {
            override fun isolationBreaches() = emptyList<String>(); override fun deviceFlags() = emptySet<DeviceFlag>()
            override fun deviceInfo(): Map<String, Any?> = mapOf("model" to "m", "sdk" to 34, "simulated" to false, "radios" to r.toMap(), "readiness_warnings" to listOf("w1"))
        }
        val s = Sim(rt, ctxA = ctxOf(RadioState(true, true, false)), ctxB = ctxOf(RadioState(true, true, null))); s.run(3_100)
        @Suppress("UNCHECKED_CAST") fun dev(sink: com.rideaze.bench.core.measure.MemorySink) =
            (sink.lines.map { MiniJson.parse(it) as Map<String, Any?> }.first { it["type"] == "run_start" }["device"]) as Map<String, Any?>
        assertEquals(linkedMapOf("wifi" to true, "bluetooth" to true, "location_services" to false), dev(s.sinkA)["radios"])
        assertEquals(linkedMapOf("wifi" to true, "bluetooth" to true, "location_services" to null), dev(s.sinkB)["radios"])
        assertEquals(listOf("w1"), dev(s.sinkA)["readiness_warnings"])
    }
}
