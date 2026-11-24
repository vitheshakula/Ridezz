package com.rideaze.bench.core.measure

import com.rideaze.bench.core.MonotonicClock

interface LineSink {
    fun write(line: String)
    fun flush()
    fun close()
}

class MemorySink : LineSink {
    val lines = ArrayList<String>()
    override fun write(line: String) { lines.add(line) }
    override fun flush() {}
    override fun close() {}
}

/** JSON Lines schema v1. Keys per record type; nothing outside these sets may be written. */
object RecordSchema {
    const val VERSION = 1
    val COMMON = setOf("v", "type", "run_id", "role", "t_ms")

    /** type -> (required, optional) */
    val TYPES: Map<String, Pair<Set<String>, Set<String>>> = mapOf(
        "run_start" to (setOf("scenario", "run_index", "epoch", "fingerprint", "device", "thresholds", "unavailable_metrics", "wire_overhead_bytes") to emptySet()),
        "pairing" to (setOf("event", "endpoint_hash", "detail") to emptySet()),
        "probe" to (setOf("seq", "t0", "t1", "t2", "t3", "delay_ms", "offset_ms", "accepted") to emptySet()),
        "sample" to (setOf("cpu_user_ticks", "cpu_system_ticks", "clk_tck", "pss_kb", "batt_pct", "batt_charge_uah", "batt_current_ua", "batt_temp_deci_c", "thermal_status", "power_save", "screen_on", "wifi_on", "bt_on") to emptySet()),
        "event" to (setOf("name", "detail") to emptySet()),
        "frame_tx" to (setOf("seq", "gen_ms", "bytes", "submit", "drop", "reject_code", "transfer", "transfer_before_ack", "submit_ms", "ack_ms", "transfer_ms") to emptySet()),
        "frame_rx" to (setOf("seq", "txms", "rx_ms", "cls", "latency_ms", "uncertainty_ms", "bytes") to emptySet()),
        "run_end" to (setOf("status", "counts", "bytes", "invariants", "parser", "probes", "stalls", "verdict") to setOf("expected_frames", "never_received_upper_bound", "unterminated", "inflight_timeouts", "prbs_mismatch", "wrong_epoch_frames", "callbacks", "callback_latency_ms", "peer_done_ack", "unhandled_audio_frames", "peer_lost")),
    )

    /** Substrings that must never appear in a key at any depth (privacy / production-isolation guard). */
    val FORBIDDEN_KEY_PARTS = listOf("serial", "imei", "android_id", "account", "email", "token", "location", "latitude", "longitude", "ssid", "mac_addr", "bssid", "password", "jwt", "room", "rider", "livekit")

    /**
     * Keys that contain a forbidden substring but are NOT personal data. "location_services" is the on/off state of the device's
     * location SETTING (needed to interpret a failed pairing); it must hold a Boolean or null. Any other "location*" key
     * (coordinates, place names...) stays forbidden.
     */
    val ALLOWED_EXACT_KEYS = setOf("location_services")

    fun validate(rec: Map<String, Any?>): List<String> {
        val errs = ArrayList<String>()
        val type = rec["type"] as? String
        val spec = TYPES[type]
        if (spec == null) { errs.add("unknown type $type"); return errs }
        if ((rec["v"] as? Number)?.toInt() != VERSION) errs.add("bad version")
        val allowed = COMMON + spec.first + spec.second
        for (k in rec.keys) if (k !in allowed) errs.add("unexpected key '$k' in $type")
        for (k in COMMON + spec.first) if (!rec.containsKey(k)) errs.add("missing key '$k' in $type")
        checkKeys(rec, errs)
        return errs
    }

    private fun checkKeys(v: Any?, errs: MutableList<String>) {
        when (v) {
            is Map<*, *> -> for ((k, x) in v) {
                val ks = k.toString().lowercase()
                if (ks in ALLOWED_EXACT_KEYS) { if (x != null && x !is Boolean) errs.add("key '$k' must hold a Boolean or null") }
                else if (FORBIDDEN_KEY_PARTS.any { ks.contains(it) }) errs.add("forbidden key '$k'")
                checkKeys(x, errs)
            }
            is Iterable<*> -> v.forEach { checkKeys(it, errs) }
        }
    }
}

class Recorder(
    private val sink: LineSink,
    val runId: String,
    val role: String,
    private val clock: MonotonicClock,
    /** Tests set this so that every emitted record is schema-checked. */
    private val strict: Boolean = false,
) {
    var recordsWritten = 0L; private set

    @Synchronized private fun emit(type: String, fields: Map<String, Any?>) {
        val m = LinkedHashMap<String, Any?>()
        m["v"] = RecordSchema.VERSION; m["type"] = type; m["run_id"] = runId; m["role"] = role; m["t_ms"] = clock.nowMs()
        m.putAll(fields)
        if (strict) {
            val errs = RecordSchema.validate(m)
            check(errs.isEmpty()) { "schema violation: $errs in $m" }
        }
        sink.write(Json.write(m))
        recordsWritten++
    }

    fun runStart(scenario: Map<String, Any?>, runIndex: Int, epoch: Int, fingerprint: Long, device: Map<String, Any?>, thresholds: Map<String, Any?>, wireOverhead: Int) =
        emit("run_start", mapOf(
            "scenario" to scenario, "run_index" to runIndex, "epoch" to epoch, "fingerprint" to fingerprint,
            "device" to device, "thresholds" to thresholds, "unavailable_metrics" to ResourceSample.UNAVAILABLE_METRICS,
            "wire_overhead_bytes" to wireOverhead,
        ))

    fun pairing(event: String, endpointHash: String?, detail: String) =
        emit("pairing", mapOf("event" to event, "endpoint_hash" to endpointHash, "detail" to detail))

    fun probe(seq: Long, t0: Long, t1: Long, t2: Long, t3: Long, delayMs: Long, offsetMs: Double, accepted: Boolean) =
        emit("probe", mapOf("seq" to seq, "t0" to t0, "t1" to t1, "t2" to t2, "t3" to t3, "delay_ms" to delayMs, "offset_ms" to offsetMs, "accepted" to accepted))

    fun sample(s: ResourceSample) = emit("sample", s.toMap())
    fun event(name: String, detail: String) = emit("event", mapOf("name" to name, "detail" to detail))

    fun frameTx(r: TxRecord) = emit("frame_tx", mapOf(
        "seq" to r.seq, "gen_ms" to r.genMs, "bytes" to r.bytes, "submit" to r.submit, "drop" to r.drop,
        "reject_code" to r.rejectCode, "transfer" to r.transfer, "transfer_before_ack" to r.transferBeforeAck,
        "submit_ms" to r.submitMs, "ack_ms" to r.ackMs, "transfer_ms" to r.transferMs,
    ))

    fun frameRx(r: RxRecord) = emit("frame_rx", mapOf(
        "seq" to r.seq, "txms" to r.txms, "rx_ms" to r.rxMs, "cls" to r.cls,
        "latency_ms" to r.latencyMs, "uncertainty_ms" to r.uncertaintyMs, "bytes" to r.bytes,
    ))

    fun runEnd(fields: Map<String, Any?>) = emit("run_end", fields)
    fun flush() = sink.flush()
    fun close() { sink.flush(); sink.close() }
}
