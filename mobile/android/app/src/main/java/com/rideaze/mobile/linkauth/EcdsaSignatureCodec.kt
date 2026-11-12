package com.rideaze.mobile.linkauth

import java.math.BigInteger

/**
 * Strict conversion between the DER ECDSA signatures produced by the Android Keystore
 * (SHA256withECDSA) and the 64-byte IEEE P1363 form (r || s, 32 bytes each) that the Rideaze
 * protocol and its TypeScript verifier require.
 *
 * Pure Kotlin: no Android APIs, no logging, no state. Inputs are never modified and results are
 * always fresh arrays. Anything that is not a canonical P-256 signature is rejected with an
 * [IllegalArgumentException] carrying a generic message (no input bytes are ever echoed).
 *
 * S is never normalised: high-S signatures are valid here, exactly as the Keystore and Node
 * produce them and as the TypeScript adapter accepts them (`lowS: false`). Signatures are therefore
 * malleable and must never be used as identifiers.
 */
object EcdsaSignatureCodec {
  private val ORDER =
    BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

  private const val SCALAR_BYTES = 32
  private const val P1363_BYTES = 64
  private const val MIN_DER_BYTES = 8 // 30 06 02 01 r 02 01 s
  private const val MAX_DER_BYTES = 72 // 30 46 02 21 <33> 02 21 <33>
  private const val TAG_SEQUENCE = 0x30
  private const val TAG_INTEGER = 0x02
  private const val MAX_SHORT_LENGTH = 0x7f
  private const val MAX_INTEGER_CONTENT = SCALAR_BYTES + 1 // one sign byte at most

  private const val INVALID = "Invalid ECDSA signature"

  private fun invalid(): Nothing = throw IllegalArgumentException(INVALID)

  /** DER SEQUENCE { INTEGER r, INTEGER s } -> r || s (64 bytes). */
  fun derToP1363(der: ByteArray): ByteArray {
    if (der.size < MIN_DER_BYTES || der.size > MAX_DER_BYTES) invalid()
    if (unsigned(der[0]) != TAG_SEQUENCE) invalid()
    val sequenceLength = unsigned(der[1])
    // Short-form only: a P-256 signature never needs more, and long forms are non-canonical.
    if (sequenceLength > MAX_SHORT_LENGTH || sequenceLength != der.size - 2) invalid()

    val r = readInteger(der, 2)
    val s = readInteger(der, r.next)
    if (s.next != der.size) invalid() // trailing data

    val out = ByteArray(P1363_BYTES)
    System.arraycopy(r.scalar, 0, out, 0, SCALAR_BYTES)
    System.arraycopy(s.scalar, 0, out, SCALAR_BYTES, SCALAR_BYTES)
    return out
  }

  /** r || s (exactly 64 bytes) -> canonical minimal DER. */
  fun p1363ToDer(p1363: ByteArray): ByteArray {
    if (p1363.size != P1363_BYTES) invalid()
    val r = BigInteger(1, p1363.copyOfRange(0, SCALAR_BYTES))
    val s = BigInteger(1, p1363.copyOfRange(SCALAR_BYTES, P1363_BYTES))
    requireInRange(r)
    requireInRange(s)
    // toByteArray() of a positive BigInteger is exactly the minimal DER INTEGER content: no
    // superfluous leading zero, and one 0x00 when the top bit would otherwise mark it negative.
    val rBytes = r.toByteArray()
    val sBytes = s.toByteArray()
    val bodyLength = 2 + rBytes.size + 2 + sBytes.size
    val out = ByteArray(2 + bodyLength)
    var pos = 0
    out[pos++] = TAG_SEQUENCE.toByte()
    out[pos++] = bodyLength.toByte() // at most 70, so short form
    out[pos++] = TAG_INTEGER.toByte()
    out[pos++] = rBytes.size.toByte()
    System.arraycopy(rBytes, 0, out, pos, rBytes.size)
    pos += rBytes.size
    out[pos++] = TAG_INTEGER.toByte()
    out[pos++] = sBytes.size.toByte()
    System.arraycopy(sBytes, 0, out, pos, sBytes.size)
    return out
  }

  private class ParsedInteger(val scalar: ByteArray, val next: Int)

  private fun readInteger(der: ByteArray, start: Int): ParsedInteger {
    if (start + 2 > der.size) invalid()
    if (unsigned(der[start]) != TAG_INTEGER) invalid()
    val length = unsigned(der[start + 1])
    if (length < 1 || length > MAX_INTEGER_CONTENT) invalid() // also excludes long-form lengths
    val contentStart = start + 2
    val end = contentStart + length
    if (end > der.size) invalid()

    val first = unsigned(der[contentStart])
    if (first and 0x80 != 0) invalid() // negative
    if (length > 1 && first == 0x00 && unsigned(der[contentStart + 1]) and 0x80 == 0) {
      invalid() // superfluous leading zero (not minimal)
    }
    // A 33-byte INTEGER must be 0x00 followed by a high-bit byte; anything else is > 32 bytes.
    if (length == MAX_INTEGER_CONTENT && first != 0x00) invalid()

    val magnitudeStart = if (length > 1 && first == 0x00) contentStart + 1 else contentStart
    val magnitude = der.copyOfRange(magnitudeStart, end)
    if (magnitude.size > SCALAR_BYTES) invalid()
    requireInRange(BigInteger(1, magnitude))

    val scalar = ByteArray(SCALAR_BYTES)
    System.arraycopy(magnitude, 0, scalar, SCALAR_BYTES - magnitude.size, magnitude.size)
    return ParsedInteger(scalar, end)
  }

  private fun requireInRange(value: BigInteger) {
    if (value.signum() <= 0 || value >= ORDER) invalid()
  }

  private fun unsigned(b: Byte): Int = b.toInt() and 0xff
}
