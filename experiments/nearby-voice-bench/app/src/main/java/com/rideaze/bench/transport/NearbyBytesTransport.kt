package com.rideaze.bench.transport

import android.content.Context
import android.os.SystemClock
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import com.rideaze.bench.core.platform.NearbyStatus
import com.rideaze.bench.core.pairing.Decision
import com.rideaze.bench.core.pairing.Initiated
import com.rideaze.bench.core.pairing.PairRole
import com.rideaze.bench.core.pairing.PairingGate
import com.rideaze.bench.core.transport.LinkEvents
import com.rideaze.bench.core.transport.SubmitCallback
import com.rideaze.bench.core.transport.TransferStatus
import com.rideaze.bench.core.transport.Transport
import java.util.concurrent.ConcurrentHashMap

/**
 * Nearby Connections BYTES transport for the benchmark ONLY.
 *
 *  - own service id (never the production "com.ridezz.mobile.mesh");
 *  - Strategy.P2P_CLUSTER, the strategy production uses, so E1 measures the same topology class;
 *  - connections are accepted only through [PairingGate] after the operator compares authentication digits;
 *  - Payload.fromBytes only. sendPayload() success means "accepted by the platform", never "delivered".
 *
 * NOT COMPILED in the authoring environment (no Android SDK / Google Maven). API names and signatures are
 * from the author's knowledge of play-services-nearby and MUST be checked on first build, in particular
 * ConnectionInfo.getAuthenticationDigits() (Kotlin: authenticationDigits).
 */
class NearbyBytesTransport(
    context: Context,
    private val gate: PairingGate,
    private val role: PairRole,
    private val nonce: String,
    private val listener: Listener,
) : Transport {

    interface Listener {
        fun onDigits(endpointId: String, digits: String)
        fun onStatus(msg: String)
        /** [radio] = the status code says a radio (Bluetooth/Wi-Fi) problem: an environment precondition, not an API defect. */
        fun onApiFailure(msg: String, radio: Boolean)
        fun onPeerChanged(connected: Boolean)
    }

    /** Set by the controller once the link node exists. */
    @Volatile var events: LinkEvents? = null

    private val client: ConnectionsClient = Nearby.getConnectionsClient(context.applicationContext)
    private val transfers = ConcurrentHashMap<Long, SubmitCallback>()
    @Volatile private var peer: String? = null
    @Volatile private var closed = false
    private val strayPayloads = java.util.concurrent.atomic.AtomicLong()

    val connectedPeer: String? get() = peer

    private fun now() = SystemClock.elapsedRealtime()

    fun start() {
        if (role == PairRole.RECEIVER) {
            client.startAdvertising(
                gate.advertisedName(nonce), SERVICE_ID, lifecycle,
                AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
            ).addOnSuccessListener { listener.onStatus("advertising") }
                .addOnFailureListener { fail("startAdvertising", it) }
        } else {
            client.startDiscovery(
                SERVICE_ID, discovery,
                DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
            ).addOnSuccessListener { listener.onStatus("discovering") }
                .addOnFailureListener { fail("startDiscovery", it) }
        }
    }

    /** Operator pressed "digits match" or "digits differ". */
    fun confirm(endpointId: String, match: Boolean) {
        when (val d = gate.operatorDecision(endpointId, match, now())) {
            is Decision.Accept -> client.acceptConnection(endpointId, payloads)
                .addOnFailureListener { fail("acceptConnection", it) }
            is Decision.Reject -> {
                listener.onStatus("rejected: ${d.reason}")
                client.rejectConnection(endpointId)
            }
        }
    }

    override fun submit(bytes: ByteArray, cb: SubmitCallback) {
        val ep = peer
        if (closed || ep == null) { cb.onRejected(NO_PEER, "no connected peer"); return }
        val payload = Payload.fromBytes(bytes)
        transfers[payload.id] = cb
        client.sendPayload(ep, payload)
            .addOnSuccessListener { cb.onAccepted() }
            .addOnFailureListener { e ->
                transfers.remove(payload.id)
                cb.onRejected((e as? ApiException)?.statusCode ?: UNKNOWN_FAILURE, e.message ?: e.javaClass.simpleName)
            }
    }

    override fun close() {
        if (closed) return
        closed = true
        runCatching { client.stopAdvertising() }
        runCatching { client.stopDiscovery() }
        runCatching { client.stopAllEndpoints() }
        transfers.clear() // outstanding submissions stay UNRESOLVED in the ledger; we do not invent results
        peer = null
    }

    private fun fail(what: String, e: Exception) {
        val code = (e as? ApiException)?.statusCode
        val info = NearbyStatus.describe(code)
        listener.onApiFailure("$what failed ${info.name} ${e.message}", info.radio)
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
            if (closed) return
            if (!gate.shouldRequest(endpointId, info.endpointName, now())) return
            client.requestConnection(gate.advertisedName(nonce), endpointId, lifecycle)
                .addOnFailureListener { fail("requestConnection", it) }
        }
        override fun onEndpointLost(endpointId: String) {}
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
            if (closed) { client.rejectConnection(endpointId); return }
            val digits: String? = info.authenticationDigits // UNVERIFIED API name for 19.3.0; null/blank => rejected
            when (val r = gate.onConnectionInitiated(endpointId, info.endpointName, digits, now())) {
                is Initiated.Reject -> { listener.onStatus("refused ${gate.hash(endpointId)}: ${r.reason}"); client.rejectConnection(endpointId) }
                is Initiated.AwaitOperator -> listener.onDigits(endpointId, r.digits)
            }
        }

        override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
            val ok = result.status.isSuccess
            gate.onConnectionResult(endpointId, ok, now())
            if (!ok) { listener.onStatus("connection failed code=${result.status.statusCode}"); return }
            if (gate.connectedPeer != endpointId) { // stray: never part of the run
                client.disconnectFromEndpoint(endpointId); return
            }
            peer = endpointId
            runCatching { client.stopAdvertising() }
            runCatching { client.stopDiscovery() }
            listener.onPeerChanged(true)
            events?.onPeerConnected()
        }

        override fun onDisconnected(endpointId: String) {
            gate.onDisconnected(endpointId, now())
            if (endpointId == peer) {
                peer = null
                listener.onPeerChanged(false)
                events?.onPeerDisconnected()
            }
        }
    }

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(endpointId: String, payload: Payload) {
            val rx = now() // timestamp at callback entry; includes any callback-thread queueing (documented limitation)
            if (endpointId != peer || payload.type != Payload.Type.BYTES) { strayPayloads.incrementAndGet(); return }
            val bytes = payload.asBytes() ?: return
            events?.onBytes(bytes, rx)
        }

        override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
            val status = when (update.status) {
                PayloadTransferUpdate.Status.SUCCESS -> TransferStatus.SUCCESS
                PayloadTransferUpdate.Status.FAILURE -> TransferStatus.FAILURE
                PayloadTransferUpdate.Status.CANCELED -> TransferStatus.CANCELED
                else -> return // IN_PROGRESS: not terminal
            }
            transfers.remove(update.payloadId)?.onTransferResult(status) // ids of incoming payloads are simply not found
        }
    }

    companion object {
        /** Distinct from production's "com.ridezz.mobile.mesh". Versioned so a protocol change never meets old peers. */
        const val SERVICE_ID = "com.rideaze.bench.nearby.v1"
        const val NO_PEER = -2
        const val UNKNOWN_FAILURE = -1
    }
}
