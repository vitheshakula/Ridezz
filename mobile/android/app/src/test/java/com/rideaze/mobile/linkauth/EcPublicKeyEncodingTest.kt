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

  /**
   * Real secp256r1 points whose coordinates have leading zero bytes, found once with Node's crypto
   * and checked on the curve with independent BigInteger arithmetic. `sec1Hex` is 04 || X || Y as
   * exported by Node (JWK x and y), NOT produced by the encoder under test; `nodeId` is the
   * base64url SHA-256 of those bytes. No private keys are kept.
   */
  private class FixedPoint(val label: String, val sec1Hex: String, val nodeId: String)

  private val zeroPrefixedPoints =
    listOf(
      FixedPoint("X has one leading zero byte", "0400c6a9b9543486bf52d0d84d7452c86620dda1eabc8d63718c55326903a61a0ccdc969500ef15dc9a05b0f8a0102843bbd59a8753ca2c18cb4eea84cb7be2196", "IwwLzThZ1qCDqrP0FzKlhUVsdgdZvirRFZossvjQ27M"),
      FixedPoint("X has two leading zero bytes", "04000064b99339a6f373db058d28a912098b30eaeee6ad83f94b4e6ac0ce8f226a32906858df8390264bf0547b16cb3706d03ed7013249466c247612ba3194d38e", "AVNY7WjV2euPL32RPVSbpic8cHxbGU-d30xp79HELsU"),
      FixedPoint("Y has two leading zero bytes", "04ed2ee98496ad7c7aa500f32ca38b7c3f81e48f37a52808d46624e0feaeee0b84000029fdd364c816136817043b225cfc5797ab9cb2a4e46bf39f3fe80aecd616", "3DaecwXoFRg9mqFVM6VoUo7VbyJuogOigWU1kSnwhRg"),
      FixedPoint("X and Y both have a leading zero byte", "0400f44ce3854083c6a6a247cb31e55384c4417cb1341650d5b0baae07b2d99d9b00544c1fa6f000f23208082e6a890434c0efad5cb36adf561b559a20efe0820e", "KpwPOZoT1zSdsDOr3fUfQWMcrDJlW0riGhNB0k6FsK0"),
    )

  private fun hexBytes(hex: String): ByteArray =
    ByteArray(hex.length / 2) { hex.substring(2 * it, 2 * it + 2).toInt(16).toByte() }

  @Test
  fun leadingZeroCoordinatesArePaddedToExactly32BytesDeterministically() {
    for (fixed in zeroPrefixedPoints) {
      val expected = hexBytes(fixed.sec1Hex)
      assertEquals(fixed.label, 65, expected.size)
      val key = keyFromPoint(expected)
      // the BigInteger really is shorter than 32 bytes, so padding is what is being tested
      val shortX = key.w.affineX.bitLength() <= 248
      val shortY = key.w.affineY.bitLength() <= 248
      assertTrue("${fixed.label}: expected a short coordinate", shortX || shortY)
      val out = EcPublicKeyEncoding.toUncompressedPoint(key)
      assertArrayEquals(fixed.label, expected, out)
      val digest = MessageDigest.getInstance("SHA-256").digest(out)
      assertEquals(fixed.label, fixed.nodeId, Base64.getUrlEncoder().withoutPadding().encodeToString(digest))
    }
    val first = zeroPrefixedPoints.map { keyFromPoint(hexBytes(it.sec1Hex)) }
    assertTrue(first[0].w.affineX.bitLength() <= 248) // one leading zero byte on X
    assertTrue(first[1].w.affineX.bitLength() <= 240) // two on X
    assertTrue(first[2].w.affineY.bitLength() <= 240) // two on Y
    assertTrue(first[3].w.affineX.bitLength() <= 248 && first[3].w.affineY.bitLength() <= 248)
  }

  @Test
  fun generatedKeysAlwaysRoundTripAndSignBytesAreStripped() {
    // random keys: the exact value is checked against an independent reconstruction every time;
    // the sign-byte counts are only a sanity check on the sample (about half of all coordinates)
    var signByte = 0
    for (key in generated(300)) {
      val x = key.w.affineX
      val y = key.w.affineY
      if (x.toByteArray().size == 33) signByte++
      if (y.toByteArray().size == 33) signByte++
      val out = EcPublicKeyEncoding.toUncompressedPoint(key)
      assertEquals(65, out.size)
      assertEquals(x, BigInteger(1, out.copyOfRange(1, 33)))
      assertEquals(y, BigInteger(1, out.copyOfRange(33, 65)))
    }
    assertTrue("sign-byte coordinates: $signByte of 600", signByte > 150)
  }

  @Test
  fun signByteCoordinatesFromTheRecordedVectors() {
    // the recorded keys are real points; check each coordinate's BigInteger shape against its bytes
    var withSignByte = 0
    for ((_, pub) in vectors) {
      val bytes = b64(pub)
      val key = keyFromPoint(bytes)
      val out = EcPublicKeyEncoding.toUncompressedPoint(key)
      for (offset in listOf(1, 33)) {
        val coordinate = bytes.copyOfRange(offset, offset + 32)
        assertArrayEquals(coordinate, out.copyOfRange(offset, offset + 32))
        val topBit = coordinate[0].toInt() and 0x80 != 0
        assertEquals(topBit, BigInteger(1, coordinate).toByteArray().size == 33)
        if (topBit) withSignByte++
      }
    }
    assertTrue("the recorded vectors must include sign-byte coordinates", withSignByte >= 2)
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
