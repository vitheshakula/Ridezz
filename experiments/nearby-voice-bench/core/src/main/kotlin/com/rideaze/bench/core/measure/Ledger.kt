package com.rideaze.bench.core.measure

/** Pre-submission drop reasons. Relay codes belong to M3 and are intentionally absent. */
enum class DropCode { SRC_FULL, SRC_EXPIRED, WINDOW_FULL, END_OF_RUN }

enum class SubmitState { QUEUED, PENDING, ACCEPTED, REJECTED, DROPPED, UNRESOLVED_SUBMIT }
enum class TransferState { NONE, SUCCESS, FAILED }

class TxRecord(val seq: Long, val genMs: Long, val bytes: Int) {
    var submit = SubmitState.QUEUED
    var drop: DropCode? = null
    var submitMs: Long? = null
    var ackMs: Long? = null
    var rejectCode: Int? = null
    var transfer = TransferState.NONE
    var transferMs: Long? = null
    /** Transfer outcome reported before the submission callback (legal race). */
    var transferBeforeAck = false
}

data class SenderCounts(
    val generated: Long,
    val droppedByCode: Map<DropCode, Long>,
    val queued: Long,
    val pending: Long,
    val accepted: Long,
    val rejected: Long,
    val unresolvedSubmit: Long,
    val transferSuccess: Long,
    val transferFailed: Long,
    val acceptedWithoutTransferReport: Long,
    val transferOnNonAccepted: Long,
    val offeredBytes: Long,
    val acceptedBytes: Long,
) {
    val droppedPre: Long get() = droppedByCode.values.sum()
    val submitted: Long get() = pending + accepted + rejected + unresolvedSubmit
    val unresolvedAtTermination: Long get() = unresolvedSubmit + acceptedWithoutTransferReport
}

/**
 * Sender-side ledger that stays consistent while Nearby callbacks arrive asynchronously, in any order.
 * Submission state and transfer state are tracked independently because a transfer update can legally
 * arrive before the sendPayload() success callback. A successful submission is NEVER treated as delivery.
 */
class SenderLedger {
    private val records = LinkedHashMap<Long, TxRecord>()
    var finalized = false; private set
    var anomalies = 0L; private set
    var callbacksAfterFinalize = 0L; private set
    var duplicateCallbacks = 0L; private set
    var conflictingCallbacks = 0L; private set
    private val anomalyNotes = ArrayList<String>()
    private val apiNotes = ArrayList<String>()

    fun all(): Collection<TxRecord> = records.values
    fun get(seq: Long): TxRecord? = records[seq]

    fun generated(seq: Long, genMs: Long, bytes: Int) {
        if (records.containsKey(seq) || finalized) { anomaly("generated($seq) duplicate or after finalize"); return }
        records[seq] = TxRecord(seq, genMs, bytes)
    }

    fun dropped(seq: Long, code: DropCode) {
        val r = records[seq]
        if (r == null || r.submit != SubmitState.QUEUED) { anomaly("dropped($seq) in state ${r?.submit}"); return }
        r.submit = SubmitState.DROPPED; r.drop = code
    }

    fun submitStarted(seq: Long, nowMs: Long) {
        val r = records[seq]
        if (r == null || r.submit != SubmitState.QUEUED) { anomaly("submitStarted($seq) in state ${r?.submit}"); return }
        r.submit = SubmitState.PENDING; r.submitMs = nowMs
    }

    /**
     * Callbacks come from the platform and may be duplicated, conflicting or out of order. Anything that cannot
     * originate from OUR bookkeeping is recorded as an API anomaly (class API), never as a benchmark defect.
     * A callback for a frame our own logic never submitted is an implementation anomaly (our id mapping is wrong).
     */
    fun accepted(seq: Long, nowMs: Long) {
        val r = records[seq] ?: run { anomaly("accepted($seq) unknown"); return }
        if (finalized) { callbacksAfterFinalize++; return }
        when (r.submit) {
            SubmitState.PENDING -> { r.submit = SubmitState.ACCEPTED; r.ackMs = nowMs; if (r.transfer != TransferState.NONE) r.transferBeforeAck = true }
            SubmitState.ACCEPTED -> { duplicateCallbacks++; apiNote("accepted($seq) reported twice") }
            SubmitState.REJECTED -> { conflictingCallbacks++; apiNote("accepted($seq) after it was rejected") }
            else -> anomaly("accepted($seq) in state ${r.submit}")
        }
    }

    fun rejected(seq: Long, code: Int, nowMs: Long) {
        val r = records[seq] ?: run { anomaly("rejected($seq) unknown"); return }
        if (finalized) { callbacksAfterFinalize++; return }
        when (r.submit) {
            SubmitState.PENDING -> { r.submit = SubmitState.REJECTED; r.rejectCode = code; r.ackMs = nowMs }
            SubmitState.REJECTED -> { duplicateCallbacks++; apiNote("rejected($seq) reported twice") }
            SubmitState.ACCEPTED -> { conflictingCallbacks++; apiNote("rejected($seq) after it was accepted") }
            else -> anomaly("rejected($seq) in state ${r.submit}")
        }
    }

    fun transfer(seq: Long, success: Boolean, nowMs: Long) {
        val r = records[seq] ?: run { anomaly("transfer($seq) unknown"); return }
        if (finalized) { callbacksAfterFinalize++; return }
        if (r.submit == SubmitState.QUEUED || r.submit == SubmitState.DROPPED) { anomaly("transfer($seq) for unsubmitted frame"); return }
        val now = if (success) TransferState.SUCCESS else TransferState.FAILED
        when {
            r.transfer == TransferState.NONE -> {
                r.transfer = now; r.transferMs = nowMs
                if (r.submit == SubmitState.PENDING) r.transferBeforeAck = true
            }
            r.transfer == now -> { duplicateCallbacks++; apiNote("transfer($seq) reported twice") }
            else -> { conflictingCallbacks++; apiNote("transfer($seq) reported both success and failure") }
        }
    }

    /** Final reconciliation: queued frames become END_OF_RUN drops; still-pending submissions become unresolved. */
    fun finalizeRun() {
        if (finalized) return
        for (r in records.values) {
            when (r.submit) {
                SubmitState.QUEUED -> { r.submit = SubmitState.DROPPED; r.drop = DropCode.END_OF_RUN }
                SubmitState.PENDING -> r.submit = SubmitState.UNRESOLVED_SUBMIT
                else -> {}
            }
        }
        finalized = true
    }

    private fun apiNote(n: String) { if (apiNotes.size < 20) apiNotes.add(n) }
    /** Platform callback misbehaviour (duplicate / conflicting / contradictory). Classified API, not IMPLEMENTATION. */
    fun apiAnomalyNotes(): List<String> = apiNotes.toList()

    private fun anomaly(note: String) { anomalies++; if (anomalyNotes.size < 20) anomalyNotes.add(note) }
    fun anomalyNotes(): List<String> = anomalyNotes.toList()

    fun counts(): SenderCounts {
        var queued = 0L; var pending = 0L; var accepted = 0L; var rejected = 0L; var unresolved = 0L
        var tOk = 0L; var tFail = 0L; var accNoT = 0L; var tOnOther = 0L; var offered = 0L; var accBytes = 0L
        val drops = DropCode.values().associateWith { 0L }.toMutableMap()
        for (r in records.values) {
            offered += r.bytes
            when (r.submit) {
                SubmitState.QUEUED -> queued++
                SubmitState.PENDING -> pending++
                SubmitState.ACCEPTED -> { accepted++; accBytes += r.bytes; if (r.transfer == TransferState.NONE) accNoT++ }
                SubmitState.REJECTED -> rejected++
                SubmitState.UNRESOLVED_SUBMIT -> unresolved++
                SubmitState.DROPPED -> drops[r.drop!!] = drops.getValue(r.drop!!) + 1
            }
            if (r.transfer == TransferState.SUCCESS) tOk++
            if (r.transfer == TransferState.FAILED) tFail++
            if (r.transfer != TransferState.NONE && r.submit != SubmitState.ACCEPTED) tOnOther++
        }
        return SenderCounts(records.size.toLong(), drops, queued, pending, accepted, rejected, unresolved, tOk, tFail, accNoT, tOnOther, offered, accBytes)
    }

    /** submit->accept and submit->transfer-result latency (ms), for diagnosing callback semantics. Null = none observed. */
    fun callbackLatency(): Map<String, Any?> {
        val ack = records.values.filter { it.submitMs != null && it.ackMs != null }.map { it.ackMs!! - it.submitMs!! }
        val tr = records.values.filter { it.submitMs != null && it.transferMs != null }.map { it.transferMs!! - it.submitMs!! }
        return linkedMapOf(
            "ack_n" to ack.size, "ack_p50" to Stats.percentile(ack, 50), "ack_p95" to Stats.percentile(ack, 95), "ack_max" to ack.maxOrNull(),
            "transfer_n" to tr.size, "transfer_p50" to Stats.percentile(tr, 50), "transfer_p95" to Stats.percentile(tr, 95), "transfer_max" to tr.maxOrNull(),
        )
    }

    /**
     * Invariants. Valid at ANY moment (asynchronous callbacks in flight) unless noted.
     *  I1 generated = dropped + queued + pending + accepted + rejected + unresolvedSubmit
     *  I2 transfer reports <= submitted frames (a report requires a submission)
     *  I3 (final only) queued = 0 and pending = 0
     *  I4 no ledger anomalies caused by OUR bookkeeping (platform callback misbehaviour is reported via apiAnomalyNotes)
     */
    fun violations(final: Boolean): List<String> {
        val c = counts()
        val v = ArrayList<String>()
        val sum = c.droppedPre + c.queued + c.pending + c.accepted + c.rejected + c.unresolvedSubmit
        if (c.generated != sum) v.add("I1: generated=${c.generated} != sum=$sum")
        if (c.transferSuccess + c.transferFailed > c.submitted) v.add("I2: transfer reports exceed submitted")
        if (final) {
            if (!finalized) v.add("I3: not finalized")
            if (c.queued != 0L || c.pending != 0L) v.add("I3: queued=${c.queued} pending=${c.pending} after finalize")
        }
        if (anomalies > 0) v.add("I4: $anomalies ledger anomalies: ${anomalyNotes.joinToString("; ")}")
        return v
    }
}

enum class RxClass { VALID, ON_TIME, UNCERTAIN, LATE, UNCLASSIFIED, CORRUPT_PAYLOAD }

class RxRecord(
    val seq: Long, val txms: Long, val rxMs: Long, val cls: RxClass,
    val latencyMs: Double?, val uncertaintyMs: Double?, val bytes: Int,
)

data class ReceiverCounts(
    val distinct: Long,
    val byClass: Map<RxClass, Long>,
    val duplicates: Long,
    val wrongEpoch: Long,
    val intactBytes: Long,
) {
    val intact: Long get() = distinct - (byClass[RxClass.CORRUPT_PAYLOAD] ?: 0L)
    val afterDeadline: Long get() = byClass[RxClass.LATE] ?: 0L
}

class ReceiverLedger {
    private val records = LinkedHashMap<Long, RxRecord>()
    var duplicates = 0L; private set
    var wrongEpoch = 0L; private set
    fun all(): Collection<RxRecord> = records.values
    fun has(seq: Long) = records.containsKey(seq)

    fun record(r: RxRecord): Boolean {
        if (records.containsKey(r.seq)) { duplicates++; return false }
        records[r.seq] = r
        return true
    }

    fun wrongEpochFrame() { wrongEpoch++ }

    fun counts(): ReceiverCounts {
        val m = RxClass.values().associateWith { 0L }.toMutableMap()
        var bytes = 0L
        for (r in records.values) { m[r.cls] = m.getValue(r.cls) + 1; if (r.cls != RxClass.CORRUPT_PAYLOAD) bytes += r.bytes }
        return ReceiverCounts(records.size.toLong(), m, duplicates, wrongEpoch, bytes)
    }

    /** R1 distinct = sum of classes (always). */
    fun violations(): List<String> {
        val c = counts()
        val s = c.byClass.values.sum()
        return if (s != c.distinct) listOf("R1: distinct=${c.distinct} != classes=$s") else emptyList()
    }
}

/** Cross-device reconciliation (offline; the two ledgers live on different phones). */
data class Reconciliation(
    val generated: Long,
    val droppedPre: Long,
    val receivedIntact: Long,
    val receivedCorrupt: Long,
    val lostAccepted: Long,
    val lostRejected: Long,
    val lostUnresolvedSubmit: Long,
    val receivedDespiteRejected: Long,
    val receivedDespiteFailedTransfer: Long,
    val receivedUnknownSeq: Long,
    val receivedFromDropped: Long,
) {
    /** Each generated frame lands in exactly one terminal bucket. */
    val terminalSum: Long
        get() = droppedPre + receivedIntact + receivedCorrupt + lostAccepted + lostRejected + lostUnresolvedSubmit
    fun violations(): List<String> {
        val v = ArrayList<String>()
        if (terminalSum != generated) v.add("X1: terminal buckets $terminalSum != generated $generated")
        if (receivedUnknownSeq != 0L) v.add("X2: receiver saw $receivedUnknownSeq seqs the sender never generated")
        if (receivedFromDropped != 0L) v.add("X3: receiver saw $receivedFromDropped frames the sender recorded as dropped before submission")
        return v
    }
}

object Reconciler {
    fun reconcile(tx: SenderLedger, rx: ReceiverLedger): Reconciliation {
        var dropped = 0L; var intact = 0L; var corrupt = 0L; var lostAcc = 0L; var lostRej = 0L; var lostUnres = 0L
        var despiteRej = 0L; var despiteFail = 0L; var fromDropped = 0L
        val known = HashSet<Long>()
        val rxByseq = rx.all().associateBy { it.seq }
        for (t in tx.all()) {
            known.add(t.seq)
            val r = rxByseq[t.seq]
            if (t.submit == SubmitState.DROPPED || t.submit == SubmitState.QUEUED) {
                dropped++
                if (r != null) fromDropped++
                continue
            }
            if (r != null) {
                if (r.cls == RxClass.CORRUPT_PAYLOAD) corrupt++ else intact++
                if (t.submit == SubmitState.REJECTED) despiteRej++
                if (t.transfer == TransferState.FAILED) despiteFail++
            } else when (t.submit) {
                SubmitState.ACCEPTED -> lostAcc++
                SubmitState.REJECTED -> lostRej++
                else -> lostUnres++
            }
        }
        val unknown = rxByseq.keys.count { it !in known }.toLong()
        return Reconciliation(tx.all().size.toLong(), dropped, intact, corrupt, lostAcc, lostRej, lostUnres, despiteRej, despiteFail, unknown, fromDropped)
    }
}
