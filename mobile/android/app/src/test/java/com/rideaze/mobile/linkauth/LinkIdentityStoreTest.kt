package com.rideaze.mobile.linkauth

import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LinkIdentityStoreTest {

  private val sessionA = "AAECAwQFBgcICQoLDA0ODw"
  private val sessionB = "__79_Pv6-fj39vX08_Lx8A"

  // ---- fakes (JVM only) ----------------------------------------------------------------------

  private class FakeKeys : LinkKeyBackend {
    val keys = linkedMapOf<String, ECPublicKey>()
    var level = LinkKeySecurityLevel.TEE
    var generateCalls = AtomicInteger()
    var failGenerate = false
    var generateDelayMs = 0L
    var failHasKey = false
    var curve = "secp256r1"

    override fun hasKey(alias: String): Boolean {
      if (failHasKey) throw java.security.KeyStoreException("boom")
      return synchronized(keys) { keys.containsKey(alias) }
    }

    override fun generateKey(alias: String) {
      generateCalls.incrementAndGet()
      if (failGenerate) throw java.security.ProviderException("no keystore")
      if (generateDelayMs > 0) Thread.sleep(generateDelayMs) // widen the race window
      synchronized(keys) {
        check(!keys.containsKey(alias)) { "generate must never replace an existing key" }
        keys[alias] = newKey(curve)
      }
    }

    override fun publicKey(alias: String): ECPublicKey? = synchronized(keys) { keys[alias] }
    override fun securityLevel(alias: String) = level
    override fun deleteKey(alias: String) { synchronized(keys) { keys.remove(alias) } }
    override fun aliases(): List<String> = synchronized(keys) { keys.keys.toList() }

    companion object {
      fun newKey(curve: String = "secp256r1"): ECPublicKey =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec(curve)) }.generateKeyPair().public as ECPublicKey
    }
  }

  private class FakeMetadata : LinkMetadataStore {
    val values = linkedMapOf<String, String>()
    var failWrites = false
    var failRemoves = false
    var writes = AtomicInteger()

    override fun read(sessionId: String): String? = synchronized(values) { values[sessionId] }
    override fun write(sessionId: String, value: String): Boolean {
      writes.incrementAndGet()
      if (failWrites) return false
      synchronized(values) { values[sessionId] = value }
      return true
    }
    override fun remove(sessionId: String): Boolean {
      if (failRemoves) return false
      synchronized(values) { values.remove(sessionId) }
      return true
    }
    override fun sessionIds(): List<String> = synchronized(values) { values.keys.toList() }
  }

  private val keys = FakeKeys()
  private val meta = FakeMetadata()
  private var now = 1_700_000_000_000L
  private fun store() = LinkIdentityStore(keys, meta, { now })

  private fun expectError(expected: LinkIdentityError, block: () -> Unit) {
    try {
      block()
      fail("expected ${expected.code}")
    } catch (e: LinkIdentityException) {
      assertEquals(expected, e.error)
      assertEquals(expected.code, e.message) // the message is only the stable code
    }
  }

  private fun alias(session: String) = "rideaze.linkauth.v1.$session"

  private fun nodeIdOfPoint(point: ByteArray) =
    Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(point))

  // ---- session ids and aliases ---------------------------------------------------------------------

  @Test
  fun acceptsCanonicalSessionIdsAndBuildsAliasesOnlyFromThem() {
    assertTrue(LinkIdentityStore.isCanonicalSession(sessionA))
    assertTrue(LinkIdentityStore.isCanonicalSession(sessionB))
    assertEquals("rideaze.linkauth.v1.$sessionA", LinkIdentityStore.aliasFor(sessionA))
  }

  @Test
  fun rejectsEveryNonCanonicalSessionIdBeforeTouchingAnything() {
    val bad = listOf(
      "", "A", sessionA.dropLast(1), sessionA + "A", "54321", sessionA.dropLast(1) + "B",
      sessionA.dropLast(1) + "=", sessionA.replaceRange(3, 4, "+"), sessionA.replaceRange(3, 4, "/"),
      sessionA.replaceRange(3, 4, " "), sessionA + "\n", "\n" + sessionA, sessionA.replaceRange(0, 1, "а"),
      "rideaze.linkauth.v1.$sessionA", "../$sessionA", "$sessionA/..", sessionA.replaceRange(4, 5, "#"),
      "A".repeat(100_000),
    )
    val store = store()
    for (id in bad) {
      assertFalse("'$id'", LinkIdentityStore.isCanonicalSession(id))
      expectError(LinkIdentityError.INVALID_ARGUMENT) { store.ensureIdentity(id) }
      expectError(LinkIdentityError.INVALID_ARGUMENT) { store.getIdentity(id) }
      expectError(LinkIdentityError.INVALID_ARGUMENT) { store.releaseIdentity(id, "A".repeat(43)) }
      expectError(LinkIdentityError.INVALID_ARGUMENT) { LinkIdentityStore.aliasFor(id) }
    }
    assertEquals(0, keys.generateCalls.get())
    assertTrue(keys.keys.isEmpty())
    assertTrue(meta.values.isEmpty())
  }

  @Test
  fun onlyTheSixteenValidFinalCharactersAreAcceptedInASessionId() {
    for (c in "AQgw") assertTrue(LinkIdentityStore.isCanonicalSession("A".repeat(21) + c))
    for (c in ('A'..'Z') + ('a'..'z') + ('0'..'9') + listOf('-', '_')) {
      if (c !in "AQgw") assertFalse("last $c", LinkIdentityStore.isCanonicalSession("A".repeat(21) + c))
    }
  }

  // ---- creation and stable reuse ---------------------------------------------------------------------

  @Test
  fun createsAnIdentityOnFirstUseWithTheExactDerivedNodeId() {
    val id = store().ensureIdentity(sessionA)
    assertTrue(id.created)
    assertEquals(sessionA, id.sessionId)
    assertEquals(65, id.publicKey().size)
    assertEquals(0x04.toByte(), id.publicKey()[0])
    assertEquals(43, id.nodeId.length)
    assertEquals(nodeIdOfPoint(id.publicKey()), id.nodeId)
    assertEquals(LinkKeySecurityLevel.TEE, id.securityLevel)
    assertEquals(now, id.createdAtMs)
    assertEquals(setOf(alias(sessionA)), keys.keys.keys)
    assertEquals("1|$sessionA|${id.nodeId}|$now|tee", meta.values[sessionA])
    assertTrue(LinkAuthStatement.isCanonicalIdentifier(id.nodeId))
  }

  @Test
  fun returnsTheSameIdentityOnEveryLaterCallAndAfterARestart() {
    val first = store().ensureIdentity(sessionA)
    now += 5_000
    val again = store().ensureIdentity(sessionA)          // a brand-new store instance = process restart
    val viaGet = store().getIdentity(sessionA)
    for (other in listOf(again, viaGet!!)) {
      assertEquals(first.nodeId, other.nodeId)
      assertArrayEquals(first.publicKey(), other.publicKey())
      assertEquals(first.createdAtMs, other.createdAtMs) // creation time is preserved
      assertFalse(other.created)
    }
    assertEquals(1, keys.generateCalls.get())
  }

  @Test
  fun publicKeyAccessorReturnsFreshCopies() {
    val id = store().ensureIdentity(sessionA)
    val a = id.publicKey()
    a.fill(0)
    assertEquals(0x04.toByte(), id.publicKey()[0])
  }

  @Test
  fun differentRideSessionsGetDifferentIsolatedIdentities() {
    val a = store().ensureIdentity(sessionA)
    val b = store().ensureIdentity(sessionB)
    assertNotEquals(a.nodeId, b.nodeId)
    assertEquals(setOf(alias(sessionA), alias(sessionB)), keys.keys.keys)
    // releasing one never touches the other
    store().releaseIdentity(sessionA, a.nodeId)
    assertNull(store().getIdentity(sessionA))
    assertEquals(b.nodeId, store().getIdentity(sessionB)!!.nodeId)
    assertEquals(setOf(alias(sessionB)), keys.keys.keys)
  }

  @Test
  fun getIdentityNeverGenerates() {
    assertNull(store().getIdentity(sessionA))
    assertEquals(0, keys.generateCalls.get())
    assertTrue(meta.values.isEmpty())
  }

  @Test
  fun recordsTheSecurityLevelReportedByTheBackend() {
    for (level in LinkKeySecurityLevel.values()) {
      val k = FakeKeys().apply { this.level = level }
      val id = LinkIdentityStore(k, FakeMetadata(), { now }).ensureIdentity(sessionA)
      assertEquals(level, id.securityLevel)
    }
  }

  // ---- recovery ------------------------------------------------------------------------------------------

  @Test
  fun recoversTheSameIdentityWhenOnlyTheMetadataIsMissing() {
    val first = store().ensureIdentity(sessionA)
    meta.values.clear() // e.g. cleared app data of a different kind, or a crash before the write
    now += 9_000
    val recovered = store().ensureIdentity(sessionA)
    assertEquals(first.nodeId, recovered.nodeId)
    assertArrayEquals(first.publicKey(), recovered.publicKey())
    assertFalse(recovered.created)
    assertEquals(1, keys.generateCalls.get()) // the key was never regenerated
    assertEquals("1|$sessionA|${first.nodeId}|$now|tee", meta.values[sessionA])
    // getIdentity recovers too, and stays stable afterwards
    meta.values.clear()
    assertEquals(first.nodeId, store().getIdentity(sessionA)!!.nodeId)
  }

  @Test
  fun interruptedCreationIsRecoveredNotRegenerated() {
    meta.failWrites = true
    expectError(LinkIdentityError.KEYSTORE_UNAVAILABLE) { store().ensureIdentity(sessionA) }
    assertEquals(1, keys.keys.size) // the key survives the failed metadata write
    assertTrue(meta.values.isEmpty())
    val keyPoint = EcPublicKeyEncoding.toUncompressedPoint(keys.keys.values.first())
    meta.failWrites = false
    val recovered = store().ensureIdentity(sessionA)
    assertEquals(nodeIdOfPoint(keyPoint), recovered.nodeId)
    assertEquals(1, keys.generateCalls.get())
    assertEquals(1, keys.keys.size)
  }

  @Test
  fun metadataWithoutAKeyIsIdentityLostAndIsNeverReplaced() {
    val first = store().ensureIdentity(sessionA)
    keys.keys.clear() // key invalidated / deleted behind our back
    val metaBefore = meta.values.toMap()
    expectError(LinkIdentityError.IDENTITY_LOST) { store().ensureIdentity(sessionA) }
    expectError(LinkIdentityError.IDENTITY_LOST) { store().getIdentity(sessionA) }
    assertEquals(1, keys.generateCalls.get()) // no replacement was generated
    assertEquals(metaBefore, meta.values.toMap()) // the evidence is untouched
    assertTrue(keys.keys.isEmpty())
    assertEquals(first.nodeId, metaBefore[sessionA]!!.split("|")[2])
  }

  // ---- metadata corruption ------------------------------------------------------------------------------------

  private fun corruptCases(nodeId: String): List<Pair<String, String>> = listOf(
    "empty" to "",
    "garbage" to "not a record",
    "unsupported version" to "2|$sessionA|$nodeId|1|tee",
    "version zero" to "0|$sessionA|$nodeId|1|tee",
    "missing field" to "1|$sessionA|$nodeId|1",
    "extra field" to "1|$sessionA|$nodeId|1|tee|x",
    "other session" to "1|$sessionB|$nodeId|1|tee",
    "short node id" to "1|$sessionA|${nodeId.dropLast(1)}|1|tee",
    "non-canonical node id" to "1|$sessionA|${nodeId.dropLast(1)}p|1|tee",
    "negative time" to "1|$sessionA|$nodeId|-1|tee",
    "time with sign" to "1|$sessionA|$nodeId|+1|tee",
    "leading zero time" to "1|$sessionA|$nodeId|01|tee",
    "huge time" to "1|$sessionA|$nodeId|99999999999999999999|tee",
    "empty time" to "1|$sessionA|$nodeId||tee",
    "unknown level" to "1|$sessionA|$nodeId|1|hardware",
    "level case" to "1|$sessionA|$nodeId|1|TEE",
    "trailing newline" to "1|$sessionA|$nodeId|1|tee\n",
    "padded" to " 1|$sessionA|$nodeId|1|tee",
    "very long" to "1|$sessionA|$nodeId|1|tee" + "x".repeat(10_000),
  )

  @Test
  fun corruptedOrUnsupportedMetadataFailsClosedAndIsNeverOverwritten() {
    val first = store().ensureIdentity(sessionA)
    for ((label, raw) in corruptCases(first.nodeId)) {
      meta.values[sessionA] = raw
      val writesBefore = meta.writes.get()
      expectError(LinkIdentityError.INVALID_METADATA) { store().ensureIdentity(sessionA) }
      expectError(LinkIdentityError.INVALID_METADATA) { store().getIdentity(sessionA) }
      expectError(LinkIdentityError.INVALID_METADATA) { store().releaseIdentity(sessionA, first.nodeId) }
      assertEquals(label, raw, meta.values[sessionA]) // preserved as evidence
      assertEquals(label, writesBefore, meta.writes.get())
      assertEquals(label, 1, keys.keys.size) // the key is untouched
    }
    assertEquals(1, keys.generateCalls.get())
  }

  @Test
  fun corruptedMetadataWithAMissingKeyIsStillInvalidMetadata() {
    keys.keys.clear()
    meta.values[sessionA] = "garbage"
    expectError(LinkIdentityError.INVALID_METADATA) { store().ensureIdentity(sessionA) }
    assertEquals(0, keys.generateCalls.get())
    assertEquals("garbage", meta.values[sessionA])
  }

  // ---- node id mismatch and invalid keys ----------------------------------------------------------------------------

  @Test
  fun aKeyThatDisagreesWithTheMetadataIsAMismatchAndNothingChanges() {
    val first = store().ensureIdentity(sessionA)
    keys.keys[alias(sessionA)] = FakeKeys.newKey() // a different P-256 key under the same alias
    val metaBefore = meta.values.toMap()
    expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().ensureIdentity(sessionA) }
    expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().getIdentity(sessionA) }
    expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().releaseIdentity(sessionA, first.nodeId) }
    assertEquals(metaBefore, meta.values.toMap())
    assertEquals(1, keys.keys.size) // the evidence (the unexpected key) is still there
    assertEquals(1, keys.generateCalls.get())
  }

  @Test
  fun aNonP256KeyUnderOurAliasIsAMismatchNotAnIdentity() {
    keys.keys[alias(sessionA)] = FakeKeys.newKey("secp384r1")
    expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().ensureIdentity(sessionA) }
    assertTrue(meta.values.isEmpty()) // nothing was recorded for an unusable key
    assertEquals(0, keys.generateCalls.get())
  }

  @Test
  fun aBackendThatGeneratesANonP256KeyNeverProducesAnIdentity() {
    keys.curve = "secp384r1"
    expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().ensureIdentity(sessionA) }
    assertTrue(meta.values.isEmpty())
  }

  @Test
  fun aKeyPresentWithNoReadablePublicKeyIsUnavailable() {
    val k = object : LinkKeyBackend by keys {
      override fun hasKey(alias: String) = true
      override fun publicKey(alias: String): ECPublicKey? = null
    }
    expectError(LinkIdentityError.KEYSTORE_UNAVAILABLE) {
      LinkIdentityStore(k, meta, { now }).ensureIdentity(sessionA)
    }
    assertTrue(meta.values.isEmpty())
  }

  // ---- keystore / storage failures ----------------------------------------------------------------------------------

  @Test
  fun keystoreFailuresAreKeystoreUnavailableWithTheCauseKeptInternally() {
    keys.failGenerate = true
    try {
      store().ensureIdentity(sessionA)
      fail()
    } catch (e: LinkIdentityException) {
      assertEquals(LinkIdentityError.KEYSTORE_UNAVAILABLE, e.error)
      assertEquals("keystore_unavailable", e.message)
      assertTrue(e.cause is java.security.ProviderException)
    }
    assertTrue(meta.values.isEmpty())
    keys.failGenerate = false
    keys.failHasKey = true
    expectError(LinkIdentityError.KEYSTORE_UNAVAILABLE) { store().getIdentity(sessionA) }
    expectError(LinkIdentityError.KEYSTORE_UNAVAILABLE) { store().releaseIdentity(sessionA, "A".repeat(43)) }
  }

  @Test
  fun errorMessagesNeverContainIdentifiers() {
    val first = store().ensureIdentity(sessionA)
    keys.keys[alias(sessionA)] = FakeKeys.newKey()
    try {
      store().ensureIdentity(sessionA)
      fail()
    } catch (e: LinkIdentityException) {
      val text = (e.message ?: "") + e.toString()
      assertFalse(text.contains(sessionA))
      assertFalse(text.contains(first.nodeId))
      assertFalse(text.contains(alias(sessionA)))
    }
  }

  // ---- release ------------------------------------------------------------------------------------------------------

  @Test
  fun releaseWithTheCorrectNodeIdDeletesKeyAndMetadata() {
    val id = store().ensureIdentity(sessionA)
    store().releaseIdentity(sessionA, id.nodeId)
    assertTrue(keys.keys.isEmpty())
    assertTrue(meta.values.isEmpty())
    assertNull(store().getIdentity(sessionA))
    // a genuinely new ride session identity can be created afterwards (explicit, not automatic)
    assertNotEquals(id.nodeId, store().ensureIdentity(sessionA).nodeId)
  }

  @Test
  fun releaseWithAWrongNodeIdDeletesNothing() {
    val id = store().ensureIdentity(sessionA)
    val other = store().ensureIdentity(sessionB)
    for (wrong in listOf(other.nodeId, "A".repeat(43), id.nodeId.dropLast(1) + (if (id.nodeId.last() == 'A') 'E' else 'A'))) {
      expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().releaseIdentity(sessionA, wrong) }
    }
    assertEquals(setOf(alias(sessionA), alias(sessionB)), keys.keys.keys)
    assertEquals(2, meta.values.size)
  }

  @Test
  fun releaseRejectsMalformedExpectedNodeIds() {
    val id = store().ensureIdentity(sessionA)
    for (bad in listOf("", id.nodeId.dropLast(1), id.nodeId + "A", id.nodeId.dropLast(1) + "p", "x".repeat(43), id.nodeId + "\n")) {
      expectError(LinkIdentityError.INVALID_ARGUMENT) { store().releaseIdentity(sessionA, bad) }
    }
    assertEquals(1, keys.keys.size)
  }

  @Test
  fun releaseOfAnUnknownSessionIsNotFound() {
    expectError(LinkIdentityError.IDENTITY_NOT_FOUND) { store().releaseIdentity(sessionA, "A".repeat(43)) }
  }

  @Test
  fun anInterruptedReleaseCanBeCompleted() {
    val id = store().ensureIdentity(sessionA)
    keys.keys.clear() // the key was deleted, then the app died before the metadata was removed
    expectError(LinkIdentityError.IDENTITY_LOST) { store().getIdentity(sessionA) }
    expectError(LinkIdentityError.IDENTITY_MISMATCH) { store().releaseIdentity(sessionA, "A".repeat(43)) }
    assertEquals(1, meta.values.size)
    store().releaseIdentity(sessionA, id.nodeId) // explicit, with the right node id
    assertTrue(meta.values.isEmpty())
    expectError(LinkIdentityError.IDENTITY_NOT_FOUND) { store().releaseIdentity(sessionA, id.nodeId) }
  }

  @Test
  fun releaseWhoseMetadataRemovalFailsCanBeRetriedWithoutRegeneration() {
    val id = store().ensureIdentity(sessionA)
    val other = store().ensureIdentity(sessionB)
    val otherKey = keys.keys[alias(sessionB)]
    val otherMeta = meta.values[sessionB]
    assertEquals(2, keys.generateCalls.get())

    meta.failRemoves = true
    expectError(LinkIdentityError.KEYSTORE_UNAVAILABLE) { store().releaseIdentity(sessionA, id.nodeId) }
    // the key really was deleted (fail-closed state), the metadata is still there as evidence
    assertFalse(keys.keys.containsKey(alias(sessionA)))
    assertEquals("1|$sessionA|${id.nodeId}|$now|tee", meta.values[sessionA])
    expectError(LinkIdentityError.IDENTITY_LOST) { store().ensureIdentity(sessionA) }
    assertEquals(2, keys.generateCalls.get()) // nothing was regenerated

    meta.failRemoves = false
    store().releaseIdentity(sessionA, id.nodeId) // retry with the ORIGINAL expected node id
    assertNull(meta.values[sessionA])
    assertNull(store().getIdentity(sessionA))
    assertEquals(2, keys.generateCalls.get())
    // the other session was never touched
    assertEquals(setOf(alias(sessionB)), keys.keys.keys)
    assertTrue(keys.keys[alias(sessionB)] === otherKey)
    assertEquals(otherMeta, meta.values[sessionB])
    assertEquals(other.nodeId, store().getIdentity(sessionB)!!.nodeId)
  }

  @Test
  fun releaseOfAKeyWithoutMetadataWorksWhenTheNodeIdMatches() {
    val id = store().ensureIdentity(sessionA)
    meta.values.clear()
    store().releaseIdentity(sessionA, id.nodeId)
    assertTrue(keys.keys.isEmpty())
  }

  @Test
  fun nothingIsEverDeletedAutomatically() {
    val store = store()
    val sessions = listOf(sessionA, sessionB, "A".repeat(21) + "g", "A".repeat(21) + "Q")
    for (s in sessions) store.ensureIdentity(s)
    now += 10L * 365 * 24 * 3600 * 1000 // ten years later
    store.listIdentities()
    for (s in sessions) store.ensureIdentity(s)
    store.getIdentity(sessionA)
    assertEquals(4, keys.keys.size)
    assertEquals(4, meta.values.size)
    assertEquals(4, keys.generateCalls.get())
  }

  // ---- inventory -----------------------------------------------------------------------------------------------------

  @Test
  fun listIdentitiesReportsEverySessionAndItsStatusWithoutChangingAnything() {
    val a = store().ensureIdentity(sessionA)
    val b = store().ensureIdentity(sessionB)
    val orphan = "A".repeat(21) + "g"
    keys.keys[alias(orphan)] = FakeKeys.newKey() // a key with no metadata
    keys.keys.remove(alias(sessionB)) // lost identity
    meta.values["not-a-session"] = "x" // ignored: it can never be an alias
    val metaBefore = meta.values.toMap()
    val keysBefore = keys.keys.keys.toSet()
    val list = store().listIdentities().associateBy { it.sessionId }
    assertEquals(setOf(sessionA, sessionB, orphan), list.keys)
    assertEquals(LinkIdentityStatus.OK, list[sessionA]!!.status)
    assertEquals(a.nodeId, list[sessionA]!!.nodeId)
    assertEquals(LinkIdentityStatus.IDENTITY_LOST, list[sessionB]!!.status)
    assertEquals(b.nodeId, list[sessionB]!!.nodeId)
    assertEquals(LinkIdentityStatus.KEY_WITHOUT_METADATA, list[orphan]!!.status)
    assertNotNull(list[orphan]!!.nodeId)
    assertEquals(metaBefore, meta.values.toMap())
    assertEquals(keysBefore, keys.keys.keys.toSet())
    assertEquals(listOf(sessionA, orphan, sessionB).sorted(), store().listIdentities().map { it.sessionId })
  }

  @Test
  fun listIdentitiesFlagsCorruptionAndMismatchPerSession() {
    store().ensureIdentity(sessionA)
    store().ensureIdentity(sessionB)
    meta.values[sessionA] = "garbage"
    keys.keys[alias(sessionB)] = FakeKeys.newKey()
    val list = store().listIdentities().associateBy { it.sessionId }
    assertEquals(LinkIdentityStatus.INVALID_METADATA, list[sessionA]!!.status)
    assertEquals(LinkIdentityStatus.IDENTITY_MISMATCH, list[sessionB]!!.status)
  }

  // ---- concurrency ----------------------------------------------------------------------------------------------------

  @Test
  fun concurrentCallsForOneSessionCreateExactlyOneKeyAndOneIdentity() {
    keys.generateDelayMs = 25
    val threads = 24
    val pool = Executors.newFixedThreadPool(threads)
    val start = CountDownLatch(1)
    val results = (0 until threads).map {
      pool.submit<LinkIdentity> {
        start.await()
        store().ensureIdentity(sessionA) // every call uses its own store instance
      }
    }
    start.countDown()
    val ids = results.map { it.get(30, TimeUnit.SECONDS) }
    pool.shutdown()
    assertEquals(1, keys.generateCalls.get())
    assertEquals(1, ids.map { it.nodeId }.toSet().size)
    assertEquals(1, ids.count { it.created })
    assertEquals(1, keys.keys.size)
    assertEquals(1, meta.values.size)
  }

  @Test
  fun concurrentCallsForDifferentSessionsEachGetTheirOwnIdentity() {
    keys.generateDelayMs = 10
    val sessions = "AQgw".flatMap { last -> listOf("A", "B").map { first -> first.repeat(21) + last } }
    assertEquals(8, sessions.size)
    val pool = Executors.newFixedThreadPool(8)
    val futures = sessions.flatMap { s -> (0 until 3).map { pool.submit<LinkIdentity> { store().ensureIdentity(s) } } }
    val ids = futures.map { it.get(30, TimeUnit.SECONDS) }
    pool.shutdown()
    assertEquals(sessions.size, keys.generateCalls.get())
    assertEquals(sessions.size, ids.map { it.nodeId }.toSet().size)
    val bySession = ids.groupBy { it.sessionId }
    assertEquals(sessions.toSet(), bySession.keys)
    assertTrue(bySession.values.all { group -> group.map { it.nodeId }.toSet().size == 1 })
  }

  @Test
  fun concurrentReleaseAndEnsureNeverProducesAMixedState() {
    val id = store().ensureIdentity(sessionA)
    val pool = Executors.newFixedThreadPool(8)
    val outcomes = (0 until 16).map { i ->
      pool.submit<String> {
        try {
          if (i % 2 == 0) {
            store().releaseIdentity(sessionA, id.nodeId); "released"
          } else {
            store().ensureIdentity(sessionA); "ensured"
          }
        } catch (e: LinkIdentityException) {
          e.error.code
        }
      }
    }.map { it.get(30, TimeUnit.SECONDS) }
    pool.shutdown()
    // whatever the interleaving, key and metadata end up consistent (both present or both absent)
    assertEquals(keys.keys.isNotEmpty(), meta.values.isNotEmpty())
    assertTrue(outcomes.toString(), outcomes.all { it in setOf("released", "ensured", "identity_not_found", "identity_mismatch") })
  }
}
