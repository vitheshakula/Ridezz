package com.rideaze.mobile.linkauth

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Promise settlement boundary used by RideazeLinkSignerModule. */
class PromiseCallbackTest {

  private class Target : SettlementTarget {
    val events = mutableListOf<String>()
    var resolved: Any? = null
    var throwOnResolve = false
    var throwOnReject = false

    override fun resolve(value: Any?) {
      events.add("resolve")
      resolved = value
      if (throwOnResolve) throw IllegalStateException("bridge gone")
    }

    override fun reject(code: String, message: String) {
      events.add("reject:$code:$message")
      if (throwOnReject) throw IllegalStateException("bridge gone")
    }
  }

  @Test
  fun aSuccessfulConversionIsResolvedOnceAndNeverRejected() {
    val target = Target()
    val converted = Any()
    PromiseCallback<String>(target) { converted }.onSuccess("x")
    assertEquals(listOf("resolve"), target.events)
    assertSame(converted, target.resolved)
  }

  @Test
  fun nullAndPlainResultsPassThroughUnchanged() {
    val target = Target()
    PromiseCallback<String?>(target) { null }.onSuccess(null)
    PromiseCallback<String>(target) { it }.onSuccess("signature")
    assertEquals(listOf("resolve", "resolve"), target.events)
    assertEquals("signature", target.resolved)
  }

  @Test
  fun aConversionFailureRejectsExactlyOnceWithAStableCodeAndNeverResolves() {
    for (failure in listOf<Exception>(
      IllegalStateException("WritableNativeMap failed for session AAECAwQFBgcICQoLDA0ODw"),
      NullPointerException(),
      RuntimeException("secret node id aof18xvgf5GVamtY5h3tRYCQ85AyiXjm6K9pAiyNJ4o"),
      UnsatisfiedLinkError("native").let { RuntimeException(it) },
    )) {
      val target = Target()
      PromiseCallback<String>(target) { throw failure }.onSuccess("value that must not leak")
      assertEquals(listOf("reject:keystore_unavailable:keystore_unavailable"), target.events)
      assertFalse(target.events.any { it.startsWith("resolve") })
      assertFalse(target.events.joinToString().contains("AAECAw")) // no detail from the exception
      assertFalse(target.events.joinToString().contains("value that must not leak"))
    }
  }

  @Test
  fun aFailureThrownByResolveIsNeverFollowedByARejection() {
    val target = Target().apply { throwOnResolve = true }
    try {
      PromiseCallback<String>(target) { "ok" }.onSuccess("x")
      throw AssertionError("the resolve failure must propagate to the queue's containment")
    } catch (_: IllegalStateException) {
    }
    assertEquals(listOf("resolve"), target.events) // not settled a second time
  }

  @Test
  fun errorsAreRejectedOnceWithTheCodeAsMessage() {
    val target = Target()
    val callback = PromiseCallback<String>(target) { it }
    callback.onError("busy")
    assertEquals(listOf("reject:busy:busy"), target.events)
  }

  @Test
  fun fatalErrorsAreNotCaughtByTheConversionBoundary() {
    val target = Target()
    try {
      PromiseCallback<String>(target) { throw OutOfMemoryError("test") }.onSuccess("x")
      throw AssertionError("an Error must propagate")
    } catch (_: OutOfMemoryError) {
    }
    assertTrue(target.events.isEmpty())
  }

  @Test
  fun throughTheQueueAConversionFailureSettlesThePromiseExactlyOnce() {
    val queue = LinkSignerQueue()
    val target = Target()
    val done = CountDownLatch(1)
    val target2 = object : SettlementTarget {
      override fun resolve(value: Any?) { target.resolve(value); done.countDown() }
      override fun reject(code: String, message: String) { target.reject(code, message); done.countDown() }
    }
    queue.submit({ "result" }, PromiseCallback<String>(target2) { throw IllegalStateException("convert") })
    assertTrue(done.await(5, TimeUnit.SECONDS))
    Thread.sleep(50)
    assertEquals(listOf("reject:keystore_unavailable:keystore_unavailable"), target.events)
    // a normal request on the same queue still resolves, in order
    val ok = Target()
    val done2 = CountDownLatch(1)
    queue.submit({ 41 + 1 }, PromiseCallback<Int>(object : SettlementTarget {
      override fun resolve(value: Any?) { ok.resolve(value); done2.countDown() }
      override fun reject(code: String, message: String) { ok.reject(code, message); done2.countDown() }
    }) { it })
    assertTrue(done2.await(5, TimeUnit.SECONDS))
    assertEquals(42, ok.resolved)
    assertEquals(listOf("resolve"), ok.events)
    queue.shutdown()
  }

  @Test
  fun throughTheQueueAnErrorOrBusyOrShutdownRejectsOnceWithTheQueuesCode() {
    val queue = LinkSignerQueue()
    val codes = mutableListOf<String>()
    fun target() = object : SettlementTarget {
      override fun resolve(value: Any?) { synchronized(codes) { codes.add("resolve") } }
      override fun reject(code: String, message: String) { synchronized(codes) { codes.add("$code/$message") } }
    }
    val latch = CountDownLatch(1)
    queue.submit({ throw LinkSignerException(LinkSignerError.STATEMENT_REJECTED) }, PromiseCallback<String>(object : SettlementTarget {
      override fun resolve(value: Any?) { latch.countDown() }
      override fun reject(code: String, message: String) { synchronized(codes) { codes.add("$code/$message") }; latch.countDown() }
    }) { it })
    assertTrue(latch.await(5, TimeUnit.SECONDS))
    queue.shutdown()
    queue.submit({ "late" }, PromiseCallback<String>(target()) { it })
    assertEquals(listOf("statement_rejected/statement_rejected", "keystore_unavailable/keystore_unavailable"), codes)
  }
}
