package com.rideaze.bench.core.pairing

import java.security.MessageDigest

enum class PairRole(val code: String) {
    SENDER("S"), RECEIVER("R");
    fun opposite() = if (this == SENDER) RECEIVER else SENDER
}

data class PairingLogEntry(val event: String, val endpointHash: String?, val detail: String, val tMs: Long)

data class ParsedName(val label: String, val role: PairRole, val nonce: String)

sealed interface Initiated {
    /** Show [digits] on screen; the operator must compare with the other phone and confirm or reject. */
    class AwaitOperator(val digits: String) : Initiated
    class Reject(val reason: String) : Initiated
}

sealed interface Decision {
    object Accept : Decision
    class Reject(val reason: String) : Decision
}

/**
 * Test-only admission control for the benchmark. NOT a security boundary against an attacker: it protects the
 * integrity of measurements (no stray peers) and keeps the bench isolated from production Rideaze.
 *
 *  - operator opens a bounded pairing window (default 60 s);
 *  - endpoint name must be `BENCH1|<session label>|<role>|<nonce>` with the same label and the opposite role;
 *  - Nearby's authentication digits are shown on both phones and the operator confirms they match;
 *  - exactly one peer per run; any other connection attempt is rejected AND recorded as an isolation breach;
 *  - if the platform supplies no authentication digits, the connection is REJECTED (never silently skipped);
 *  - no credentials, tokens, ride/room codes or Keystore material are used or accepted.
 */
class PairingGate(
    private val label: String,
    private val role: PairRole,
    private val windowMs: Long = 60_000,
) {
    init { require(label.matches(Regex("[A-Za-z0-9]{1,8}"))) { "label must be 1-8 alphanumerics" } }

    private var openedAtMs: Long? = null
    private var pending: String? = null
    private var pendingDigits: String? = null
    private var connected: String? = null
    private val log = ArrayList<PairingLogEntry>()
    private val breaches = ArrayList<String>()

    val connectedPeer: String? get() = connected
    fun isolationBreaches(): List<String> = breaches.toList()
    fun log(): List<PairingLogEntry> = log.toList()

    fun open(nowMs: Long) { openedAtMs = nowMs; note("window_open", null, "windowMs=$windowMs", nowMs) }
    fun close(nowMs: Long) { openedAtMs = null; note("window_closed", null, "", nowMs) }
    fun isOpen(nowMs: Long): Boolean = openedAtMs?.let { nowMs - it in 0..windowMs } ?: false

    fun advertisedName(nonce: String): String {
        require(nonce.matches(Regex("[A-Za-z0-9]{1,8}")))
        return "BENCH1|$label|${role.code}|$nonce"
    }

    fun parseName(name: String): ParsedName? {
        val p = name.split('|')
        if (p.size != 4 || p[0] != "BENCH1") return null
        val r = PairRole.values().firstOrNull { it.code == p[2] } ?: return null
        return ParsedName(p[1], r, p[3])
    }

    private fun nameProblem(name: String): String? {
        val parsed = parseName(name) ?: return "name_format"
        if (parsed.label != label) return "label_mismatch"
        if (parsed.role != role.opposite()) return "role_not_opposite"
        return null
    }

    /** Discovery filter: should we even request a connection to this endpoint? */
    fun shouldRequest(endpointId: String, name: String, nowMs: Long): Boolean {
        val problem = when {
            !isOpen(nowMs) -> "window_closed"
            connected != null || pending != null -> "peer_already_selected"
            else -> nameProblem(name)
        }
        if (problem != null) { note("discovery_ignored", endpointId, problem, nowMs); return false }
        return true
    }

    fun onConnectionInitiated(endpointId: String, name: String, digits: String?, nowMs: Long): Initiated {
        val problem = when {
            !isOpen(nowMs) -> "window_closed"
            connected != null || (pending != null && pending != endpointId) -> "second_peer"
            nameProblem(name) != null -> nameProblem(name)
            digits.isNullOrBlank() -> "no_authentication_digits"
            else -> null
        }
        if (problem != null) { breach(endpointId, "initiated_rejected:$problem", nowMs); return Initiated.Reject(problem) }
        pending = endpointId; pendingDigits = digits
        note("awaiting_operator", endpointId, "digits_shown", nowMs)
        return Initiated.AwaitOperator(digits!!)
    }

    /** Operator pressed "digits match" ([match] = true) or "reject". */
    fun operatorDecision(endpointId: String, match: Boolean, nowMs: Long): Decision {
        if (pending != endpointId) { breach(endpointId, "operator_decision_for_unknown_endpoint", nowMs); return Decision.Reject("not_pending") }
        if (!isOpen(nowMs)) { clearPending(); breach(endpointId, "operator_decision_after_window", nowMs); return Decision.Reject("window_closed") }
        if (!match) { clearPending(); breach(endpointId, "operator_rejected_digits", nowMs); return Decision.Reject("operator_rejected") }
        note("operator_accepted", endpointId, "", nowMs)
        return Decision.Accept
    }

    fun onConnectionResult(endpointId: String, success: Boolean, nowMs: Long) {
        if (endpointId != pending) {
            if (success) breach(endpointId, "connected_without_pairing", nowMs)
            return
        }
        if (success) { connected = endpointId; note("connected", endpointId, "", nowMs); close(nowMs) }
        else note("connection_failed", endpointId, "", nowMs)
        clearPending()
    }

    fun onDisconnected(endpointId: String, nowMs: Long) {
        if (endpointId == connected) { connected = null; note("peer_disconnected", endpointId, "", nowMs) }
        if (endpointId == pending) clearPending()
    }

    private fun clearPending() { pending = null; pendingDigits = null }

    fun hash(endpointId: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest("$label|$endpointId".toByteArray(Charsets.UTF_8))
        return d.take(4).joinToString("") { "%02x".format(it) }
    }

    private fun breach(endpointId: String, why: String, nowMs: Long) {
        breaches.add("$why@${hash(endpointId)}")
        note("breach", endpointId, why, nowMs)
    }

    private fun note(event: String, endpointId: String?, detail: String, nowMs: Long) {
        log.add(PairingLogEntry(event, endpointId?.let { hash(it) }, detail, nowMs))
    }
}
