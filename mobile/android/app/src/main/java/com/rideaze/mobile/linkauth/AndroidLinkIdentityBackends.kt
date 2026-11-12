package com.rideaze.mobile.linkauth

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/**
 * Android Keystore backend: one EC P-256 signing key per alias.
 *
 * - PURPOSE_SIGN with SHA-256 only; no user authentication and no unlocked-device requirement
 *   (signing must work while the phone is locked in a pocket); StrongBox is not required.
 * - Android Keystore private keys are non-exportable by construction.
 * - Never logs and never throws anything containing key material.
 */
internal class AndroidKeystoreLinkKeyBackend : LinkKeyBackend {

  private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  override fun hasKey(alias: String): Boolean = keyStore().containsAlias(alias)

  override fun generateKey(alias: String) {
    val spec =
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(false)
        .build()
    val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
    generator.initialize(spec)
    generator.generateKeyPair()
  }

  override fun publicKey(alias: String): ECPublicKey? =
    keyStore().getCertificate(alias)?.publicKey as? ECPublicKey

  override fun securityLevel(alias: String): LinkKeySecurityLevel =
    try {
      val privateKey = keyStore().getKey(alias, null) as? PrivateKey ?: return LinkKeySecurityLevel.UNKNOWN
      val info =
        KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
          .getKeySpec(privateKey, KeyInfo::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        when (info.securityLevel) {
          KeyProperties.SECURITY_LEVEL_STRONGBOX -> LinkKeySecurityLevel.STRONGBOX
          KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> LinkKeySecurityLevel.TEE
          KeyProperties.SECURITY_LEVEL_SOFTWARE -> LinkKeySecurityLevel.SOFTWARE
          else -> LinkKeySecurityLevel.UNKNOWN
        }
      } else {
        @Suppress("DEPRECATION")
        if (info.isInsideSecureHardware) LinkKeySecurityLevel.TEE else LinkKeySecurityLevel.SOFTWARE
      }
    } catch (_: Exception) {
      LinkKeySecurityLevel.UNKNOWN
    }

  override fun deleteKey(alias: String) {
    keyStore().deleteEntry(alias)
  }

  override fun aliases(): List<String> = keyStore().aliases().toList()

  private companion object {
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
  }
}

/**
 * Non-secret identity metadata in private SharedPreferences. Writes use `commit()` so a successful
 * return means the data reached storage. The file is excluded from cloud backup and device
 * transfer (res/xml/data_extraction_rules.xml, backup_rules.xml).
 */
internal class SharedPreferencesLinkMetadataStore(context: Context) : LinkMetadataStore {
  private val preferences = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  override fun read(sessionId: String): String? = preferences.getString(PREFIX + sessionId, null)

  // commit() returns false if the disk write failed, but SharedPreferences may already have
  // updated its in-memory map. The store treats false as an error and never regenerates a key
  // because of it: an existing key is recovered later with the same cryptographic identity.
  override fun write(sessionId: String, value: String): Boolean =
    preferences.edit().putString(PREFIX + sessionId, value).commit()

  override fun remove(sessionId: String): Boolean = preferences.edit().remove(PREFIX + sessionId).commit()

  override fun sessionIds(): List<String> =
    preferences.all.keys.filter { it.startsWith(PREFIX) }.map { it.removePrefix(PREFIX) }

  companion object {
    const val FILE = "rideaze_link_identity_v1"
    private const val PREFIX = "identity."
  }
}

/** The process-wide identity store. Use from a background executor, never the main thread. */
object LinkIdentityStores {
  @Volatile private var instance: LinkIdentityStore? = null

  fun get(context: Context): LinkIdentityStore =
    instance
      ?: synchronized(this) {
        instance
          ?: LinkIdentityStore(
              AndroidKeystoreLinkKeyBackend(),
              SharedPreferencesLinkMetadataStore(context),
              System::currentTimeMillis,
            )
            .also { instance = it }
      }
}
