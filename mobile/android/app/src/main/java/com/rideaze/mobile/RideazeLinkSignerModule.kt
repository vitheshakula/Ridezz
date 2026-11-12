package com.rideaze.mobile

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.rideaze.mobile.linkauth.AndroidKeystoreLinkSigningKeys
import com.rideaze.mobile.linkauth.IdentityView
import com.rideaze.mobile.linkauth.LinkIdentityStores
import com.rideaze.mobile.linkauth.LinkSignerApi
import com.rideaze.mobile.linkauth.LinkSignerCallback
import com.rideaze.mobile.linkauth.LinkSigningService

/**
 * React Native bridge for the per-ride-session link-auth signer.
 *
 * Only public keys, node ids and signatures cross the bridge (as canonical unpadded base64url);
 * private keys and Keystore aliases never do, and there is no operation that signs arbitrary
 * data or replaces an identity. Every method returns a Promise that settles exactly once, and all
 * Keystore work runs on one dedicated background thread (see LinkSignerQueue). Errors carry only a
 * stable code (invalid_argument, identity_not_found, identity_lost, identity_mismatch,
 * invalid_metadata, statement_rejected, keystore_unavailable, signing_failed,
 * invalid_signature_encoding, busy) as both code and message.
 */
class RideazeLinkSignerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val api: LinkSignerApi =
    LinkIdentityStores.get(reactContext).let { store ->
      LinkSignerApi(store, LinkSigningService(store, AndroidKeystoreLinkSigningKeys()))
    }

  override fun getName(): String = NAME

  @ReactMethod
  fun ensureIdentity(sessionId: String?, promise: Promise) {
    api.ensureIdentity(sessionId, callback(promise) { identityMap(it) })
  }

  @ReactMethod
  fun getIdentity(sessionId: String?, promise: Promise) {
    api.getIdentity(sessionId, callback(promise) { it?.let(::identityMap) })
  }

  @ReactMethod
  fun listIdentities(promise: Promise) {
    api.listIdentities(
      callback(promise) { list ->
        Arguments.createArray().also { array ->
          for (item in list) {
            array.pushMap(
              Arguments.createMap().also { map ->
                map.putString("sessionId", item.sessionId)
                map.putString("status", item.status)
                putStringOrNull(map, "nodeId", item.nodeId)
                if (item.createdAtMs == null) map.putNull("createdAt") else map.putDouble("createdAt", item.createdAtMs.toDouble())
                putStringOrNull(map, "securityLevel", item.securityLevel)
              },
            )
          }
        }
      },
    )
  }

  @ReactMethod
  fun signLinkAuthStatement(sessionId: String?, stage: String?, statement: String?, promise: Promise) {
    api.signLinkAuthStatement(sessionId, stage, statement, callback(promise) { it })
  }

  @ReactMethod
  fun releaseIdentity(sessionId: String?, expectedNodeId: String?, promise: Promise) {
    api.releaseIdentity(sessionId, expectedNodeId, callback(promise) { null })
  }

  /** Stops accepting new work; requests already accepted still finish (a Keystore call is never interrupted). */
  override fun invalidate() {
    api.shutdown()
    super.invalidate()
  }

  private fun <T> callback(promise: Promise, convert: (T) -> Any?) =
    object : LinkSignerCallback<T> {
      override fun onSuccess(value: T) {
        promise.resolve(convert(value))
      }

      override fun onError(code: String) {
        promise.reject(code, code)
      }
    }

  private fun identityMap(identity: IdentityView): WritableMap =
    Arguments.createMap().also { map ->
      map.putString("sessionId", identity.sessionId)
      map.putString("nodeId", identity.nodeId)
      map.putString("publicKey", identity.publicKey)
      map.putDouble("createdAt", identity.createdAtMs.toDouble())
      map.putString("securityLevel", identity.securityLevel)
      map.putBoolean("created", identity.created)
    }

  private fun putStringOrNull(map: WritableMap, key: String, value: String?) {
    if (value == null) map.putNull(key) else map.putString(key, value)
  }

  companion object {
    const val NAME = "RideazeLinkSigner"
  }
}
