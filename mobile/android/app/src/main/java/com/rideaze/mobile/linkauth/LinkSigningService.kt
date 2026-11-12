package com.rideaze.mobile.linkauth

import java.security.KeyFactory
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPublicKeySpec

/** The private-key operations signing needs; the Android implementation is the Android Keystore. */
interface LinkSigningKeys {
  /** The public key of the key that [signDer] will use, or null if there is no such key. */
  fun publicKey(alias: String): ECPublicKey?

  /** SHA256withECDSA over [message] with the non-exportable key at [alias]: a DER signature. */
  fun signDer(alias: String, message: ByteArray): ByteArray
}

/** SHA256withECDSA verification with a plain JCA key rebuilt from the public point. */
internal object JcaEcdsaVerifier {
  fun verify(publicKey: ECPublicKey, message: ByteArray, der: ByteArray): Boolean =
    try {
      // Rebuild a provider-neutral key, so verification does not depend on the Keystore's key object.
      val plain = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(publicKey.w, publicKey.params))
      Signature.getInstance("SHA256withECDSA").run {
        initVerify(plain)
        update(message)
        verify(der)
      }
    } catch (_: Exception) {
      false
    }
}

/**
 * Signs authenticated link-auth PROOF / CONFIRM statements with the persistent per-session key.
 *
 * Everything happens while holding the identity store's lock ([LinkIdentityStore.withExistingIdentity]):
 *  1. the identity must already exist (nothing is ever generated or replaced here);
 *  2. the public key of the key that will actually sign is encoded and its node id derived; it must
 *     equal the stored identity's node id (otherwise IDENTITY_MISMATCH);
 *  3. the statement must be the canonical statement for [stage], and its signer must be THAT node id
 *     (never a signer supplied by JavaScript); anything else is STATEMENT_REJECTED;
 *  4. exactly the validated UTF-8 bytes are signed with SHA256withECDSA;
 *  5. the DER signature is strictly converted to 64-byte P1363 (S never normalised);
 *  6. the converted signature is verified natively against the signing key's public key.
 * Any failure aborts with a stable error and returns nothing. The result is the base64url signature.
 *
 * Nothing here logs, and no error message contains identifiers or signature bytes.
 */
class LinkSigningService(private val store: LinkIdentityStore, private val keys: LinkSigningKeys) {

  /** @return the 64-byte P1363 signature as canonical unpadded base64url (86 characters). */
  fun sign(sessionId: String, stage: String, statement: String): String =
    try {
      store.withExistingIdentity(sessionId) { identity -> signLocked(identity, stage, statement) }
    } catch (e: LinkSignerException) {
      throw e
    } catch (e: LinkIdentityException) {
      throw LinkSignerException(LinkSignerError.from(e.error), e)
    }

  private fun signLocked(identity: LinkIdentity, stage: String, statement: String): String {
    val alias = LinkIdentityStore.aliasFor(identity.sessionId)

    val publicKey = guard(LinkSignerError.KEYSTORE_UNAVAILABLE) { keys.publicKey(alias) }
      ?: throw LinkSignerException(LinkSignerError.IDENTITY_LOST)
    val point =
      try {
        EcPublicKeyEncoding.toUncompressedPoint(publicKey)
      } catch (e: IllegalArgumentException) {
        throw LinkSignerException(LinkSignerError.IDENTITY_MISMATCH, e)
      }
    val actualNodeId = LinkIdentityStore.nodeIdOf(point)
    if (actualNodeId != identity.nodeId) throw LinkSignerException(LinkSignerError.IDENTITY_MISMATCH)

    val validated =
      try {
        LinkAuthStatement.validate(stage, statement, actualNodeId) // signer = the real key's node id
      } catch (e: IllegalArgumentException) {
        throw LinkSignerException(LinkSignerError.STATEMENT_REJECTED, e)
      }
    val message = validated.signingBytes()

    val der =
      try {
        guard(LinkSignerError.SIGNING_FAILED) { keys.signDer(alias, message) }
      } catch (e: LinkSignerException) {
        // A key that can no longer be recovered or used is gone for good: say so, not "try again".
        if (e.cause is java.security.UnrecoverableKeyException) throw LinkSignerException(LinkSignerError.IDENTITY_LOST, e)
        throw e
      }
    val p1363 =
      try {
        EcdsaSignatureCodec.derToP1363(der)
      } catch (e: IllegalArgumentException) {
        throw LinkSignerException(LinkSignerError.INVALID_SIGNATURE_ENCODING, e)
      }
    if (!JcaEcdsaVerifier.verify(publicKey, message, EcdsaSignatureCodec.p1363ToDer(p1363))) {
      throw LinkSignerException(LinkSignerError.SIGNING_FAILED)
    }
    return LinkIdentityStore.base64Url(p1363)
  }

  private inline fun <T> guard(error: LinkSignerError, block: () -> T): T =
    try {
      block()
    } catch (e: LinkSignerException) {
      throw e
    } catch (e: Exception) {
      throw LinkSignerException(error, e)
    }
}
