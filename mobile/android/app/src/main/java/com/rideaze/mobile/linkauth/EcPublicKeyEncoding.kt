package com.rideaze.mobile.linkauth

import java.math.BigInteger
import java.security.interfaces.ECPublicKey
import java.security.spec.ECFieldFp
import java.security.spec.ECPoint

/**
 * Exports an NIST P-256 (secp256r1) public key as the 65-byte uncompressed SEC1 point the Rideaze
 * protocol uses (0x04 || X || Y, 32 bytes each, unsigned big-endian). The node id is the base64url
 * SHA-256 of exactly these bytes.
 *
 * The curve is checked against the P-256 domain parameters themselves, not against a name, and the
 * point must lie on that curve. Only a PUBLIC key is accepted; there is no private-key access.
 * Pure Kotlin/JCA, no Android APIs. Failures throw [IllegalArgumentException] with a generic
 * message.
 */
object EcPublicKeyEncoding {
  const val ENCODED_BYTES = 65
  private const val COORDINATE_BYTES = 32
  private const val UNCOMPRESSED_PREFIX: Byte = 0x04
  private const val ERROR = "Invalid P-256 public key"

  private val P = BigInteger("FFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF", 16)
  private val A = P.subtract(BigInteger.valueOf(3))
  private val B = BigInteger("5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B", 16)
  private val GX = BigInteger("6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296", 16)
  private val GY = BigInteger("4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5", 16)
  private val N = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

  private fun invalid(): Nothing = throw IllegalArgumentException(ERROR)

  fun toUncompressedPoint(key: ECPublicKey): ByteArray {
    val params = key.params ?: invalid()
    val field = params.curve.field
    if (field !is ECFieldFp || field.p != P) invalid()
    if (params.curve.a != A || params.curve.b != B) invalid()
    if (params.generator.affineX != GX || params.generator.affineY != GY) invalid()
    if (params.order != N || params.cofactor != 1) invalid()

    val point = key.w ?: invalid()
    if (point == ECPoint.POINT_INFINITY) invalid()
    val x = point.affineX ?: invalid()
    val y = point.affineY ?: invalid()
    if (x.signum() < 0 || y.signum() < 0 || x >= P || y >= P) invalid()
    // y^2 = x^3 + ax + b (mod p)
    val left = y.multiply(y).mod(P)
    val right = x.multiply(x).multiply(x).add(A.multiply(x)).add(B).mod(P)
    if (left != right) invalid()

    val out = ByteArray(ENCODED_BYTES)
    out[0] = UNCOMPRESSED_PREFIX
    copyCoordinate(x, out, 1)
    copyCoordinate(y, out, 1 + COORDINATE_BYTES)
    return out
  }

  /** Unsigned big-endian, left-padded to 32 bytes; removes only BigInteger's sign byte. */
  private fun copyCoordinate(value: BigInteger, out: ByteArray, offset: Int) {
    var raw = value.toByteArray()
    if (raw.size == COORDINATE_BYTES + 1 && raw[0] == 0.toByte()) {
      raw = raw.copyOfRange(1, raw.size) // the sign byte, nothing else
    }
    if (raw.size > COORDINATE_BYTES) invalid()
    System.arraycopy(raw, 0, out, offset + COORDINATE_BYTES - raw.size, raw.size)
  }
}
