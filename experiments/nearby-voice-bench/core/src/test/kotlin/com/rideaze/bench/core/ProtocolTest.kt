package com.rideaze.bench.core

import com.rideaze.bench.core.protocol.Crc16
import com.rideaze.bench.core.protocol.CorruptPayloadFrame
import com.rideaze.bench.core.protocol.FrameCodec
import com.rideaze.bench.core.protocol.FrameParser
import com.rideaze.bench.core.protocol.ParseEvent
import com.rideaze.bench.core.protocol.Prbs
import com.rideaze.bench.core.protocol.ValidFrame
import com.rideaze.bench.core.protocol.Wire
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.Random

class Crc16Test {
    @Test fun knownAnswerCheckString() {
        assertEquals(0x29B1, Crc16.ccittFalse("123456789".toByteArray(Charsets.US_ASCII)))
    }
    @Test fun emptyInputIsInitValue() { assertEquals(0xFFFF, Crc16.ccittFalse(ByteArray(0))) }
    @Test fun offsetAndLengthSelectRange() {
        val d = "xx123456789yy".toByteArray(Charsets.US_ASCII)
        assertEquals(0x29B1, Crc16.ccittFalse(d, 2, 9))
    }
    @Test fun singleBitFlipChangesCrc() {
        val d = ByteArray(40) { it.toByte() }
        val base = Crc16.ccittFalse(d)
        for (i in d.indices) for (b in 0 until 8) {
            val c = d.copyOf(); c[i] = (c[i].toInt() xor (1 shl b)).toByte()
            assertTrue("bit $i/$b undetected", Crc16.ccittFalse(c) != base)
        }
    }
}

class PrbsTest {
    @Test fun deterministic() { assertArrayEquals(Prbs.generate(0, 7, 60), Prbs.generate(0, 7, 60)) }
    @Test fun differsBySeqAndStream() {
        assertFalse(Prbs.generate(0, 7, 60).contentEquals(Prbs.generate(0, 8, 60)))
        assertFalse(Prbs.generate(0, 7, 60).contentEquals(Prbs.generate(1, 7, 60)))
    }
    @Test fun verifyDetectsChange() {
        val p = Prbs.generate(0, 3, 80)
        assertTrue(Prbs.verify(0, 3, p))
        p[10] = (p[10].toInt() xor 1).toByte()
        assertFalse(Prbs.verify(0, 3, p))
        assertFalse(Prbs.verify(0, 4, Prbs.generate(0, 3, 80)))
    }
    @Test fun seqZeroAndHighSeqAreUsable() {
        assertTrue(Prbs.generate(0, 0, 16).any { it.toInt() != 0 })
        assertTrue(Prbs.generate(0, 0xFFFFFFFFL, 16).any { it.toInt() != 0 })
    }
}

class FrameCodecTest {
    private fun frame(seq: Long, len: Int = 60, kind: Int = Wire.KIND_AUDIO, epoch: Int = 3, txms: Long = 1000 + seq * 20) =
        FrameCodec.encode(kind, 0, epoch, 0, seq, txms, Prbs.generate(0, seq, len))

    private fun parse(parser: FrameParser, bytes: ByteArray, now: Long = 0, off: Int = 0, len: Int = bytes.size - off): List<ParseEvent> {
        val out = ArrayList<ParseEvent>()
        parser.feed(bytes, off, len, now) { out.add(it) }
        return out
    }

    private fun seqs(e: List<ParseEvent>) = e.map { it.header.seq }

    @Test fun overheadIsExactlyTwentyBytes() {
        assertEquals(20, Wire.FIXED_OVERHEAD)
        for (n in listOf(0, 1, 30, 60, 240, 512)) assertEquals(20 + n, frame(1, n).size)
    }

    @Test fun exactBytesOfKnownFrame() {
        val f = FrameCodec.encode(1, 0, 2, 0, 1, 0x01020304L, byteArrayOf(0xAA.toByte(), 0xBB.toByte()))
        val expectedHead = intArrayOf(0xA5, 0x5A, 0x01, 0x01, 0x00, 0x20, 0, 0, 0, 1, 1, 2, 3, 4, 0, 2)
        for (i in expectedHead.indices) assertEquals("byte $i", expectedHead[i], f[i].toInt() and 0xFF)
        assertEquals(Crc16.ccittFalse(f, 0, 16), FrameCodec.getU16(f, 16))
        assertEquals(0xAA, f[18].toInt() and 0xFF)
        assertEquals(Crc16.ccittFalse(byteArrayOf(0xAA.toByte(), 0xBB.toByte())), FrameCodec.getU16(f, 20))
        assertEquals(22, f.size)
    }

    @Test fun roundTripFields() {
        val f = FrameCodec.encode(Wire.KIND_END, Wire.FLAG_FINAL, 9, 5, 0xFFFFFFFEL, 0xFFFFFFF0L, byteArrayOf(1, 2, 3))
        val e = parse(FrameParser(), f).single() as ValidFrame
        assertEquals(Wire.KIND_END, e.header.kind); assertEquals(1, e.header.flags); assertEquals(9, e.header.epoch)
        assertEquals(5, e.header.stream); assertEquals(0xFFFFFFFEL, e.header.seq); assertEquals(0xFFFFFFF0L, e.header.txms)
        assertArrayEquals(byteArrayOf(1, 2, 3), e.payload)
    }

    @Test fun maxPayloadAccepted_overMaxRejectedByEncoder() {
        val e = parse(FrameParser(), frame(1, 512)).single() as ValidFrame
        assertEquals(512, e.payload.size)
        try { frame(1, 513); fail() } catch (_: IllegalArgumentException) {}
    }

    @Test fun severalFramesInOneRead() {
        val all = (0L until 6).fold(ByteArray(0)) { a, s -> a + frame(s) }
        assertEquals((0L until 6).toList(), seqs(parse(FrameParser(), all)))
    }

    @Test fun frameSplitAtEveryByteBoundary() {
        val f = frame(5) + frame(6)
        for (cut in 1 until f.size) {
            val p = FrameParser()
            val out = parse(p, f, 0, 0, cut) + parse(p, f, 1, cut, f.size - cut)
            assertEquals("cut=$cut", listOf(5L, 6L), seqs(out))
            assertTrue(out.all { it is ValidFrame })
            assertEquals("cut=$cut discarded", 0L, p.counters.discardedBytes)
        }
    }

    @Test fun byteAtATime() {
        val all = (0L until 5).fold(ByteArray(0)) { a, s -> a + frame(s) }
        val p = FrameParser(); val out = ArrayList<ParseEvent>()
        for (i in all.indices) p.feed(all, i, 1, i.toLong()) { out.add(it) }
        assertEquals((0L until 5).toList(), seqs(out))
    }

    @Test fun randomReadBoundaries_200Frames_fixedSeed() {
        val all = (0L until 200).fold(ByteArray(0)) { a, s -> a + frame(s, 20 + (s % 7).toInt() * 30) }
        val rnd = Random(12345)
        val p = FrameParser(); val out = ArrayList<ParseEvent>()
        var pos = 0
        while (pos < all.size) {
            val n = minOf(1 + rnd.nextInt(700), all.size - pos)
            p.feed(all, pos, n, pos.toLong()) { out.add(it) }; pos += n
        }
        assertEquals((0L until 200).toList(), seqs(out))
        assertEquals(0L, p.counters.discardedBytes)
    }

    @Test fun garbagePrefixAndLoneSyncByteAreSkipped() {
        val p = FrameParser()
        val junk = byteArrayOf(0x00, 0xA5.toByte(), 0x11, 0xA5.toByte(), 0x5A, 0x77) // contains a sync pair with bad header
        val out = parse(p, junk + frame(1))
        assertEquals(listOf(1L), seqs(out))
        assertTrue(p.counters.discardedBytes > 0)
    }

    @Test fun corruptSyncLosesThatFrameOnly() {
        val bad = frame(1); bad[0] = 0xA4.toByte()
        val p = FrameParser()
        assertEquals(listOf(2L), seqs(parse(p, bad + frame(2))))
    }

    @Test fun corruptHeaderByteIsCaughtByHeaderCrcAndStreamRecovers() {
        for (idx in 2..15) {
            val bad = frame(1); bad[idx] = (bad[idx].toInt() xor 0x40).toByte()
            val p = FrameParser()
            val out = parse(p, bad + frame(2) + frame(3))
            assertEquals("idx=$idx", listOf(2L, 3L), seqs(out))
            assertEquals("idx=$idx", 1L, p.counters.hdrCrcFail)
        }
    }

    @Test fun corruptedButInRangeLengthDoesNotCascade() {
        val bad = frame(1, 60); bad[15] = 61 // len 60 -> 61 without fixing hcrc
        val p = FrameParser()
        val out = parse(p, bad + frame(2) + frame(3))
        assertEquals(listOf(2L, 3L), seqs(out))
        assertEquals(1L, p.counters.hdrCrcFail)
        assertEquals(0L, p.counters.lenInvalid)
    }

    @Test fun lengthAboveMaxWithValidHeaderCrcIsRejected() {
        val h = frame(1, 10).copyOf(18)
        h[14] = 0x02; h[15] = 0x01 // len 513
        val c = Crc16.ccittFalse(h, 0, 16); h[16] = (c ushr 8).toByte(); h[17] = c.toByte()
        val p = FrameParser()
        assertEquals(listOf(2L), seqs(parse(p, h + ByteArray(40) + frame(2))))
        assertEquals(1L, p.counters.lenInvalid)
    }

    @Test fun unsupportedVersionAndKindWithValidCrc() {
        val v = frame(1).copyOf(); v[2] = 2
        var c = Crc16.ccittFalse(v, 0, 16); v[16] = (c ushr 8).toByte(); v[17] = c.toByte()
        val k = frame(2).copyOf(); k[3] = 9
        c = Crc16.ccittFalse(k, 0, 16); k[16] = (c ushr 8).toByte(); k[17] = c.toByte()
        val p = FrameParser()
        assertEquals(listOf(3L), seqs(parse(p, v + k + frame(3))))
        assertEquals(2L, p.counters.unsupportedHeader)
    }

    @Test fun corruptPayloadKeepsAlignmentAndAttributesSeq() {
        val bad = frame(7, 60); bad[30] = (bad[30].toInt() xor 0xFF).toByte()
        val p = FrameParser()
        val out = parse(p, frame(6) + bad + frame(8))
        assertEquals(listOf(6L, 7L, 8L), seqs(out))
        assertTrue(out[1] is CorruptPayloadFrame)
        assertEquals(1L, p.counters.payloadCrcFail)
        assertEquals("stays aligned, no resync", 0L, p.counters.discardedBytes)
    }

    @Test fun syncBytesInsidePayloadDoNotConfuseParser() {
        val payload = ByteArray(60) { if (it % 2 == 0) 0xA5.toByte() else 0x5A }
        val f = FrameCodec.encode(1, 0, 3, 0, 1, 0, payload)
        val out = parse(FrameParser(), f + frame(2))
        assertEquals(listOf(1L, 2L), seqs(out))
        assertArrayEquals(payload, (out[0] as ValidFrame).payload)
    }

    @Test fun resyncBudgetBoundsGarbageScanning() {
        val p = FrameParser()
        parse(p, ByteArray(10_000) { 0x00 })
        assertTrue(p.counters.resyncBudgetExceeded >= 1)
        assertEquals("buffer is bounded", 0, p.bufferedBytes)
        assertEquals(listOf(9L), seqs(parse(p, frame(9))))
    }

    @Test fun oversizedReadIsConsumedInChunksWithoutLoss() {
        val all = (0L until 12).fold(ByteArray(0)) { a, s -> a + frame(s, 400) } // ~5 KB > 4 KiB buffer
        assertTrue(all.size > 4096)
        val p = FrameParser()
        assertEquals((0L until 12).toList(), seqs(parse(p, all)))
        assertEquals(1L, p.counters.oversizedReads)
    }

    @Test fun partialFrameTimesOutAfter500msWithoutBytes() {
        val p = FrameParser(); val f = frame(1)
        parse(p, f, 1000, 0, 10)
        p.tick(1400); assertEquals(0L, p.counters.partialTimeout)
        p.tick(1501); assertEquals(1L, p.counters.partialTimeout)
        assertEquals(0, p.bufferedBytes)
        assertEquals(listOf(2L), seqs(parse(p, frame(2), 2000)))
    }

    @Test fun progressResetsPartialTimer() {
        val p = FrameParser(); val f = frame(1)
        parse(p, f, 1000, 0, 10); parse(p, f, 1400, 10, 10)
        p.tick(1800); assertEquals(0L, p.counters.partialTimeout)
        assertEquals(listOf(1L), seqs(parse(p, f, 1850, 20, f.size - 20)))
    }

    @Test fun endOfStreamCountsPartialOnly() {
        val p = FrameParser(); val f = frame(1)
        parse(p, f, 0, 0, 25)
        p.endOfStream(); assertEquals(1L, p.counters.partialAtEos); assertEquals(0, p.bufferedBytes)
        val q = FrameParser(); parse(q, f); q.endOfStream(); assertEquals(0L, q.counters.partialAtEos)
    }

    @Test fun fuzzCorruptionNeverCrashesAndNeverEmitsWrongPayloadAsValid() {
        val rnd = Random(777)
        val clean = (0L until 300).fold(ByteArray(0)) { a, s -> a + frame(s, 40) }
        repeat(40) {
            val d = clean.copyOf()
            repeat(1 + rnd.nextInt(30)) { d[rnd.nextInt(d.size)] = rnd.nextInt(256).toByte() }
            val p = FrameParser(); val out = ArrayList<ParseEvent>()
            var pos = 0
            while (pos < d.size) { val n = minOf(1 + rnd.nextInt(300), d.size - pos); p.feed(d, pos, n, 0) { out.add(it) }; pos += n }
            for (e in out) if (e is ValidFrame) assertTrue("valid frame must carry its own PRBS", Prbs.verify(0, e.header.seq, e.payload))
            assertTrue(out.size <= 300)
        }
    }
}
