package com.rideaze.mobile.linkauth

import java.security.MessageDigest
import java.security.interfaces.ECPublicKey

/** Stable error categories. The `code` is the only text that ever leaves this layer. */
enum class LinkIdentityError(val code: String) {
  INVALID_ARGUMENT("invalid_argument"),
  IDENTITY_NOT_FOUND("identity_not_found"),
  IDENTITY_LOST("identity_lost"),
  KEYSTORE_UNAVAILABLE("keystore_unavailable"),
  IDENTITY_MISMATCH("identity_mismatch"),
  INVALID_METADATA("invalid_metadata"),
}

/**
 * The failure of an identity operation. The message is just the stable code; the original
 * exception (if any) is kept as [cause] for internal diagnosis only and must not be logged with
 * identifiers.
 */
class LinkIdentityException(val error: LinkIdentityError, cause: Throwable? = null) :
  Exception(error.code, cause)

enum class LinkKeySecurityLevel(val wireName: String) {
  STRONGBOX("strongbox"),
  TEE("tee"),
  SOFTWARE("software"),
  UNKNOWN("unknown");

  companion object {
    fun fromWireName(name: String): LinkKeySecurityLevel? = values().firstOrNull { it.wireName == name }
  }
}

/** The key operations the store needs; the Android implementation is the Android Keystore. */
interface LinkKeyBackend {
  fun hasKey(alias: String): Boolean

  /** Creates a non-exportable P-256 signing key under [alias]. Must not replace an existing key. */
  fun generateKey(alias: String)

  /** The public key, or null if there is no such key. */
  fun publicKey(alias: String): ECPublicKey?

  fun securityLevel(alias: String): LinkKeySecurityLevel

  fun deleteKey(alias: String)

  /** Every alias currently in the store (the caller filters by prefix). */
  fun aliases(): List<String>
}

/** Non-secret identity metadata, one entry per ride session. */
interface LinkMetadataStore {
  fun read(sessionId: String): String?

  /** Durable write (commit, not apply). Returns false if it could not be made durable. */
  fun write(sessionId: String, value: String): Boolean

  fun remove(sessionId: String): Boolean

  fun sessionIds(): List<String>
}

/** The public view of one ride-session identity. */
class LinkIdentity internal constructor(
  val sessionId: String,
  val nodeId: String,
  private val publicKey: ByteArray,
  val createdAtMs: Long,
  val securityLevel: LinkKeySecurityLevel,
  /** True only for the call that generated the key. */
  val created: Boolean,
) {
  /** The 65-byte uncompressed P-256 point (a fresh copy). */
  fun publicKey(): ByteArray = publicKey.copyOf()
}

enum class LinkIdentityStatus { OK, IDENTITY_LOST, KEY_WITHOUT_METADATA, INVALID_METADATA, IDENTITY_MISMATCH, KEYSTORE_UNAVAILABLE }

class LinkIdentityListing(
  val sessionId: String,
  val status: LinkIdentityStatus,
  val nodeId: String?,
  val createdAtMs: Long?,
  val securityLevel: LinkKeySecurityLevel?,
)

/** The strictly validated, non-secret record persisted next to the Keystore key. */
internal class LinkIdentityMetadata(
  val sessionId: String,
  val nodeId: String,
  val createdAtMs: Long,
  val securityLevel: LinkKeySecurityLevel,
) {
  fun encode(): String = "$VERSION|$sessionId|$nodeId|$createdAtMs|${securityLevel.wireName}"

  companion object {
    const val VERSION = "1"
    private const val MAX_CHARS = 200
    private val DIGITS = Regex("0|[1-9][0-9]{0,15}")

    /** Null for anything that is not exactly a version-1 record for [expectedSessionId]. */
    fun parse(expectedSessionId: String, raw: String): LinkIdentityMetadata? {
      if (raw.length > MAX_CHARS) return null
      val parts = raw.split("|")
      if (parts.size != 5 || parts[0] != VERSION) return null
      if (parts[1] != expectedSessionId) return null
      if (!LinkAuthStatement.isCanonicalIdentifier(parts[2])) return null
      if (!DIGITS.matches(parts[3])) return null
      val level = LinkKeySecurityLevel.fromWireName(parts[4]) ?: return null
      return LinkIdentityMetadata(parts[1], parts[2], parts[3].toLong(), level)
    }
  }
}

/**
 * Per-ride-session link-auth identities: one non-exportable P-256 Keystore key per canonical
 * 16-byte session id, plus non-secret metadata. Pure Kotlin so the lifecycle rules are testable on
 * the JVM; the Android Keystore / SharedPreferences are injected.
 *
 * Rules (never generates a replacement for an identity that already existed):
 *   no key, no metadata      -> generate, then persist metadata        (created = true)
 *   key and metadata         -> verify they agree, return the identity
 *   key, no metadata         -> recover the same identity, persist metadata (crash after generate)
 *   metadata, no key         -> IDENTITY_LOST (never auto-regenerated)
 *   key disagrees with metadata, or the key is not P-256 -> IDENTITY_MISMATCH (nothing changed)
 *   unparsable metadata      -> INVALID_METADATA (nothing overwritten)
 *
 * Thread safety: every operation takes one process-wide lock, so concurrent callers see a single
 * identity per session. Keystore calls may block: call from a background executor, never from the
 * Android main thread. Nothing here logs.
 */
class LinkIdentityStore(
  private val keys: LinkKeyBackend,
  private val metadata: LinkMetadataStore,
  private val clock: () -> Long,
) {
  /** Creates the identity if neither a key nor metadata exist; otherwise returns the existing one. */
  fun ensureIdentity(sessionId: String): LinkIdentity = synchronized(LOCK) { resolve(validSession(sessionId), true)!! }

  /** The existing identity, or null if the session has neither key nor metadata. Never generates. */
  fun getIdentity(sessionId: String): LinkIdentity? = synchronized(LOCK) { resolve(validSession(sessionId), false) }

  /** Read-only inventory (no recovery, no writes), sorted by session id. */
  fun listIdentities(): List<LinkIdentityListing> =
    synchronized(LOCK) {
      val ids = sortedSetOf<String>()
      for (id in guard { metadata.sessionIds() }) if (isCanonicalSession(id)) ids.add(id)
      for (alias in guard { keys.aliases() }) {
        if (alias.startsWith(ALIAS_PREFIX)) alias.removePrefix(ALIAS_PREFIX).let { if (isCanonicalSession(it)) ids.add(it) }
      }
      ids.map { inspect(it) }
    }

  /**
   * Deletes the key and metadata of [sessionId], but only if the identity there is exactly
   * [expectedNodeId]. Never deletes anything automatically and never a different identity.
   * Safe to repeat after an interrupted release (key already gone, metadata still matching).
   */
  fun releaseIdentity(sessionId: String, expectedNodeId: String) {
    synchronized(LOCK) {
      validSession(sessionId)
      if (!LinkAuthStatement.isCanonicalIdentifier(expectedNodeId)) fail(LinkIdentityError.INVALID_ARGUMENT)
      val alias = aliasFor(sessionId)
      val keyPresent = guard { keys.hasKey(alias) }
      val stored = readMetadata(sessionId)
      if (!keyPresent) {
        if (stored == null) fail(LinkIdentityError.IDENTITY_NOT_FOUND)
        if (stored.nodeId != expectedNodeId) fail(LinkIdentityError.IDENTITY_MISMATCH)
        removeMetadata(sessionId)
        return
      }
      val actual = describeKey(alias)
      if (actual.nodeId != expectedNodeId) fail(LinkIdentityError.IDENTITY_MISMATCH)
      if (stored != null && stored.nodeId != actual.nodeId) fail(LinkIdentityError.IDENTITY_MISMATCH)
      guard { keys.deleteKey(alias) }
      if (stored != null) removeMetadata(sessionId)
    }
  }

  // ---- internals ----------------------------------------------------------------------------

  private class KeyDescription(val nodeId: String, val publicKey: ByteArray)

  private fun resolve(sessionId: String, create: Boolean): LinkIdentity? {
    val alias = aliasFor(sessionId)
    val keyPresent = guard { keys.hasKey(alias) }
    val stored = readMetadata(sessionId)
    if (!keyPresent) {
      if (stored != null) fail(LinkIdentityError.IDENTITY_LOST) // never replaced automatically
      return if (create) createIdentity(sessionId, alias) else null
    }
    val actual = describeKey(alias)
    if (stored == null) {
      // The key survived but its metadata did not (a crash between the two writes): same identity.
      val level = guard { keys.securityLevel(alias) }
      val now = clock()
      persist(LinkIdentityMetadata(sessionId, actual.nodeId, now, level))
      return LinkIdentity(sessionId, actual.nodeId, actual.publicKey, now, level, false)
    }
    if (stored.nodeId != actual.nodeId) fail(LinkIdentityError.IDENTITY_MISMATCH)
    return LinkIdentity(sessionId, actual.nodeId, actual.publicKey, stored.createdAtMs, stored.securityLevel, false)
  }

  private fun createIdentity(sessionId: String, alias: String): LinkIdentity {
    guard { keys.generateKey(alias) }
    // If anything below fails the key stays: the next call recovers it (key without metadata).
    val actual = describeKey(alias)
    val level = guard { keys.securityLevel(alias) }
    val now = clock()
    persist(LinkIdentityMetadata(sessionId, actual.nodeId, now, level))
    return LinkIdentity(sessionId, actual.nodeId, actual.publicKey, now, level, true)
  }

  /** Read-only status for the inventory. */
  private fun inspect(sessionId: String): LinkIdentityListing {
    fun listing(status: LinkIdentityStatus, m: LinkIdentityMetadata? = null, nodeId: String? = m?.nodeId) =
      LinkIdentityListing(sessionId, status, nodeId, m?.createdAtMs, m?.securityLevel)
    return try {
      val alias = aliasFor(sessionId)
      val keyPresent = guard { keys.hasKey(alias) }
      val stored = readMetadata(sessionId)
      when {
        !keyPresent -> if (stored == null) listing(LinkIdentityStatus.IDENTITY_LOST) else listing(LinkIdentityStatus.IDENTITY_LOST, stored)
        stored == null -> listing(LinkIdentityStatus.KEY_WITHOUT_METADATA, null, describeKey(alias).nodeId)
        describeKey(alias).nodeId != stored.nodeId -> listing(LinkIdentityStatus.IDENTITY_MISMATCH, stored)
        else -> listing(LinkIdentityStatus.OK, stored)
      }
    } catch (e: LinkIdentityException) {
      listing(
        when (e.error) {
          LinkIdentityError.INVALID_METADATA -> LinkIdentityStatus.INVALID_METADATA
          LinkIdentityError.IDENTITY_MISMATCH -> LinkIdentityStatus.IDENTITY_MISMATCH
          else -> LinkIdentityStatus.KEYSTORE_UNAVAILABLE
        },
      )
    }
  }

  private fun describeKey(alias: String): KeyDescription {
    val key = guard { keys.publicKey(alias) } ?: fail(LinkIdentityError.KEYSTORE_UNAVAILABLE)
    val point =
      try {
        EcPublicKeyEncoding.toUncompressedPoint(key)
      } catch (e: IllegalArgumentException) {
        throw LinkIdentityException(LinkIdentityError.IDENTITY_MISMATCH, e) // not a P-256 key
      }
    return KeyDescription(nodeIdOf(point), point)
  }

  private fun readMetadata(sessionId: String): LinkIdentityMetadata? {
    val raw = guard { metadata.read(sessionId) } ?: return null
    return LinkIdentityMetadata.parse(sessionId, raw) ?: fail(LinkIdentityError.INVALID_METADATA)
  }

  private fun persist(record: LinkIdentityMetadata) {
    if (!guard { metadata.write(record.sessionId, record.encode()) }) fail(LinkIdentityError.KEYSTORE_UNAVAILABLE)
  }

  private fun removeMetadata(sessionId: String) {
    if (!guard { metadata.remove(sessionId) }) fail(LinkIdentityError.KEYSTORE_UNAVAILABLE)
  }

  private fun fail(error: LinkIdentityError): Nothing = throw LinkIdentityException(error)

  /** Backend / storage failures become KEYSTORE_UNAVAILABLE, with the original kept as the cause. */
  private inline fun <T> guard(block: () -> T): T =
    try {
      block()
    } catch (e: LinkIdentityException) {
      throw e
    } catch (e: Exception) {
      throw LinkIdentityException(LinkIdentityError.KEYSTORE_UNAVAILABLE, e)
    }

  private fun validSession(sessionId: String): String {
    if (!isCanonicalSession(sessionId)) fail(LinkIdentityError.INVALID_ARGUMENT)
    return sessionId
  }

  companion object {
    const val ALIAS_PREFIX = "rideaze.linkauth.v1."
    private val SESSION = Regex("[A-Za-z0-9_-]{21}[AQgw]")

    /** One lock for the process, so even two store instances cannot race on the same session. */
    private val LOCK = Any()

    /** A canonical unpadded base64url encoding of exactly 16 bytes (22 characters). */
    fun isCanonicalSession(value: String): Boolean = value.length == 22 && SESSION.matches(value)

    /** The only way an alias is ever built: from a validated session id, never from caller text. */
    fun aliasFor(sessionId: String): String {
      if (!isCanonicalSession(sessionId)) throw LinkIdentityException(LinkIdentityError.INVALID_ARGUMENT)
      return ALIAS_PREFIX + sessionId
    }

    /** base64url (no padding) of SHA-256 of the 65-byte uncompressed point: 43 characters. */
    fun nodeIdOf(uncompressedPoint: ByteArray): String =
      base64Url(MessageDigest.getInstance("SHA-256").digest(uncompressedPoint))

    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

    private fun base64Url(bytes: ByteArray): String {
      val out = StringBuilder((bytes.size * 4 + 2) / 3)
      var i = 0
      while (i + 2 < bytes.size) {
        val n = ((bytes[i].toInt() and 0xff) shl 16) or ((bytes[i + 1].toInt() and 0xff) shl 8) or (bytes[i + 2].toInt() and 0xff)
        out.append(ALPHABET[n shr 18]).append(ALPHABET[(n shr 12) and 63]).append(ALPHABET[(n shr 6) and 63]).append(ALPHABET[n and 63])
        i += 3
      }
      when (bytes.size - i) {
        1 -> {
          val n = (bytes[i].toInt() and 0xff) shl 16
          out.append(ALPHABET[n shr 18]).append(ALPHABET[(n shr 12) and 63])
        }
        2 -> {
          val n = ((bytes[i].toInt() and 0xff) shl 16) or ((bytes[i + 1].toInt() and 0xff) shl 8)
          out.append(ALPHABET[n shr 18]).append(ALPHABET[(n shr 12) and 63]).append(ALPHABET[(n shr 6) and 63])
        }
      }
      return out.toString()
    }
  }
}
