package com.rideaze.mobile.linkauth

/** The two things a React Native Promise can do; lets the settlement rules be tested on the JVM. */
interface SettlementTarget {
  fun resolve(value: Any?)

  fun reject(code: String, message: String)
}

/**
 * Settles a Promise-like target from a queue callback. The queue marks a request settled before it
 * calls [onSuccess] and contains anything thrown, so THIS class is responsible for the Promise:
 *
 *  - [convert] runs inside its own boundary. If it throws (an Exception; fatal Errors propagate),
 *    the target is rejected once with a stable code and no detail from the exception;
 *  - [SettlementTarget.resolve] runs outside that boundary: if it throws, the target has already
 *    been settled or is unusable, so it is never rejected afterwards (the queue contains the error);
 *  - a failed conversion never resolves, and a resolved result is never followed by a rejection.
 */
class PromiseCallback<T>(
  private val target: SettlementTarget,
  private val convert: (T) -> Any?,
) : LinkSignerCallback<T> {
  override fun onSuccess(value: T) {
    val converted =
      try {
        convert(value)
      } catch (_: Exception) {
        target.reject(LinkSignerError.KEYSTORE_UNAVAILABLE.code, LinkSignerError.KEYSTORE_UNAVAILABLE.code)
        return
      }
    target.resolve(converted)
  }

  override fun onError(code: String) {
    target.reject(code, code)
  }
}
