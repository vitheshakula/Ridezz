package com.rideaze.mobile.linkauth

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Receives exactly one outcome per submitted operation. */
interface LinkSignerCallback<in T> {
  fun onSuccess(value: T)

  /** [code] is a [LinkSignerError.code]. */
  fun onError(code: String)
}

/**
 * One dedicated background thread running Keystore work first-in first-out, with at most
 * [maxWaiting] requests waiting behind the one that is running. A request beyond that is rejected
 * at once with `busy`; after [shutdown] new requests are rejected with `keystore_unavailable`.
 *
 * Every submitted operation settles EXACTLY once. A running Keystore operation is never cancelled
 * or interrupted: [shutdown] only stops accepting new work and lets accepted work finish.
 */
class LinkSignerQueue(private val maxWaiting: Int = DEFAULT_MAX_WAITING) {
  private val executor =
    ThreadPoolExecutor(
      1,
      1,
      0L,
      TimeUnit.MILLISECONDS,
      ArrayBlockingQueue<Runnable>(maxWaiting),
      { task -> Thread(task, THREAD_NAME).apply { isDaemon = true } },
      ThreadPoolExecutor.AbortPolicy(),
    )

  fun <T> submit(work: () -> T, callback: LinkSignerCallback<T>) {
    val settled = AtomicBoolean(false)
    fun settleError(error: LinkSignerError) {
      if (settled.compareAndSet(false, true)) runCatching { callback.onError(error.code) }
    }
    try {
      executor.execute {
        try {
          val value = work()
          if (settled.compareAndSet(false, true)) runCatching { callback.onSuccess(value) }
        } catch (e: LinkSignerException) {
          settleError(e.error)
        } catch (e: LinkIdentityException) {
          settleError(LinkSignerError.from(e.error))
        } catch (e: Exception) {
          settleError(LinkSignerError.KEYSTORE_UNAVAILABLE)
        } finally {
          settleError(LinkSignerError.KEYSTORE_UNAVAILABLE) // an Error escaped: still settle once
        }
      }
    } catch (e: RejectedExecutionException) {
      settleError(if (executor.isShutdown) LinkSignerError.KEYSTORE_UNAVAILABLE else LinkSignerError.BUSY)
    }
  }

  /** Stops accepting work; accepted work (running and waiting) still completes. */
  fun shutdown() {
    executor.shutdown()
  }

  val isShutdown: Boolean get() = executor.isShutdown

  companion object {
    const val DEFAULT_MAX_WAITING = 8
    const val THREAD_NAME = "rideaze-link-signer"
  }
}
