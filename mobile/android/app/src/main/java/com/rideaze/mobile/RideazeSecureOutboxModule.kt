package com.rideaze.mobile

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypted, app-private persistence for the connectivity outbox only. */
class RideazeSecureOutboxModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val preferences = reactContext.getSharedPreferences(PREFERENCES, 0)

  override fun getName(): String = NAME

  private fun key(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  private fun encrypt(plainText: String): String {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.doFinal(plainText.toByteArray(StandardCharsets.UTF_8))
    val joined = ByteArray(cipher.iv.size + encrypted.size)
    System.arraycopy(cipher.iv, 0, joined, 0, cipher.iv.size)
    System.arraycopy(encrypted, 0, joined, cipher.iv.size, encrypted.size)
    return Base64.encodeToString(joined, Base64.NO_WRAP)
  }

  private fun decrypt(encoded: String): String {
    val joined = Base64.decode(encoded, Base64.NO_WRAP)
    require(joined.size > IV_BYTES) { "Encrypted outbox value is invalid" }
    val iv = joined.copyOfRange(0, IV_BYTES)
    val encrypted = joined.copyOfRange(IV_BYTES, joined.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
    return String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
  }

  @ReactMethod
  fun load(promise: Promise) {
    try {
      val encoded = preferences.getString(VALUE_KEY, null)
      promise.resolve(encoded?.let(::decrypt))
    } catch (_: Exception) {
      promise.reject("secure_outbox_load_failed", "Encrypted outbox could not be read")
    }
  }

  @ReactMethod
  fun save(serialized: String, promise: Promise) {
    try {
      preferences.edit().putString(VALUE_KEY, encrypt(serialized)).apply()
      promise.resolve(null)
    } catch (_: Exception) {
      promise.reject("secure_outbox_save_failed", "Encrypted outbox could not be written")
    }
  }

  @ReactMethod
  fun remove(promise: Promise) {
    preferences.edit().remove(VALUE_KEY).apply()
    promise.resolve(null)
  }

  companion object {
    const val NAME = "RideazeSecureOutbox"
    private const val PREFERENCES = "rideaze_secure_connectivity"
    private const val VALUE_KEY = "outbox_v1"
    private const val KEY_ALIAS = "rideaze_connectivity_outbox_v1"
    private const val IV_BYTES = 12
  }
}
