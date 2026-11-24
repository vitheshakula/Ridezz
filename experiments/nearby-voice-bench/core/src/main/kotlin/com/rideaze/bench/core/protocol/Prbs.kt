package com.rideaze.bench.core.protocol

/**
 * Deterministic synthetic payload (xorshift32). The payload is a pure function of (stream, seq, length),
 * so a receiver can verify content independently of the CRC. It is NOT audio and is not compressible like audio.
 */
object Prbs {
    private fun seed(stream: Int, seq: Long): Int {
        var s = ((seq * 2654435761L) xor ((stream + 1).toLong() * 0x9E3779B9L)) and 0xFFFFFFFFL
        if (s == 0L) s = 0x1234567L
        return s.toInt()
    }

    fun fill(stream: Int, seq: Long, out: ByteArray, off: Int, len: Int) {
        require(off >= 0 && len >= 0 && off + len <= out.size) { "range" }
        var x = seed(stream, seq)
        for (i in 0 until len) {
            x = x xor (x shl 13)
            x = x xor (x ushr 17)
            x = x xor (x shl 5)
            out[off + i] = (x ushr 8).toByte()
        }
    }

    fun generate(stream: Int, seq: Long, len: Int): ByteArray = ByteArray(len).also { fill(stream, seq, it, 0, len) }

    fun verify(stream: Int, seq: Long, data: ByteArray, off: Int = 0, len: Int = data.size - off): Boolean {
        val expected = generate(stream, seq, len)
        for (i in 0 until len) if (expected[i] != data[off + i]) return false
        return true
    }
}
