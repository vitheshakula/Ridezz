package com.rideaze.mobile.linkauth

/** The two statements the link-auth key may ever sign. */
enum class LinkAuthStage(val wireName: String, val domain: String) {
  PROOF("proof", "rideaze.link-auth.v1.proof"),
  CONFIRM("confirm", "rideaze.link-auth.v1.confirm");

  companion object {
    fun fromWireName(name: String): LinkAuthStage? = values().firstOrNull { it.wireName == name }
  }
}

/** A statement that passed every check; the only thing a signer is allowed to sign. */
class ValidatedLinkAuthStatement internal constructor(
  val stage: LinkAuthStage,
  val signer: String,
  val peer: String,
  val transcript: String,
  private val signingBytes: ByteArray,
) {
  /** The exact UTF-8 bytes to sign (a fresh copy each time). */
  fun signingBytes(): ByteArray = signingBytes.copyOf()
}

/**
 * Validates the canonical link-auth signing statement, byte for byte as produced by
 * `linkAuthSigningInput` in mobile/src/connectivity/protocol/linkAuth.ts:
 *
 *   {"domain":"rideaze.link-auth.v1.<stage>","v":1,"signer":"<id>","peer":"<id>","transcript":"<hash>"}
 *
 * with no whitespace, this exact field order, and each of `<id>` / `<hash>` a canonical unpadded
 * base64url encoding of exactly 32 bytes: 43 characters from [A-Za-z0-9_-] whose last character
 * has zero trailing bits (one of A E I M Q U Y c g k o s w 0 4 8).
 *
 * Because the whole text is matched against one fixed template, a statement cannot carry extra,
 * missing, duplicated or reordered fields, whitespace, escapes, non-ASCII characters or trailing
 * content. The signing key may therefore never be used to sign anything else (credentials,
 * application messages, ...).
 *
 * Pure Kotlin, deterministic, fail closed. Every failure throws [IllegalArgumentException] with a
 * fixed generic message; the statement and the identifiers are never echoed.
 */
object LinkAuthStatement {
  private const val ID = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]"
  private const val MAX_STATEMENT_CHARS = 512 // the real statement is under 250; bounds regex work
  private const val ERROR = "Invalid link authentication statement"

  private val TEMPLATE =
    Regex(
      "\\{\"domain\":\"rideaze\\.link-auth\\.v1\\.(proof|confirm)\",\"v\":1," +
        "\"signer\":\"($ID)\",\"peer\":\"($ID)\",\"transcript\":\"($ID)\"\\}",
    )
  private val CANONICAL_ID = Regex(ID)

  private fun invalid(): Nothing = throw IllegalArgumentException(ERROR)

  /** True if [value] is a canonical 32-byte base64url identifier (node id or transcript hash). */
  fun isCanonicalIdentifier(value: String): Boolean =
    value.length == 43 && CANONICAL_ID.matches(value)

  /**
   * @param stage the stage the caller asked for: "proof" or "confirm" (must match the domain)
   * @param statement the full statement text
   * @param expectedSigner the local node id: the statement's signer must be exactly this
   */
  fun validate(stage: String, statement: String, expectedSigner: String): ValidatedLinkAuthStatement {
    val requested = LinkAuthStage.fromWireName(stage) ?: invalid()
    if (!isCanonicalIdentifier(expectedSigner)) invalid()
    if (statement.length > MAX_STATEMENT_CHARS) invalid()

    val match = TEMPLATE.matchEntire(statement) ?: invalid()
    val (wireStage, signer, peer, transcript) = match.destructured
    val found = LinkAuthStage.fromWireName(wireStage) ?: invalid()
    if (found != requested) invalid() // the domain must be the stage that was asked for
    if (signer != expectedSigner) invalid() // only this node's own statements
    if (peer == signer) invalid() // a node never vouches for itself

    return ValidatedLinkAuthStatement(
      stage = found,
      signer = signer,
      peer = peer,
      transcript = transcript,
      signingBytes = statement.toByteArray(Charsets.UTF_8),
    )
  }
}
