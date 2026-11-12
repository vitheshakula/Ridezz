package com.rideaze.mobile.linkauth

import android.security.keystore.KeyPermanentlyInvalidatedException
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.PrivateKey
import java.security.Signature
import java.security.UnrecoverableKeyException
import java.security.interfaces.ECPublicKey

/**
 * Signs with the non-exportable per-session key in the Android Keystore. The private key object
 * stays inside this class and is never returned, logged or passed anywhere.
 */
internal class AndroidKeystoreLinkSigningKeys : LinkSigningKeys {

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun publicKey(alias: String): ECPublicKey? =
    keyStore().getCertificate(alias)?.publicKey as? ECPublicKey

  override fun signDer(alias: String, message: ByteArray): ByteArray {
    val key = keyStore().getKey(alias, null) as? PrivateKey ?: throw KeyStoreException("no signing key")
    try {
      return Signature.getInstance("SHA256withECDSA").run {
        initSign(key)
        update(message)
        sign()
      }
    } catch (e: KeyPermanentlyInvalidatedException) {
      // Reported as an unrecoverable key so the signing service can tell permanent loss apart.
      throw UnrecoverableKeyException("key permanently invalidated").apply { initCause(e) }
    }
  }
}
