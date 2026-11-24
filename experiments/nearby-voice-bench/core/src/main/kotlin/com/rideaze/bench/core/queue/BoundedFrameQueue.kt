package com.rideaze.bench.core.queue

enum class OverflowPolicy { DROP_NEWEST, DROP_OLDEST }

class QueuedFrame(val seq: Long, val genMs: Long, val bytes: ByteArray)

/** Bounded FIFO. Expiry is applied lazily at dequeue so stale frames are never handed to the transport. */
class BoundedFrameQueue(
    private val capacity: Int,
    private val policy: OverflowPolicy,
    private val expiryMs: Long?,
) {
    init { require(capacity >= 1) }
    private val items = ArrayDeque<QueuedFrame>()
    val size: Int get() = items.size
    fun isEmpty() = items.isEmpty()

    /** Returns the frame that was dropped to make room (possibly [f] itself), or null if nothing was dropped. */
    fun offer(f: QueuedFrame): QueuedFrame? {
        if (items.size < capacity) { items.addLast(f); return null }
        return when (policy) {
            OverflowPolicy.DROP_NEWEST -> f
            OverflowPolicy.DROP_OLDEST -> { val old = items.removeFirst(); items.addLast(f); old }
        }
    }

    /** Pops the oldest live frame. Frames older than expiry are passed to [onExpired] and discarded. */
    fun pollLive(nowMs: Long, onExpired: (QueuedFrame) -> Unit): QueuedFrame? {
        while (items.isNotEmpty()) {
            val f = items.removeFirst()
            if (expiryMs != null && nowMs - f.genMs > expiryMs) onExpired(f) else return f
        }
        return null
    }

    fun dropOldest(): QueuedFrame? = if (items.isEmpty()) null else items.removeFirst()
    fun drainAll(): List<QueuedFrame> = items.toList().also { items.clear() }
}
