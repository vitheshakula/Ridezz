package com.rideaze.bench.core.transport

enum class TransferStatus { SUCCESS, FAILURE, CANCELED }

/**
 * Per-submission callbacks. They may arrive on any thread, in any relative order. Accepted means only that
 * the platform took the payload; delivery is established only by the receiver's validated frames.
 */
interface SubmitCallback {
    fun onAccepted()
    fun onRejected(code: Int, message: String)
    fun onTransferResult(status: TransferStatus)
}

/** Outbound side of a link. Implemented by Nearby BYTES in :app and by a fake in tests. */
interface Transport {
    /** Asynchronous. Must not block. Exactly one of onAccepted/onRejected is eventually called, unless the link dies. */
    fun submit(bytes: ByteArray, cb: SubmitCallback)
    fun close()
}

/** Inbound events from the platform, delivered to the link node. */
interface LinkEvents {
    fun onBytes(bytes: ByteArray, rxMs: Long)
    fun onPeerConnected()
    fun onPeerDisconnected()
}
