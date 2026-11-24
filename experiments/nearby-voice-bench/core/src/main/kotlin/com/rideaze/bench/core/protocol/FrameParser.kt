package com.rideaze.bench.core.protocol

sealed interface ParseEvent {
    val header: FrameHeader
    val rxMs: Long
}

/** Header and payload CRC both valid. */
class ValidFrame(override val header: FrameHeader, val payload: ByteArray, override val rxMs: Long) : ParseEvent

/** Header CRC valid (so seq/stream are trusted) but payload CRC failed. */
class CorruptPayloadFrame(override val header: FrameHeader, override val rxMs: Long) : ParseEvent

class ParserCounters {
    var framesValid = 0L
    var hdrCrcFail = 0L
    var lenInvalid = 0L
    var unsupportedHeader = 0L
    var payloadCrcFail = 0L
    var partialTimeout = 0L
    var partialAtEos = 0L
    var oversizedReads = 0L
    var resyncBudgetExceeded = 0L
    var discardedBytes = 0L

    fun toMap(): Map<String, Any?> = linkedMapOf(
        "frames_valid" to framesValid, "hdr_crc_fail" to hdrCrcFail, "len_invalid" to lenInvalid,
        "unsupported_header" to unsupportedHeader, "payload_crc_fail" to payloadCrcFail,
        "partial_timeout" to partialTimeout, "partial_at_eos" to partialAtEos, "oversized_reads" to oversizedReads,
        "resync_budget_exceeded" to resyncBudgetExceeded, "discarded_bytes" to discardedBytes,
    )
}

/**
 * Incremental parser for the wire format. Handles arbitrary read boundaries, several frames per read,
 * partial frames, bad lengths, corrupt headers/payloads, bounded resynchronisation and end of stream.
 *
 * The internal buffer never holds more than [maxBuffer] bytes: input larger than the free space is consumed
 * in chunks and parsed between chunks, and an unparsed remainder is always smaller than one maximum frame
 * (532 bytes) because everything before it is either emitted or discarded.
 *
 * Not thread-safe; callers synchronise.
 */
class FrameParser(
    private val maxBuffer: Int = 4096,
    private val resyncBudget: Int = 4096,
    private val partialTimeoutMs: Long = 500,
) {
    init {
        require(maxBuffer >= Wire.MAX_FRAME * 2) { "buffer must hold at least two maximum frames" }
    }

    val counters = ParserCounters()
    private val buf = ByteArray(maxBuffer)
    private var start = 0
    private var end = 0
    private var scanned = 0
    private var partial = false
    private var lastByteMs = 0L

    val bufferedBytes: Int get() = end - start

    fun feed(data: ByteArray, off: Int, len: Int, nowMs: Long, out: (ParseEvent) -> Unit) {
        require(off >= 0 && len >= 0 && off + len <= data.size) { "range" }
        if (len > maxBuffer) counters.oversizedReads++
        var pos = off
        var remaining = len
        while (remaining > 0) {
            if (start > 0) { // compact
                System.arraycopy(buf, start, buf, 0, end - start)
                end -= start
                start = 0
            }
            val chunk = minOf(remaining, maxBuffer - end)
            check(chunk > 0) { "parser buffer wedged" } // unreachable: leftover < one frame
            System.arraycopy(data, pos, buf, end, chunk)
            end += chunk
            pos += chunk
            remaining -= chunk
            lastByteMs = nowMs
            process(nowMs, out)
        }
    }

    /** Call periodically. Drops a stalled partial frame after [partialTimeoutMs] without new bytes. */
    fun tick(nowMs: Long) {
        if (partial && nowMs - lastByteMs > partialTimeoutMs) {
            counters.partialTimeout++
            discardAll()
        }
    }

    /** End of stream (read returned -1 / link closed). */
    fun endOfStream() {
        if (partial) counters.partialAtEos++
        discardAll()
    }

    private fun discardAll() {
        counters.discardedBytes += (end - start)
        start = 0; end = 0; partial = false
    }

    private fun discard(n: Int) {
        counters.discardedBytes += n
        start += n
        scanned += n
        if (scanned > resyncBudget) {
            counters.resyncBudgetExceeded++
            scanned = 0
            discardAll()
        }
    }

    private fun b(i: Int) = buf[i].toInt() and 0xFF

    private fun process(nowMs: Long, out: (ParseEvent) -> Unit) {
        partial = false
        while (start < end) {
            var i = start
            while (i + 1 < end && !(b(i) == Wire.SYNC0 && b(i + 1) == Wire.SYNC1)) i++
            if (i + 1 >= end) { // no complete sync pair buffered; keep a trailing 0xA5 as a possible sync start
                val keepFrom = if (b(end - 1) == Wire.SYNC0) end - 1 else end
                discard(keepFrom - start)
                return
            }
            if (i > start) {
                discard(i - start)
                if (start >= end) return
            }
            if (end - start < Wire.HEADER_SIZE) { partial = true; return }

            val hcrcWire = FrameCodec.getU16(buf, start + 16)
            if (Crc16.ccittFalse(buf, start, 16) != hcrcWire) {
                counters.hdrCrcFail++
                discard(1)
                continue
            }
            val h = FrameCodec.readHeader(buf, start)
            if (h.version != Wire.VERSION || h.kind !in 1..Wire.MAX_KIND) {
                counters.unsupportedHeader++
                discard(1)
                continue
            }
            if (h.len > Wire.MAX_PAYLOAD) {
                counters.lenInvalid++
                discard(1)
                continue
            }
            val total = Wire.FIXED_OVERHEAD + h.len
            if (end - start < total) { partial = true; return }

            val pcrcWire = FrameCodec.getU16(buf, start + Wire.HEADER_SIZE + h.len)
            if (Crc16.ccittFalse(buf, start + Wire.HEADER_SIZE, h.len) == pcrcWire) {
                counters.framesValid++
                val payload = buf.copyOfRange(start + Wire.HEADER_SIZE, start + Wire.HEADER_SIZE + h.len)
                start += total
                scanned = 0
                out(ValidFrame(h, payload, nowMs))
            } else {
                counters.payloadCrcFail++
                start += total // header CRC passed, so the length is trusted: stay aligned
                scanned = 0
                out(CorruptPayloadFrame(h, nowMs))
            }
        }
        start = 0; end = 0
    }
}
