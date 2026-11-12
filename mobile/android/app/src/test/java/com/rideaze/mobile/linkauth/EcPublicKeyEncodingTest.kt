package com.rideaze.mobile.linkauth

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.EllipticCurve
import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class EcPublicKeyEncodingTest {

  // Fixed keys and node ids from the TypeScript interoperability vector (Task 2.2).
  private val vectors =
    listOf(
      "zXMcudhd0wBt1cJvJy_B-p5ICiPHdV7nJzPXkiQ8jL0" to
        "BM5IkuRXOhzlhGSMAijSdE7v4whHMHXWQvDMAbBpi8rmnGK7yUqwEOWa60c7boAfRVqrteZmTH8afokYAbQ4MgI",
      "aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o" to
        "BFNLS4_rDi1sR6bJITh_y1UMLYnRFlIiU0Bsy3oqont75-8Xd24to54GJdZ-g5ovDuTnAQarqXriZYeYrg4UF4w",
    )

  private val p256: ECParameterSpec by lazy { paramsFor("secp256r1") }

  private fun paramsFor(name: String): ECParameterSpec =
    AlgorithmParameters.getInstance("EC").run {
      init(ECGenParameterSpec(name))
      getParameterSpec(ECParameterSpec::class.java)
    }

  private fun b64(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

  private fun keyFromPoint(bytes: ByteArray): ECPublicKey {
    val x = BigInteger(1, bytes.copyOfRange(1, 33))
    val y = BigInteger(1, bytes.copyOfRange(33, 65))
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), p256)) as ECPublicKey
  }

  /** A key object that performs no validation of its own, to reach the codec's checks. */
  private class RawKey(
    private val point: ECPoint?,
    private val spec: ECParameterSpec?,
  ) : ECPublicKey {
    override fun getW(): ECPoint? = point
    override fun getParams(): ECParameterSpec? = spec
    override fun getAlgorithm() = "EC"
    override fun getFormat() = "X.509"
    override fun getEncoded(): ByteArray? = null
  }

  private fun assertRejected(label: String, key: ECPublicKey) {
    try {
      EcPublicKeyEncoding.toUncompressedPoint(key)
      fail("accepted: $label")
    } catch (e: IllegalArgumentException) {
      assertEquals("Invalid P-256 public key", e.message)
    }
  }

  private fun generated(count: Int): Sequence<ECPublicKey> = sequence {
    val gen = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
    repeat(count) { yield(gen.generateKeyPair().public as ECPublicKey) }
  }

  private fun uncompressed(key: ECPublicKey): ByteArray {
    fun fixed(v: BigInteger): ByteArray {
      val raw = v.toByteArray().let { if (it.size == 33) it.copyOfRange(1, 33) else it }
      return ByteArray(32 - raw.size) + raw
    }
    return byteArrayOf(0x04) + fixed(key.w.affineX) + fixed(key.w.affineY)
  }

  // ---- accepted ----------------------------------------------------------------------------

  @Test
  fun encodesTheRecordedTypeScriptKeysExactly() {
    for ((_, pub) in vectors) {
      val expected = b64(pub)
      assertEquals(65, expected.size)
      assertArrayEquals(expected, EcPublicKeyEncoding.toUncompressedPoint(keyFromPoint(expected)))
    }
  }

  @Test
  fun nodeIdIsTheBase64UrlSha256OfTheEncodedPoint() {
    for ((nodeId, pub) in vectors) {
      val encoded = EcPublicKeyEncoding.toUncompressedPoint(keyFromPoint(b64(pub)))
      val digest = MessageDigest.getInstance("SHA-256").digest(encoded)
      assertEquals(nodeId, Base64.getUrlEncoder().withoutPadding().encodeToString(digest))
      assertEquals(43, nodeId.length)
    }
  }

  @Test
  fun generatedKeysEncodeToExactly65BytesWithThe04Prefix() {
    for (key in generated(40)) {
      val out = EcPublicKeyEncoding.toUncompressedPoint(key)
      assertEquals(EcPublicKeyEncoding.ENCODED_BYTES, out.size)
      assertEquals(65, out.size)
      assertEquals(0x04.toByte(), out[0])
      assertArrayEquals(uncompressed(key), out)
    }
  }

  @Test
  fun coordinatesAreCorrectlyPaddedAndSignBytesRemoved() {
    var signByteX = 0
    var signByteY = 0
    var shortX = 0
    var shortY = 0
    for (key in generated(1500)) {
      val x = key.w.affineX
      val y = key.w.affineY
      if (x.toByteArray().size == 33) signByteX++
      if (y.toByteArray().size == 33) signByteY++
      if (x.bitLength() <= 248) shortX++
      if (y.bitLength() <= 248) shortY++
      val out = EcPublicKeyEncoding.toUncompressedPoint(key)
      assertEquals(65, out.size)
      assertEquals(x, BigInteger(1, out.copyOfRange(1, 33)))
      assertEquals(y, BigInteger(1, out.copyOfRange(33, 65)))
    }
    // about half of all coordinates have the top bit set (BigInteger adds a sign byte) and
    // about 1 in 256 are at least one byte short (they need zero padding)
    assertTrue("sign-byte X cases: $signByteX", signByteX > 100)
    assertTrue("sign-byte Y cases: $signByteY", signByteY > 100)
    assertTrue("short X cases: $shortX", shortX >= 1)
    assertTrue("short Y cases: $shortY", shortY >= 1)
  }

  @Test
  fun fixedSignByteAndShortCoordinatesFromTheVectors() {
    // the recorded keys are real points; check each coordinate's BigInteger shape against its bytes
    for ((_, pub) in vectors) {
      val bytes = b64(pub)
      val key = keyFromPoint(bytes)
      val out = EcPublicKeyEncoding.toUncompressedPoint(key)
      for (offset in listOf(1, 33)) {
        val coordinate = bytes.copyOfRange(offset, offset + 32)
        assertArrayEquals(coordinate, out.copyOfRange(offset, offset + 32))
        assertEquals(coordinate[0].toInt() and 0x80 != 0, BigInteger(1, coordinate).toByteArray().size == 33)
      }
    }
  }

  @Test
  fun resultsAreFreshAndIndependentOfTheKey() {
    val key = keyFromPoint(b64(vectors[0].second))
    val a = EcPublicKeyEncoding.toUncompressedPoint(key)
    val b = EcPublicKeyEncoding.toUncompressedPoint(key)
    assertNotSame(a, b)
    a.fill(0)
    assertArrayEquals(b64(vectors[0].second), EcPublicKeyEncoding.toUncompressedPoint(key))
    assertArrayEquals(b64(vectors[0].second), b)
  }

  // ---- rejected curves -------------------------------------------------------------------------

  @Test
  fun rejectsOtherNamedCurves() {
    for (name in listOf("secp384r1", "secp521r1")) {
      val gen = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec(name)) }
      assertRejected(name, gen.generateKeyPair().public as ECPublicKey)
    }
  }

  private fun paramsWith(
    p: BigInteger = p256.curve.field.let { (it as ECFieldFp).p },
    a: BigInteger = p256.curve.a,
    b: BigInteger = p256.curve.b,
    generator: ECPoint = p256.generator,
    order: BigInteger = p256.order,
    cofactor: Int = p256.cofactor,
  ) = ECParameterSpec(EllipticCurve(ECFieldFp(p), a, b), generator, order, cofactor)

  @Test
  fun rejectsLookAlikeCurveParameters() {
    val point = keyFromPoint(b64(vectors[0].second)).w
    assertRejected("different b", RawKey(point, paramsWith(b = p256.curve.b.add(BigInteger.ONE))))
    assertRejected("different a", RawKey(point, paramsWith(a = p256.curve.a.add(BigInteger.ONE))))
    assertRejected("different order", RawKey(point, paramsWith(order = p256.order.add(BigInteger.valueOf(2)))))
    assertRejected("different cofactor", RawKey(point, paramsWith(cofactor = 2)))
    assertRejected("different generator", RawKey(point, paramsWith(generator = point)))
    assertRejected("different field prime", RawKey(point, paramsWith(p = (p256.curve.field as ECFieldFp).p.add(BigInteger.valueOf(2)))))
    assertRejected("missing params", RawKey(point, null))
    RawKey(point, paramsWith()).let { EcPublicKeyEncoding.toUncompressedPoint(it) } // control: accepted
  }

  // ---- rejected points -----------------------------------------------------------------------------

  @Test
  fun rejectsPointsOffTheCurve() {
    val good = keyFromPoint(b64(vectors[0].second)).w
    assertRejected("y off by one", RawKey(ECPoint(good.affineX, good.affineY.add(BigInteger.ONE)), p256))
    assertRejected("x off by one", RawKey(ECPoint(good.affineX.add(BigInteger.ONE), good.affineY), p256))
    assertRejected("swapped coordinates", RawKey(ECPoint(good.affineY, good.affineX), p256))
    assertRejected("origin (0,0)", RawKey(ECPoint(BigInteger.ZERO, BigInteger.ZERO), p256))
    assertRejected("(1,1)", RawKey(ECPoint(BigInteger.ONE, BigInteger.ONE), p256))
  }

  @Test
  fun rejectsInfinityMissingAndMalformedPoints() {
    assertRejected("infinity", RawKey(ECPoint.POINT_INFINITY, p256))
    assertRejected("null point", RawKey(null, p256))
  }

  @Test
  fun rejectsNegativeAndOversizedCoordinates() {
    val good = keyFromPoint(b64(vectors[0].second)).w
    val p = (p256.curve.field as ECFieldFp).p
    // x + p and y + p satisfy the curve equation mod p but are not canonical field elements
    assertRejected("x + p", RawKey(ECPoint(good.affineX.add(p), good.affineY), p256))
    assertRejected("y + p", RawKey(ECPoint(good.affineX, good.affineY.add(p)), p256))
    assertRejected("x - p (negative)", RawKey(ECPoint(good.affineX.subtract(p), good.affineY), p256))
    assertRejected("y negated", RawKey(ECPoint(good.affineX, good.affineY.negate()), p256))
    assertRejected("x = p", RawKey(ECPoint(p, good.affineY), p256))
    assertRejected("33-byte magnitude", RawKey(ECPoint(BigInteger.ONE.shiftLeft(256), good.affineY), p256))
    assertRejected("huge", RawKey(ECPoint(BigInteger.ONE.shiftLeft(4096), BigInteger.ONE.shiftLeft(4096)), p256))
  }

  @Test
  fun anAcceptedKeyNeverExposesPrivateMaterialInTheOutput() {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val out = EcPublicKeyEncoding.toUncompressedPoint(pair.public as ECPublicKey)
    val privateBytes = (pair.private as java.security.interfaces.ECPrivateKey).s.toByteArray().let {
      if (it.size == 33) it.copyOfRange(1, 33) else it
    }
    assertEquals(65, out.size)
    assertTrue(privateBytes.size < 4 || out.toList().windowed(privateBytes.size).none { it == privateBytes.toList() })
  }
}
