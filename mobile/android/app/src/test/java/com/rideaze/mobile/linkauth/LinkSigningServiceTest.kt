package com.rideaze.mobile.linkauth

import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Signing core, bounded queue and API, on the JVM with a fake Keystore that holds real EC keys. */
class LinkSigningServiceTest {

  private val sessionA = "AAECAwQFBgcICQoLDA0ODw"
  private val sessionB = "__79_Pv6-fj39vX08_Lx8A"

  // fixed values from the Task 2.2 interoperability vector (peer node id and transcript hash)
  private val peer = "aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o"
  private val transcript = "gF9Ve4NIJ2YOrBmoykxLB-2MlTD0kCp9R9WjCqm0NJU"

  private val order = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

  // ---- fakes ---------------------------------------------------------------------------------

  private class FakeKeystore : LinkKeyBackend, LinkSigningKeys {
    val pairs = linkedMapOf<String, KeyPair>()
    val generateCalls = AtomicInteger()
    val signCalls = AtomicInteger()
    val messages = java.util.Collections.synchronizedList(mutableListOf<ByteArray>())
    @Volatile var enterSign: CountDownLatch? = null // signal: a signature is in progress
    @Volatile var holdSign: CountDownLatch? = null // block until released
    @Volatile var tamper: ((alias: String, der: ByteArray) -> ByteArray)? = null
    @Volatile var failSign = false

    private fun newPair(): KeyPair =
      KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    override fun hasKey(alias: String) = synchronized(pairs) { pairs.containsKey(alias) }
    override fun generateKey(alias: String) {
      generateCalls.incrementAndGet()
      synchronized(pairs) { check(!pairs.containsKey(alias)); pairs[alias] = newPair() }
    }
    override fun publicKey(alias: String): ECPublicKey? = synchronized(pairs) { pairs[alias]?.public as ECPublicKey? }
    override fun securityLevel(alias: String) = LinkKeySecurityLevel.TEE
    override fun deleteKey(alias: String) { synchronized(pairs) { pairs.remove(alias) } }
    override fun aliases(): List<String> = synchronized(pairs) { pairs.keys.toList() }

    override fun signDer(alias: String, message: ByteArray): ByteArray {
      signCalls.incrementAndGet()
      messages.add(message.copyOf())
      enterSign?.countDown()
      holdSign?.await(10, TimeUnit.SECONDS)
      if (failSign) throw java.security.SignatureException("hardware busy")
      val pair = synchronized(pairs) { pairs[alias] } ?: throw java.security.KeyStoreException("no key")
      val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(message); sign() }
      return tamper?.invoke(alias, der) ?: der
    }
  }

  private class FakeMetadata : LinkMetadataStore {
    val values = linkedMapOf<String, String>()
    override fun read(sessionId: String) = synchronized(values) { values[sessionId] }
    override fun write(sessionId: String, value: String): Boolean { synchronized(values) { values[sessionId] = value }; return true }
    override fun remove(sessionId: String): Boolean { synchronized(values) { values.remove(sessionId) }; return true }
    override fun sessionIds() = synchronized(values) { values.keys.toList() }
  }

  private val keystore = FakeKeystore()
  private val meta = FakeMetadata()
  private val store = LinkIdentityStore(keystore, meta, { 1_700_000_000_000L })
  private val service = LinkSigningService(store, keystore)

  private fun statement(stage: String, signer: String, peerId: String = peer, hash: String = transcript) =
    "{\"domain\":\"rideaze.link-auth.v1.$stage\",\"v\":1,\"signer\":\"$signer\",\"peer\":\"$peerId\",\"transcript\":\"$hash\"}"

  private fun alias(session: String) = "rideaze.linkauth.v1.$session"
  private fun decode(s: String) = Base64.getUrlDecoder().decode(s)

  private fun expectError(error: LinkSignerError, block: () -> Unit) {
    try {
      block()
      fail("expected ${error.code}")
    } catch (e: LinkSignerException) {
      assertEquals(error, e.error)
      assertEquals(error.code, e.message)
    }
  }

  /** Independent verification: rebuild the DER with the tested codec and verify with plain JCA. */
  private fun verifies(publicKey: ECPublicKey, message: String, signature: String): Boolean {
    val p1363 = decode(signature)
    if (p1363.size != 64) return false
    return Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey)
      update(message.toByteArray(Charsets.UTF_8))
      verify(EcdsaSignatureCodec.p1363ToDer(p1363))
    }
  }

  private fun identity(session: String = sessionA) = store.ensureIdentity(session)

  // ---- correct signatures -----------------------------------------------------------------------

  @Test
  fun signsValidProofAndConfirmStatementsWithTheSessionKey() {
    val id = identity()
    for (stage in listOf("proof", "confirm")) {
      val text = statement(stage, id.nodeId)
      val signature = service.sign(sessionA, stage, text)
      assertEquals(86, signature.length)
      assertTrue(signature.matches(Regex("[A-Za-z0-9_-]{86}")))
      assertEquals(64, decode(signature).size)
      assertTrue(verifies(keystore.publicKey(alias(sessionA))!!, text, signature))
    }
    // exactly the validated UTF-8 statement bytes were signed, once per request
    assertEquals(2, keystore.signCalls.get())
    assertArrayEquals(statement("proof", id.nodeId).toByteArray(Charsets.UTF_8), keystore.messages[0])
    assertArrayEquals(statement("confirm", id.nodeId).toByteArray(Charsets.UTF_8), keystore.messages[1])
  }

  @Test
  fun proofAndConfirmSignaturesAreNotInterchangeable() {
    val id = identity()
    val proof = service.sign(sessionA, "proof", statement("proof", id.nodeId))
    assertFalse(verifies(keystore.publicKey(alias(sessionA))!!, statement("confirm", id.nodeId), proof))
  }

  @Test
  fun signaturesVerifyUnderTheRightKeyOnly() {
    val a = identity(sessionA)
    identity(sessionB)
    val text = statement("proof", a.nodeId)
    val signature = service.sign(sessionA, "proof", text)
    assertTrue(verifies(keystore.publicKey(alias(sessionA))!!, text, signature))
    assertFalse(verifies(keystore.publicKey(alias(sessionB))!!, text, signature))
  }

  @Test
  fun highSAndLowSSignaturesAreBothReturnedUnchanged() {
    val id = identity()
    var low = 0
    var high = 0
    for (i in 0 until 40) {
      val hash = transcript.dropLast(1) + "AEIMQUYcgkosw048"[i % 16]
      val text = statement("proof", id.nodeId, hash = hash)
      val signature = service.sign(sessionA, "proof", text)
      val s = BigInteger(1, decode(signature).copyOfRange(32, 64))
      if (s > order.shiftRight(1)) high++ else low++
      assertTrue(verifies(keystore.publicKey(alias(sessionA))!!, text, signature))
    }
    assertTrue("low-S: $low, high-S: $high", low > 0 && high > 0) // the Keystore does not normalise
  }

  @Test
  fun aForcedHighSSignatureIsAcceptedAndNotNormalised() {
    val id = identity()
    val text = statement("proof", id.nodeId)
    keystore.tamper = { _, der ->
      val p = EcdsaSignatureCodec.derToP1363(der)
      val s = BigInteger(1, p.copyOfRange(32, 64))
      val high = if (s > order.shiftRight(1)) s else order.subtract(s) // always the high form
      val out = p.copyOf()
      val sb = high.toByteArray().let { if (it.size == 33) it.copyOfRange(1, 33) else it }
      java.util.Arrays.fill(out, 32, 64, 0)
      System.arraycopy(sb, 0, out, 64 - sb.size, sb.size)
      EcdsaSignatureCodec.p1363ToDer(out)
    }
    val signature = service.sign(sessionA, "proof", text)
    val s = BigInteger(1, decode(signature).copyOfRange(32, 64))
    assertTrue(s > order.shiftRight(1))
    assertTrue(verifies(keystore.publicKey(alias(sessionA))!!, text, signature))
  }

  // ---- what is refused ----------------------------------------------------------------------------

  @Test
  fun rejectsArbitraryMessagesWithoutEverCallingTheKey() {
    val id = identity()
    val good = statement("proof", id.nodeId)
    val bad = listOf(
      "", "hello", "SOS! help me", good + "\n", " $good", good.replace("\"v\":1", "\"v\": 1"),
      good.replace("link-auth.v1.proof", "link-auth.v1.hello"), good.replace("\"v\":1", "\"v\":2"),
      good.dropLast(1), "{}", "{\"v\":1,\"kid\":\"srv\",\"nodeId\":\"${id.nodeId}\"}",
      good.replace("\"peer\"", "\"extra\":1,\"peer\""), statement("proof", id.nodeId, peerId = id.nodeId),
      good.replace(peer, peer.dropLast(1)), "A".repeat(100_000),
    )
    for (text in bad) expectError(LinkSignerError.STATEMENT_REJECTED) { service.sign(sessionA, "proof", text) }
    assertEquals(0, keystore.signCalls.get())
  }

  @Test
  fun rejectsAStatementForAnotherSigner() {
    identity(sessionA)
    val other = identity(sessionB)
    // session B's statement offered to session A's key, and vice versa
    expectError(LinkSignerError.STATEMENT_REJECTED) { service.sign(sessionA, "proof", statement("proof", other.nodeId)) }
    expectError(LinkSignerError.STATEMENT_REJECTED) { service.sign(sessionA, "proof", statement("proof", peer)) }
    assertEquals(0, keystore.signCalls.get())
  }

  @Test
  fun rejectsStageMismatchAndUnknownStages() {
    val id = identity()
    expectError(LinkSignerError.STATEMENT_REJECTED) { service.sign(sessionA, "confirm", statement("proof", id.nodeId)) }
    expectError(LinkSignerError.STATEMENT_REJECTED) { service.sign(sessionA, "proof", statement("confirm", id.nodeId)) }
    for (stage in listOf("", "hello", "PROOF", "proof ", "sign")) {
      expectError(LinkSignerError.STATEMENT_REJECTED) { service.sign(sessionA, stage, statement("proof", id.nodeId)) }
    }
    assertEquals(0, keystore.signCalls.get())
  }

  @Test
  fun neverGeneratesAnIdentityWhileSigning() {
    expectError(LinkSignerError.IDENTITY_NOT_FOUND) { service.sign(sessionA, "proof", statement("proof", peer + "x")) }
    expectError(LinkSignerError.IDENTITY_NOT_FOUND) { service.sign(sessionB, "proof", statement("proof", peer)) }
    assertEquals(0, keystore.generateCalls.get())
    assertTrue(keystore.pairs.isEmpty())
    assertTrue(meta.values.isEmpty())
  }

  @Test
  fun aMissingOrInvalidatedKeyIsIdentityLostAndNeverReplaced() {
    val id = identity()
    keystore.pairs.clear() // invalidated or deleted behind our back
    expectError(LinkSignerError.IDENTITY_LOST) { service.sign(sessionA, "proof", statement("proof", id.nodeId)) }
    assertEquals(1, keystore.generateCalls.get())
    assertEquals(0, keystore.signCalls.get())
    assertTrue(keystore.pairs.isEmpty())
  }

  @Test
  fun aKeyThatDisagreesWithTheStoredIdentityIsAMismatch() {
    val id = identity()
    keystore.pairs[alias(sessionA)] = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    expectError(LinkSignerError.IDENTITY_MISMATCH) { service.sign(sessionA, "proof", statement("proof", id.nodeId)) }
    assertEquals(0, keystore.signCalls.get())
  }

  @Test
  fun aSigningKeyDifferentFromTheStoredIdentityIsAMismatch() {
    val id = identity()
    val foreign = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    val swapped = object : LinkSigningKeys {
      override fun publicKey(alias: String) = foreign.public as ECPublicKey
      override fun signDer(alias: String, message: ByteArray): ByteArray = throw AssertionError("must not sign")
    }
    expectError(LinkSignerError.IDENTITY_MISMATCH) {
      LinkSigningService(store, swapped).sign(sessionA, "proof", statement("proof", id.nodeId))
    }
  }

  @Test
  fun invalidSessionIdsAreInvalidArguments() {
    for (bad in listOf("", "x", sessionA + "A", sessionA.dropLast(1) + "B", "rideaze.linkauth.v1.$sessionA")) {
      expectError(LinkSignerError.INVALID_ARGUMENT) { service.sign(bad, "proof", statement("proof", peer)) }
    }
  }

  // ---- bad signer output ----------------------------------------------------------------------------

  @Test
  fun badKeystoreOutputFailsClosedWithAStableError() {
    val id = identity()
    val text = statement("proof", id.nodeId)
    val foreign = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    keystore.tamper = { _, _ -> // a perfectly formed signature, by another key
      Signature.getInstance("SHA256withECDSA").run { initSign(foreign.private); update(text.toByteArray()); sign() }
    }
    expectError(LinkSignerError.SIGNING_FAILED) { service.sign(sessionA, "proof", text) }

    keystore.tamper = { _, der -> der.copyOf().also { it[5] = (it[5] + 1).toByte() } } // a flipped bit in r
    expectError(LinkSignerError.SIGNING_FAILED) { service.sign(sessionA, "proof", text) }

    keystore.tamper = { _, der -> byteArrayOf(0x00) + der } // not DER
    expectError(LinkSignerError.INVALID_SIGNATURE_ENCODING) { service.sign(sessionA, "proof", text) }
    keystore.tamper = { _, _ -> ByteArray(0) }
    expectError(LinkSignerError.INVALID_SIGNATURE_ENCODING) { service.sign(sessionA, "proof", text) }
    keystore.tamper = { _, der -> der + byteArrayOf(0) } // trailing data
    expectError(LinkSignerError.INVALID_SIGNATURE_ENCODING) { service.sign(sessionA, "proof", text) }
    keystore.tamper = { _, _ -> ByteArray(64) } // P1363 passed as DER
    expectError(LinkSignerError.INVALID_SIGNATURE_ENCODING) { service.sign(sessionA, "proof", text) }

    keystore.tamper = null
    keystore.failSign = true
    expectError(LinkSignerError.SIGNING_FAILED) { service.sign(sessionA, "proof", text) }
    keystore.failSign = false
    assertEquals(86, service.sign(sessionA, "proof", text).length) // and it recovers
  }

  @Test
  fun errorMessagesNeverContainIdentifiersStatementsOrSignatures() {
    val id = identity()
    val text = statement("proof", id.nodeId)
    val failures = listOf<() -> Unit>(
      { service.sign(sessionA, "proof", text.replace("\"v\":1", "\"v\":2")) },
      { service.sign(sessionB, "proof", text) },
      { keystore.tamper = { _, d -> d + byteArrayOf(1) }; service.sign(sessionA, "proof", text) },
    )
    for (run in failures) {
      try {
        run()
        fail()
      } catch (e: LinkSignerException) {
        val all = (e.message ?: "") + e.toString()
        for (secret in listOf(sessionA, sessionB, id.nodeId, text, peer, transcript, alias(sessionA))) assertFalse(all.contains(secret))
        assertEquals(e.error.code, e.message)
      }
    }
  }

  @Test
  fun noPublicApiReturnsKeyMaterial() {
    for (type in listOf(LinkSigningService::class.java, LinkSignerApi::class.java, IdentityView::class.java, ListingView::class.java)) {
      for (m in type.methods) {
        assertFalse("${type.simpleName}.${m.name}", java.security.Key::class.java.isAssignableFrom(m.returnType))
        assertFalse("${type.simpleName}.${m.name}", m.returnType == java.security.KeyStore::class.java)
      }
    }
    assertEquals(setOf("sign"), LinkSigningService::class.java.declaredMethods.filter { java.lang.reflect.Modifier.isPublic(it.modifiers) }.map { it.name }.toSet())
    // the public API has no replacement operation and no way to sign arbitrary data
    val apiNames = LinkSignerApi::class.java.methods.map { it.name }.toSet()
    assertTrue(apiNames.containsAll(setOf("ensureIdentity", "getIdentity", "listIdentities", "releaseIdentity", "signLinkAuthStatement", "shutdown")))
    assertTrue(apiNames.none { it.contains("replace", true) || it.contains("regenerate", true) || it == "sign" })
  }

  // ---- lifecycle and concurrency ----------------------------------------------------------------------

  @Test
  fun aReleaseDuringSigningWaitsAndTheSignatureStaysWithItsOwnIdentity() {
    val id = identity()
    val text = statement("proof", id.nodeId)
    keystore.enterSign = CountDownLatch(1)
    keystore.holdSign = CountDownLatch(1)
    val pool = Executors.newFixedThreadPool(2)
    val signing = pool.submit<String> { service.sign(sessionA, "proof", text) }
    assertTrue(keystore.enterSign!!.await(5, TimeUnit.SECONDS)) // signing is now in progress
    val releasing = pool.submit { store.releaseIdentity(sessionA, id.nodeId) }
    try {
      releasing.get(300, TimeUnit.MILLISECONDS)
      fail("the release must wait for the signature")
    } catch (_: java.util.concurrent.TimeoutException) {
    }
    assertTrue(keystore.hasKey(alias(sessionA))) // key still there while signing
    val publicKey = keystore.publicKey(alias(sessionA))!!
    keystore.holdSign!!.countDown()
    val signature = signing.get(10, TimeUnit.SECONDS)
    releasing.get(10, TimeUnit.SECONDS)
    pool.shutdown()
    assertTrue(verifies(publicKey, text, signature)) // signed under the original identity
    assertFalse(keystore.hasKey(alias(sessionA)))
    expectError(LinkSignerError.IDENTITY_NOT_FOUND) { service.sign(sessionA, "proof", text) }
  }

  @Test
  fun concurrentRequestsForDifferentSessionsEachUseTheirOwnKey() {
    val a = identity(sessionA)
    val b = identity(sessionB)
    val pool = Executors.newFixedThreadPool(8)
    val jobs = (0 until 16).map { i ->
      val (session, id) = if (i % 2 == 0) sessionA to a else sessionB to b
      val text = statement(if (i % 4 < 2) "proof" else "confirm", id.nodeId)
      Triple(session, text, pool.submit<String> { service.sign(session, if (text.contains(".proof")) "proof" else "confirm", text) })
    }
    for ((session, text, future) in jobs) {
      val signature = future.get(20, TimeUnit.SECONDS)
      assertTrue(verifies(keystore.publicKey(alias(session))!!, text, signature))
      val other = if (session == sessionA) sessionB else sessionA
      assertFalse(verifies(keystore.publicKey(alias(other))!!, text, signature))
    }
    pool.shutdown()
    assertEquals(2, keystore.generateCalls.get())
  }

  // ---- the bounded queue --------------------------------------------------------------------------------

  private class Capture<T> : LinkSignerCallback<T> {
    val latch = CountDownLatch(1)
    val settles = AtomicInteger()
    val value = AtomicReference<T?>()
    val error = AtomicReference<String?>()
    val thread = AtomicReference<String?>()
    override fun onSuccess(value: T) { thread.set(Thread.currentThread().name); this.value.set(value); settles.incrementAndGet(); latch.countDown() }
    override fun onError(code: String) { thread.set(Thread.currentThread().name); error.set(code); settles.incrementAndGet(); latch.countDown() }
    fun await() = assertTrue(latch.await(10, TimeUnit.SECONDS))
  }

  @Test
  fun theQueueRunsWorkInOrderOnItsOwnThread() {
    val queue = LinkSignerQueue()
    val order = java.util.Collections.synchronizedList(mutableListOf<Int>())
    val captures = (0 until 8).map { i -> Capture<Int>().also { queue.submit({ order.add(i); i }, it) } }
    captures.forEach { it.await() }
    assertEquals((0 until 8).toList(), order.toList())
    assertTrue(captures.all { it.thread.get() == LinkSignerQueue.THREAD_NAME })
    assertNotEquals(Thread.currentThread().name, captures[0].thread.get())
    assertTrue(captures.all { it.settles.get() == 1 })
    queue.shutdown()
  }

  @Test
  fun theQueueAllowsAtMostEightWaitingRequestsAndRejectsTheRestAsBusy() {
    val queue = LinkSignerQueue()
    val gate = CountDownLatch(1)
    val running = CountDownLatch(1)
    val first = Capture<Int>()
    queue.submit({ running.countDown(); gate.await(10, TimeUnit.SECONDS); 0 }, first)
    assertTrue(running.await(5, TimeUnit.SECONDS)) // one running; now fill the waiting line
    val waiting = (1..8).map { i -> Capture<Int>().also { queue.submit({ i }, it) } }
    val overflow = (1..3).map { Capture<Int>().also { c -> queue.submit({ 99 }, c) } }
    for (c in overflow) { // rejected at once, on the caller's thread, exactly once
      assertEquals("busy", c.error.get())
      assertEquals(1, c.settles.get())
    }
    assertTrue(waiting.all { it.settles.get() == 0 })
    gate.countDown()
    first.await()
    waiting.forEach { it.await() }
    assertEquals((1..8).toList(), waiting.map { it.value.get() })
    assertTrue(overflow.all { it.value.get() == null })
    // after draining, there is room again
    val again = Capture<Int>().also { queue.submit({ 7 }, it) }
    again.await()
    assertEquals(7, again.value.get())
    queue.shutdown()
  }

  @Test
  fun shutdownRejectsNewWorkButLetsAcceptedWorkFinish() {
    val queue = LinkSignerQueue()
    val gate = CountDownLatch(1)
    val running = CountDownLatch(1)
    val accepted = Capture<String>().also { queue.submit({ running.countDown(); gate.await(10, TimeUnit.SECONDS); "done" }, it) }
    val waiting = Capture<String>().also { queue.submit({ "also done" }, it) }
    assertTrue(running.await(5, TimeUnit.SECONDS))
    queue.shutdown()
    assertTrue(queue.isShutdown)
    val late = Capture<String>().also { queue.submit({ "never" }, it) }
    assertEquals("keystore_unavailable", late.error.get())
    assertEquals(1, late.settles.get())
    queue.shutdown() // idempotent
    gate.countDown()
    accepted.await()
    waiting.await()
    assertEquals("done", accepted.value.get()) // the running Keystore call was never interrupted
    assertEquals("also done", waiting.value.get())
  }

  @Test
  fun everyRequestSettlesExactlyOnceAndErrorsAreSanitised() {
    val queue = LinkSignerQueue()
    val cases: List<Pair<() -> Any?, String?>> = listOf(
      ({ LinkIdentityStore.aliasFor("bad") }) to "invalid_argument",
      ({ throw LinkSignerException(LinkSignerError.STATEMENT_REJECTED) }) to "statement_rejected",
      ({ throw IllegalStateException("secret $sessionA") }) to "keystore_unavailable",
      ({ throw java.security.KeyStoreException("alias $sessionA") }) to "keystore_unavailable",
      ({ "ok" }) to null,
    )
    for ((work, expected) in cases) {
      val c = Capture<Any?>()
      queue.submit(work, c)
      c.await()
      Thread.sleep(20)
      assertEquals(1, c.settles.get())
      assertEquals(expected, c.error.get())
      if (expected != null) assertFalse(c.error.get()!!.contains(sessionA))
    }
    // a callback that throws neither breaks the queue nor causes a second settle
    val thrower = AtomicInteger()
    queue.submit({ 1 }, object : LinkSignerCallback<Int> {
      override fun onSuccess(value: Int) { thrower.incrementAndGet(); throw RuntimeException("boom") }
      override fun onError(code: String) { thrower.incrementAndGet() }
    })
    val after = Capture<Int>().also { queue.submit({ 2 }, it) }
    after.await()
    assertEquals(1, thrower.get())
    assertEquals(2, after.value.get())
    queue.shutdown()
  }

  // ---- the API (what the React Native module calls) -----------------------------------------------------------

  private fun api() = LinkSignerApi(store, service, LinkSignerQueue())

  @Test
  fun apiIdentityOperationsUseTheStoreAndReturnCanonicalBase64Url() {
    val api = api()
    val c = Capture<IdentityView>().also { api.ensureIdentity(sessionA, it) }
    c.await()
    val view = c.value.get()!!
    assertEquals(sessionA, view.sessionId)
    assertTrue(view.created)
    assertEquals(87, view.publicKey.length) // 65 bytes
    assertTrue(view.publicKey.matches(Regex("[A-Za-z0-9_-]{87}")))
    val point = decode(view.publicKey)
    assertEquals(65, point.size)
    assertEquals(0x04.toByte(), point[0])
    assertEquals(view.nodeId, LinkIdentityStore.nodeIdOf(point))
    assertEquals("tee", view.securityLevel)

    val again = Capture<IdentityView?>().also { api.getIdentity(sessionA, it) }
    again.await()
    assertEquals(view.nodeId, again.value.get()!!.nodeId)
    assertFalse(again.value.get()!!.created)
    val unknown = Capture<IdentityView?>().also { api.getIdentity(sessionB, it) }
    unknown.await()
    assertNull(unknown.value.get())
    assertEquals(0, unknown.settles.get() - 1)

    val listing = Capture<List<ListingView>>().also { api.listIdentities(it) }
    listing.await()
    assertEquals(listOf(sessionA), listing.value.get()!!.map { it.sessionId })
    assertEquals("ok", listing.value.get()!![0].status)

    val wrong = Capture<Unit>().also { api.releaseIdentity(sessionA, "A".repeat(43), it) }
    wrong.await()
    assertEquals("identity_mismatch", wrong.error.get())
    assertTrue(keystore.hasKey(alias(sessionA)))
    val released = Capture<Unit>().also { api.releaseIdentity(sessionA, view.nodeId, it) }
    released.await()
    assertNull(released.error.get())
    assertFalse(keystore.hasKey(alias(sessionA)))
    api.shutdown()
  }

  @Test
  fun apiSigningReturnsAnEightySixCharacterSignatureAndMapsErrors() {
    val api = api()
    val id = identity()
    val ok = Capture<String>().also { api.signLinkAuthStatement(sessionA, "proof", statement("proof", id.nodeId), it) }
    ok.await()
    assertEquals(86, ok.value.get()!!.length)
    assertTrue(verifies(keystore.publicKey(alias(sessionA))!!, statement("proof", id.nodeId), ok.value.get()!!))
    val bad = Capture<String>().also { api.signLinkAuthStatement(sessionA, "proof", "anything at all", it) }
    bad.await()
    assertEquals("statement_rejected", bad.error.get())
    val missing = Capture<String>().also { api.signLinkAuthStatement(sessionB, "proof", statement("proof", peer), it) }
    missing.await()
    assertEquals("identity_not_found", missing.error.get())
    assertEquals(1, keystore.generateCalls.get())
    api.shutdown()
  }

  @Test
  fun apiRejectsMissingArgumentsWithoutQueueingAnything() {
    val api = api()
    val results = listOf(
      Capture<IdentityView>().also { api.ensureIdentity(null, it) },
      Capture<IdentityView?>().also { api.getIdentity(null, it) },
      Capture<Unit>().also { api.releaseIdentity(null, "x", it) },
      Capture<Unit>().also { api.releaseIdentity(sessionA, null, it) },
      Capture<String>().also { api.signLinkAuthStatement(null, "proof", "s", it) },
      Capture<String>().also { api.signLinkAuthStatement(sessionA, null, "s", it) },
      Capture<String>().also { api.signLinkAuthStatement(sessionA, "proof", null, it) },
    )
    for (c in results) {
      assertEquals("invalid_argument", c.error.get())
      assertEquals(1, c.settles.get())
    }
    assertEquals(0, keystore.generateCalls.get())
    api.shutdown()
  }

  @Test
  fun apiSharesOneQueueBetweenIdentityAndSigningWork() {
    // a blocked signature keeps later identity operations waiting in order, never interleaved
    val api = api()
    val id = identity()
    keystore.enterSign = CountDownLatch(1)
    keystore.holdSign = CountDownLatch(1)
    val signed = Capture<String>().also { api.signLinkAuthStatement(sessionA, "proof", statement("proof", id.nodeId), it) }
    assertTrue(keystore.enterSign!!.await(5, TimeUnit.SECONDS))
    val release = Capture<Unit>().also { api.releaseIdentity(sessionA, id.nodeId, it) }
    Thread.sleep(150)
    assertEquals(0, release.settles.get()) // queued behind the signature
    keystore.holdSign!!.countDown()
    signed.await()
    release.await()
    assertEquals(86, signed.value.get()!!.length)
    assertNull(release.error.get())
    api.shutdown()
  }

  @Test
  fun apiBusyIsReportedWhenTheQueueIsFull() {
    val api = api()
    val id = identity()
    keystore.enterSign = CountDownLatch(1)
    keystore.holdSign = CountDownLatch(1)
    val text = statement("proof", id.nodeId)
    val first = Capture<String>().also { api.signLinkAuthStatement(sessionA, "proof", text, it) }
    assertTrue(keystore.enterSign!!.await(5, TimeUnit.SECONDS))
    val queued = (1..8).map { Capture<String>().also { c -> api.signLinkAuthStatement(sessionA, "proof", text, c) } }
    val busy = Capture<String>().also { api.signLinkAuthStatement(sessionA, "proof", text, it) }
    assertEquals("busy", busy.error.get())
    keystore.holdSign!!.countDown()
    first.await()
    queued.forEach { it.await() }
    assertTrue(queued.all { it.value.get()!!.length == 86 })
    api.shutdown()
  }
}
