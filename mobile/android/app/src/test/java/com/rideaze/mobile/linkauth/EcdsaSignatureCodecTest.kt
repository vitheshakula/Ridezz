package com.rideaze.mobile.linkauth

import java.math.BigInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** DER <-> P1363 codec tests. Vectors live in src/test/resources/linkauth (generated once by Node). */
class EcdsaSignatureCodecTest {

  private class Vector(val label: String, val der: ByteArray, val p1363: ByteArray)

  private val order =
    BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

  private val vectors: List<Vector> by lazy { loadVectors() }

  private fun loadVectors(): List<Vector> {
    val text =
      javaClass.getResourceAsStream("/linkauth/ecdsa-der-p1363-vectors.json")!!
        .bufferedReader(Charsets.UTF_8)
        .use { it.readText() }
    val pattern =
      Regex("\"label\":\\s*\"([^\"]*)\",\\s*\"der\":\\s*\"([0-9a-f]+)\",\\s*\"p1363\":\\s*\"([0-9a-f]+)\"")
    return pattern.findAll(text).map { Vector(it.groupValues[1], hex(it.groupValues[2]), hex(it.groupValues[3])) }.toList()
  }

  private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

  private fun scalarBytes(v: BigInteger): ByteArray {
    val raw = v.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
    return ByteArray(32 - raw.size) + raw
  }

  /** Builds raw DER from already-encoded INTEGER element bytes. */
  private fun seq(vararg elements: ByteArray, lengthOverride: Int? = null): ByteArray {
    val body = elements.fold(ByteArray(0)) { a, b -> a + b }
    return byteArrayOf(0x30, (lengthOverride ?: body.size).toByte()) + body
  }

  private fun int(content: ByteArray, tag: Int = 0x02, length: Int? = null): ByteArray =
    byteArrayOf(tag.toByte(), (length ?: content.size).toByte()) + content

  private fun validR(): ByteArray = byteArrayOf(0x11) + ByteArray(31) { (it + 1).toByte() } // 32 bytes, top bit clear
  private fun validS(): ByteArray = byteArrayOf(0x22) + ByteArray(31) { (it + 7).toByte() }

  private fun assertRejectedDer(label: String, der: ByteArray) {
    val before = der.copyOf()
    try {
      EcdsaSignatureCodec.derToP1363(der)
      fail("accepted: $label")
    } catch (e: IllegalArgumentException) {
      assertEquals("Invalid ECDSA signature", e.message) // generic: never echoes input
    }
    assertArrayEquals("input modified: $label", before, der)
  }

  private fun assertRejectedP1363(label: String, p: ByteArray) {
    val before = p.copyOf()
    try {
      EcdsaSignatureCodec.p1363ToDer(p)
      fail("accepted: $label")
    } catch (e: IllegalArgumentException) {
      assertEquals("Invalid ECDSA signature", e.message)
    }
    assertArrayEquals("input modified: $label", before, p)
  }

  // ---- vectors -------------------------------------------------------------------------------

  @Test
  fun vectorFileIsLoadedAndCoversEveryShape() {
    assertTrue("vector count ${vectors.size}", vectors.size >= 20)
    val labels = vectors.joinToString("|") { it.label }
    for (needed in listOf("boundary r=1", "boundary r=n-1", "high-S", "low-S", "r33", "s33", "both33", "short r", "short s", "forced short")) {
      assertTrue("missing coverage: $needed", labels.contains(needed))
    }
  }

  @Test
  fun everyVectorConvertsDerToP1363() {
    for (v in vectors) {
      assertArrayEquals(v.label, v.p1363, EcdsaSignatureCodec.derToP1363(v.der))
    }
  }

  @Test
  fun everyVectorConvertsP1363ToCanonicalDer() {
    for (v in vectors) {
      assertArrayEquals(v.label, v.der, EcdsaSignatureCodec.p1363ToDer(v.p1363))
    }
  }

  @Test
  fun roundTripsAreExactInBothDirections() {
    for (v in vectors) {
      assertArrayEquals(v.label, v.p1363, EcdsaSignatureCodec.derToP1363(EcdsaSignatureCodec.p1363ToDer(v.p1363)))
      assertArrayEquals(v.label, v.der, EcdsaSignatureCodec.p1363ToDer(EcdsaSignatureCodec.derToP1363(v.der)))
    }
  }

  @Test
  fun outputIsAlwaysSixtyFourBytes() {
    for (v in vectors) assertEquals(v.label, 64, EcdsaSignatureCodec.derToP1363(v.der).size)
  }

  @Test
  fun highSIsPreservedNotNormalised() {
    val high = vectors.filter { BigInteger(1, it.p1363.copyOfRange(32, 64)) > order.shiftRight(1) }
    assertTrue("need high-S vectors", high.size >= 2)
    for (v in high) {
      assertArrayEquals(v.label, v.p1363, EcdsaSignatureCodec.derToP1363(v.der))
      assertArrayEquals(v.label, v.der, EcdsaSignatureCodec.p1363ToDer(v.p1363))
    }
  }

  @Test
  fun leadingZeroIsRequiredForTopBitSetAndForbiddenOtherwise() {
    val top = vectors.filter { it.p1363[0].toInt() and 0x80 != 0 }
    assertTrue(top.isNotEmpty())
    for (v in top) assertEquals("r must be 33 bytes with a 0x00 prefix: ${v.label}", 0x00, v.der[4].toInt())
    val low = vectors.filter { it.p1363[0].toInt() and 0x80 == 0 && it.p1363[0].toInt() != 0 }
    for (v in low) assertTrue(v.label, v.der[4].toInt() != 0x00)
  }

  // ---- boundary and range ----------------------------------------------------------------------

  private fun p1363(r: BigInteger, s: BigInteger) = scalarBytes(r) + scalarBytes(s)

  @Test
  fun boundaryValuesOneAndOrderMinusOneRoundTrip() {
    val values = listOf(BigInteger.ONE, BigInteger.valueOf(2), order.subtract(BigInteger.ONE), order.subtract(BigInteger.valueOf(2)))
    for (r in values) for (s in values) {
      val p = p1363(r, s)
      val der = EcdsaSignatureCodec.p1363ToDer(p)
      assertArrayEquals(p, EcdsaSignatureCodec.derToP1363(der))
    }
  }

  @Test
  fun zeroAndOutOfRangeValuesAreRejectedBothWays() {
    val good = BigInteger.valueOf(12345)
    val bad = listOf(BigInteger.ZERO, order, order.add(BigInteger.ONE), BigInteger.ONE.shiftLeft(256).subtract(BigInteger.ONE))
    for (b in bad) {
      assertRejectedP1363("r=$b", p1363Raw(b, good))
      assertRejectedP1363("s=$b", p1363Raw(good, b))
      // the same values as hand-built DER (minimal encoding), so only the range is wrong
      assertRejectedDer("der r=$b", seq(int(derContent(b)), int(derContent(good))))
      assertRejectedDer("der s=$b", seq(int(derContent(good)), int(derContent(b))))
    }
  }

  private fun p1363Raw(r: BigInteger, s: BigInteger): ByteArray {
    fun raw(v: BigInteger): ByteArray {
      val b = v.toByteArray().let { if (it.size > 1 && it[0] == 0.toByte()) it.copyOfRange(1, it.size) else it }
      return ByteArray(maxOf(0, 32 - b.size)) + b.takeLast(32).toByteArray()
    }
    return raw(r) + raw(s)
  }

  /** Minimal DER INTEGER content for a non-negative value (0 -> 00). */
  private fun derContent(v: BigInteger): ByteArray = v.toByteArray()

  // ---- malformed DER ------------------------------------------------------------------------------

  @Test
  fun rejectsEmptyShortAndOversizeInput() {
    assertRejectedDer("empty", ByteArray(0))
    assertRejectedDer("one byte", byteArrayOf(0x30))
    assertRejectedDer("7 bytes", ByteArray(7) { 0x30 })
    val valid = vectors.first().der
    assertRejectedDer("73 bytes", valid + ByteArray(73 - valid.size))
  }

  @Test
  fun rejectsWrongTags() {
    val r = validR()
    val s = validS()
    assertRejectedDer("sequence tag 0x31", seq(int(r), int(s)).also { it[0] = 0x31 })
    assertRejectedDer("integer tag 0x03 for r", seq(int(r, tag = 0x03), int(s)))
    assertRejectedDer("integer tag 0x04 for s", seq(int(r), int(s, tag = 0x04)))
    assertRejectedDer("p1363 passed as DER", ByteArray(64) { 0x01 })
  }

  @Test
  fun rejectsWrongIntegerCount() {
    val r = validR()
    val s = validS()
    assertRejectedDer("one integer", seq(int(r)))
    assertRejectedDer("three integers", seq(int(r), int(s), int(validS())))
    assertRejectedDer("no integers", seq())
    assertRejectedDer("octet string instead of second integer", seq(int(r), byteArrayOf(0x04, 0x01, 0x01)))
  }

  @Test
  fun rejectsLengthProblems() {
    val r = validR()
    val s = validS()
    val good = seq(int(r), int(s))
    assertRejectedDer("sequence length too long", seq(int(r), int(s), lengthOverride = good.size - 1))
    assertRejectedDer("sequence length too short", seq(int(r), int(s), lengthOverride = good.size - 3))
    assertRejectedDer("long-form sequence length 0x81", byteArrayOf(0x30, 0x81.toByte(), (good.size - 2).toByte()) + good.copyOfRange(2, good.size))
    assertRejectedDer("long-form integer length 0x81", byteArrayOf(0x30, (good.size).toByte(), 0x02, 0x81.toByte(), 0x20) + r + int(s))
    assertRejectedDer("integer length overruns", seq(int(r, length = 0x30), int(s)))
    assertRejectedDer("integer length zero", seq(int(ByteArray(0)), int(s)))
    assertRejectedDer("indefinite length 0x80", byteArrayOf(0x30, 0x80.toByte()) + good.copyOfRange(2, good.size))
  }

  @Test
  fun rejectsTrailingData() {
    val good = seq(int(validR()), int(validS()))
    assertRejectedDer("one trailing byte inside the sequence", seq(int(validR()), int(validS()), byteArrayOf(0x00)))
    assertRejectedDer("one trailing byte after the sequence", good + byteArrayOf(0x00))
    assertRejectedDer("a second sequence", good + good)
  }

  @Test
  fun rejectsNegativeIntegers() {
    val negative = byteArrayOf(0x80.toByte()) + ByteArray(31) { 0x01 }
    assertRejectedDer("negative r", seq(int(negative), int(validS())))
    assertRejectedDer("negative s", seq(int(validR()), int(negative)))
    assertRejectedDer("0xff first byte", seq(int(byteArrayOf(0xff.toByte()) + ByteArray(31)), int(validS())))
  }

  @Test
  fun rejectsNonMinimalIntegers() {
    val r = validR() // top bit clear, so a leading zero is superfluous
    assertRejectedDer("superfluous zero on r", seq(int(byteArrayOf(0x00) + r), int(validS())))
    assertRejectedDer("superfluous zero on s", seq(int(validR()), int(byteArrayOf(0x00) + validS())))
    assertRejectedDer("two leading zeros", seq(int(byteArrayOf(0x00, 0x00, 0x7f) + ByteArray(30) { 1 }), int(validS())))
    assertRejectedDer("short value with a superfluous zero", seq(int(byteArrayOf(0x00, 0x05)), int(validS())))
  }

  @Test
  fun rejectsOverlongIntegers() {
    val tooLong = ByteArray(33) { 0x01 }.also { it[0] = 0x01 } // 33 bytes, first byte non-zero
    assertRejectedDer("33 bytes without a zero prefix", seq(int(tooLong), int(validS())))
    val thirtyFour = byteArrayOf(0x00, 0x80.toByte()) + ByteArray(32) { 0x01 }
    assertRejectedDer("34 bytes", seq(int(thirtyFour), int(validS())))
    val zeroThenSmall = byteArrayOf(0x00) + ByteArray(32) { 0x7f }
    assertRejectedDer("33 bytes with a zero prefix but no high bit", seq(int(zeroThenSmall), int(validS())))
  }

  @Test
  fun rejectsZeroAndOrderValuesInDer() {
    assertRejectedDer("r = 0", seq(int(byteArrayOf(0x00)), int(validS())))
    assertRejectedDer("s = 0", seq(int(validR()), int(byteArrayOf(0x00))))
    val n = derContent(order)
    assertRejectedDer("r = n", seq(int(n), int(validS())))
    assertRejectedDer("s = n", seq(int(validR()), int(n)))
    assertRejectedDer("r > n", seq(int(derContent(order.add(BigInteger.ONE))), int(validS())))
  }

  @Test
  fun everyTruncationOfEveryValidDerIsRejected() {
    for (v in vectors) {
      for (len in 0 until v.der.size) {
        assertRejectedDer("${v.label} truncated to $len", v.der.copyOfRange(0, len))
      }
    }
  }

  @Test
  fun everySingleByteAppendOrPrependIsRejected() {
    for (v in vectors.take(6)) {
      for (b in listOf(0x00, 0x30, 0xff)) {
        assertRejectedDer("${v.label} +trailing $b", v.der + byteArrayOf(b.toByte()))
        assertRejectedDer("${v.label} +leading $b", byteArrayOf(b.toByte()) + v.der)
      }
    }
  }

  // ---- P1363 input -----------------------------------------------------------------------------

  @Test
  fun rejectsWrongLengthP1363() {
    val good = vectors.first().p1363
    assertRejectedP1363("empty", ByteArray(0))
    assertRejectedP1363("32 bytes", good.copyOfRange(0, 32))
    assertRejectedP1363("63 bytes", good.copyOfRange(0, 63))
    assertRejectedP1363("65 bytes", good + byteArrayOf(0x01))
    assertRejectedP1363("128 bytes", good + good)
    assertRejectedP1363("a DER signature", vectors.first().der)
  }

  @Test
  fun rejectsAllZeroAndAllFfP1363() {
    assertRejectedP1363("all zero", ByteArray(64))
    assertRejectedP1363("all 0xff", ByteArray(64) { 0xff.toByte() })
    assertRejectedP1363("r zero", ByteArray(32) + vectors.first().p1363.copyOfRange(32, 64))
    assertRejectedP1363("s zero", vectors.first().p1363.copyOfRange(0, 32) + ByteArray(32))
  }

  // ---- immutability and fresh results ---------------------------------------------------------------

  @Test
  fun inputsAreNeverModifiedAndResultsAreFresh() {
    for (v in vectors) {
      val derBefore = v.der.copyOf()
      val pBefore = v.p1363.copyOf()
      val a = EcdsaSignatureCodec.derToP1363(v.der)
      val b = EcdsaSignatureCodec.derToP1363(v.der)
      assertNotSame(a, b)
      a[0] = (a[0] + 1).toByte() // mutating a result must not affect the next call
      assertArrayEquals(pBefore, EcdsaSignatureCodec.derToP1363(v.der))
      val d1 = EcdsaSignatureCodec.p1363ToDer(v.p1363)
      val d2 = EcdsaSignatureCodec.p1363ToDer(v.p1363)
      assertNotSame(d1, d2)
      assertNotSame(v.p1363, EcdsaSignatureCodec.derToP1363(v.der))
      assertArrayEquals(derBefore, v.der)
      assertArrayEquals(pBefore, v.p1363)
    }
  }

  @Test
  fun resultsAreIndependentOfInputAliasing() {
    val v = vectors.first()
    val shared = v.der.copyOf()
    val out = EcdsaSignatureCodec.derToP1363(shared)
    shared.fill(0)
    assertArrayEquals(v.p1363, out)
  }

  @Test
  fun errorMessagesAreGenericAndNeverContainInputBytes() {
    val bad = byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x7e, 0x02, 0x01, 0x00) // s = 0
    try {
      EcdsaSignatureCodec.derToP1363(bad)
      fail()
    } catch (e: IllegalArgumentException) {
      assertFalse(e.message!!.contains("7e"))
      assertEquals("Invalid ECDSA signature", e.message)
      assertEquals(null, e.cause)
    }
  }
}
