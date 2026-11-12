package com.rideaze.mobile.linkauth

/** Plain-data views handed to the React Native module (which turns them into bridge maps). */
class IdentityView(
  val sessionId: String,
  val nodeId: String,
  /** base64url of the 65-byte uncompressed P-256 point. */
  val publicKey: String,
  val createdAtMs: Long,
  val securityLevel: String,
  val created: Boolean,
)

class ListingView(
  val sessionId: String,
  val status: String,
  val nodeId: String?,
  val createdAtMs: Long?,
  val securityLevel: String?,
)

/**
 * The asynchronous surface of the native link signer, without any React Native types so it can be
 * tested on the JVM. Identity operations and signing share ONE queue (one thread, first in first
 * out) and the identity store's lock, so key creation, release, lookup and signing never interleave.
 * No identity-replacement operation exists, and no private key or alias ever leaves this layer.
 */
class LinkSignerApi(
  private val store: LinkIdentityStore,
  private val signing: LinkSigningService,
  private val queue: LinkSignerQueue = LinkSignerQueue(),
) {
  fun ensureIdentity(sessionId: String?, callback: LinkSignerCallback<IdentityView>) =
    runForSession(callback, sessionId) { s -> view(store.ensureIdentity(s)) }

  fun getIdentity(sessionId: String?, callback: LinkSignerCallback<IdentityView?>) =
    runForSession(callback, sessionId) { s -> store.getIdentity(s)?.let(::view) }

  fun listIdentities(callback: LinkSignerCallback<List<ListingView>>) =
    queue.submit(
      {
        store.listIdentities().map {
          ListingView(it.sessionId, it.status.name.lowercase(), it.nodeId, it.createdAtMs, it.securityLevel?.wireName)
        }
      },
      callback,
    )

  fun releaseIdentity(sessionId: String?, expectedNodeId: String?, callback: LinkSignerCallback<Unit>) {
    if (sessionId == null || expectedNodeId == null) return reject(callback, LinkSignerError.INVALID_ARGUMENT)
    queue.submit({ store.releaseIdentity(sessionId, expectedNodeId) }, callback)
  }

  /** The callback receives the base64url P1363 signature (86 characters). */
  fun signLinkAuthStatement(
    sessionId: String?,
    stage: String?,
    statement: String?,
    callback: LinkSignerCallback<String>,
  ) {
    if (sessionId == null || stage == null || statement == null) return reject(callback, LinkSignerError.INVALID_ARGUMENT)
    queue.submit({ signing.sign(sessionId, stage, statement) }, callback)
  }

  /** Stops accepting new work; accepted work still completes. Called when React Native is torn down. */
  fun shutdown() = queue.shutdown()

  private fun <T> runForSession(callback: LinkSignerCallback<T>, sessionId: String?, work: (String) -> T) {
    if (sessionId == null) return reject(callback, LinkSignerError.INVALID_ARGUMENT)
    queue.submit({ work(sessionId) }, callback)
  }

  private fun reject(callback: LinkSignerCallback<*>, error: LinkSignerError) {
    runCatching { callback.onError(error.code) }
  }

  private fun view(identity: LinkIdentity) =
    IdentityView(
      identity.sessionId,
      identity.nodeId,
      LinkIdentityStore.base64Url(identity.publicKey()),
      identity.createdAtMs,
      identity.securityLevel.wireName,
      identity.created,
    )
}
