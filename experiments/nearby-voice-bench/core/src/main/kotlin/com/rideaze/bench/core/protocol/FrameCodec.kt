package com.rideaze.bench.core.protocol

import com.rideaze.bench.core.U32

/**
 * Wire format v1 (big-endian). Fixed overhead 20 bytes per frame.
 *
 *  0  2  sync   0xA5 0x5A
 *  2  1  ver    0x01
 *  3  1  kind   1 audio, 2 end-of-run, 3 probe, 4 probe reply, 5 done (receiver -> sender)
 *  4  1  flags  bit0 final, bits1-2 hop count, bit3 relayed
 *  5  1  sid    high nibble run epoch, low nibble stream id
 *  6  4  seq
 * 10  4  txms   sender monotonic ms (generation time for audio), mod 2^32
 * 14  2  len    payload length 0..512
 * 16  2  hcrc   CRC-16/CCITT-FALSE over bytes 0..15
 * 18  n  payload
 * 18+n 2 pcrc   CRC-16/CCITT-FALSE over payload
 */
object Wire {
    const val SYNC0 = 0xA5
    const val SYNC1 = 0x5A
    const val VERSION = 1
    const val HEADER_SIZE = 18
    const val TRAILER_SIZE = 2
    const val FIXED_OVERHEAD = HEADER_SIZE + TRAILER_SIZE
    const val MAX_PAYLOAD = 512
    const val MAX_FRAME = FIXED_OVERHEAD + MAX_PAYLOAD

    const val KIND_AUDIO = 1
    const val KIND_END = 2
    const val KIND_PROBE = 3
    const val KIND_PROBE_REPLY = 4
    /** Receiver -> sender: the receiver has finished collecting; the sender may now tear the connection down. */
    const val KIND_DONE = 5
    const val MAX_KIND = 5

    const val STREAM_AUDIO = 0
    const val STREAM_CONTROL = 15

    const val FLAG_FINAL = 0x01
}

data class FrameHeader(
    val version: Int,
    val kind: Int,
    val flags: Int,
    val epoch: Int,
    val stream: Int,
    val seq: Long,
    val txms: Long,
    val len: Int,
)

object FrameCodec {
    fun encode(
        kind: Int,
        flags: Int,
        epoch: Int,
        stream: Int,
        seq: Long,
        txms: Long,
        payload: ByteArray,
        off: Int = 0,
        len: Int = payload.size - off,
    ): ByteArray {
        require(len in 0..Wire.MAX_PAYLOAD) { "payload length $len out of range" }
        require(kind in 1..Wire.MAX_KIND && flags in 0..255 && epoch in 0..15 && stream in 0..15) { "field range" }
        val out = ByteArray(Wire.FIXED_OVERHEAD + len)
        out[0] = Wire.SYNC0.toByte()
        out[1] = Wire.SYNC1.toByte()
        out[2] = Wire.VERSION.toByte()
        out[3] = kind.toByte()
        out[4] = flags.toByte()
        out[5] = ((epoch shl 4) or stream).toByte()
        putU32(out, 6, U32.wrap(seq))
        putU32(out, 10, U32.wrap(txms))
        out[14] = (len ushr 8).toByte()
        out[15] = len.toByte()
        val hcrc = Crc16.ccittFalse(out, 0, 16)
        out[16] = (hcrc ushr 8).toByte()
        out[17] = hcrc.toByte()
        System.arraycopy(payload, off, out, Wire.HEADER_SIZE, len)
        val pcrc = Crc16.ccittFalse(out, Wire.HEADER_SIZE, len)
        out[Wire.HEADER_SIZE + len] = (pcrc ushr 8).toByte()
        out[Wire.HEADER_SIZE + len + 1] = pcrc.toByte()
        return out
    }

    fun putU32(b: ByteArray, off: Int, v: Long) {
        b[off] = (v ushr 24).toByte(); b[off + 1] = (v ushr 16).toByte()
        b[off + 2] = (v ushr 8).toByte(); b[off + 3] = v.toByte()
    }

    fun getU32(b: ByteArray, off: Int): Long =
        ((b[off].toLong() and 0xFF) shl 24) or ((b[off + 1].toLong() and 0xFF) shl 16) or
            ((b[off + 2].toLong() and 0xFF) shl 8) or (b[off + 3].toLong() and 0xFF)

    fun getU16(b: ByteArray, off: Int): Int = ((b[off].toInt() and 0xFF) shl 8) or (b[off + 1].toInt() and 0xFF)

    /** Parses a header that is known to start at [off] with >= 18 bytes available. Does NOT check CRC. */
    internal fun readHeader(b: ByteArray, off: Int): FrameHeader {
        val sid = b[off + 5].toInt() and 0xFF
        return FrameHeader(
            version = b[off + 2].toInt() and 0xFF,
            kind = b[off + 3].toInt() and 0xFF,
            flags = b[off + 4].toInt() and 0xFF,
            epoch = sid ushr 4,
            stream = sid and 0x0F,
            seq = getU32(b, off + 6),
            txms = getU32(b, off + 10),
            len = getU16(b, off + 14),
        )
    }
}
