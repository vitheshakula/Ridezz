package com.rideaze.bench.core.protocol

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no xorout. Check("123456789") = 0x29B1. */
object Crc16 {
    fun ccittFalse(data: ByteArray, off: Int = 0, len: Int = data.size - off): Int {
        require(off >= 0 && len >= 0 && off + len <= data.size) { "range" }
        var crc = 0xFFFF
        for (i in off until off + len) {
            crc = crc xor ((data[i].toInt() and 0xFF) shl 8)
            for (bit in 0 until 8) {
                crc = if ((crc and 0x8000) != 0) (crc shl 1) xor 0x1021 else crc shl 1
                crc = crc and 0xFFFF
            }
        }
        return crc
    }
}
