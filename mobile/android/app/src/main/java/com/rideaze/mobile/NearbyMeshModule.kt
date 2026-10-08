package com.rideaze.mobile

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.facebook.react.uimanager.ViewManager
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Offline rider-to-rider hazard transport over Google Nearby Connections (P2P_CLUSTER: many-to-many).
 *
 * Every rider advertises AND discovers under one service id. The advertised endpoint name carries
 * the room code and a per-session rider id ("ROOM|riderId|name"), so riders only connect to others
 * in the same room. To avoid both sides dialling each other at once, only the side with the smaller
 * rider id opens the connection. Once connected, a hazard packet is one small byte payload sent to
 * every connected rider -- no polling, no advertising tricks.
 *
 * Emits `onHazardReceived` (raw packet JSON), `onMeshStatus` (JSON: active, peers, error), and
 * `onPeerCountChanged` (JSON: peerCount) every time a rider connects or disconnects. Logs under
 * tag "NearbyMesh" (`adb logcat -s NearbyMesh`).
 *
 * Endpoint-aware interface (Ride Connectivity Protocol): every received bytes payload is ALSO
 * emitted as `onPayloadReceivedFrom` (JSON: endpointId, payload), and `sendPayloadTo` sends to one
 * confirmed endpoint. Phase 1 consumes `onHazardReceived` only; the protocol layer must consume
 * `onPayloadReceivedFrom` only, or each packet is processed twice. endpointId is a transport-local
 * Nearby endpoint id, never a Rideaze node id.
 *
 * Connection lifecycle: discovered -> (dialled: `connecting`) -> initiated: `pending` ->
 * STATUS_OK: `connected`. Only `connected` endpoints count as peers or receive payloads; failure,
 * disconnect and stop remove an endpoint from every collection.
 *
 * Limits: single hop here (the JS layer relays between riders and to/from the cloud room), and the
 * radio range is whatever Bluetooth/BLE/Wi-Fi give the phones -- typically tens of metres outdoors,
 * less with phones in pockets/helmets. Requires Google Play Services, Bluetooth on, and the runtime
 * permissions granted by the JS caller (see requiredPermissions()).
 */
class NearbyMeshModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "NearbyMesh"
    private const val SERVICE_ID = "com.ridezz.mobile.mesh"
    private const val RETRY_INTERVAL_MS = 8_000L
  }

  private class Peer(val name: String)

  private val handler = Handler(Looper.getMainLooper())

  @Volatile private var client: ConnectionsClient? = null
  @Volatile private var active = false
  @Volatile private var room: String = ""
  @Volatile private var riderName: String = ""
  @Volatile private var riderId: String = ""
  @Volatile private var lastError: String? = null

  /** Confirmed connections (STATUS_OK). The only valid peers and send targets. */
  private val connected = ConcurrentHashMap<String, Peer>()
  /** Initiated and accepted, awaiting the connection result. Not yet a peer or send target. */
  private val pending = ConcurrentHashMap<String, Peer>()
  /** Same-room endpoints seen by discovery -> their rider id. */
  private val discovered = ConcurrentHashMap<String, String>()
  /** Endpoints with a connection attempt in flight. */
  private val connecting = ConcurrentHashMap.newKeySet<String>()

  private val retryTick =
    object : Runnable {
      override fun run() {
        if (!active) return
        connectToDiscovered()
        handler.postDelayed(this, RETRY_INTERVAL_MS)
      }
    }

  override fun getName(): String = "NearbyMeshModule"

  @ReactMethod
  fun startMeshSession(roomCode: String, riderName: String, promise: Promise) {
    val missing = requiredPermissions().filter {
      ContextCompat.checkSelfPermission(reactContext, it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      promise.reject(
        "mesh_permission_denied",
        "Missing permission: " + missing.joinToString { it.substringAfterLast('.') },
      )
      return
    }
    if (BluetoothAdapter.getDefaultAdapter()?.isEnabled == false) {
      promise.reject("mesh_bluetooth_off", "Bluetooth is off. Turn it on for the offline mesh.")
      return
    }

    stopInternal() // idempotent restart
    val nearby = Nearby.getConnectionsClient(reactContext)
    client = nearby
    room = roomCode.trim().uppercase()
    this.riderName = riderName.replace('|', ' ').take(24)
    riderId = UUID.randomUUID().toString().take(8)
    lastError = null
    Log.d(TAG, "start: room=$room riderId=$riderId")

    val settled = AtomicBoolean(false)
    val fail = { step: String, e: Exception ->
      Log.d(TAG, "start failed at $step: ${describe(e)}")
      if (settled.compareAndSet(false, true)) {
        stopInternal()
        promise.reject("mesh_start_failed", "$step: ${describe(e)}", e)
      }
    }

    nearby
      .startAdvertising(
        "$room|$riderId|${this.riderName}",
        SERVICE_ID,
        lifecycle,
        AdvertisingOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
      )
      .addOnSuccessListener {
        Log.d(TAG, "advertising")
        nearby
          .startDiscovery(
            SERVICE_ID,
            discoveryCallback,
            DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).build(),
          )
          .addOnSuccessListener {
            Log.d(TAG, "discovering")
            active = true
            emitStatus()
            handler.postDelayed(retryTick, RETRY_INTERVAL_MS)
            if (settled.compareAndSet(false, true)) promise.resolve(null)
          }
          .addOnFailureListener { fail("startDiscovery", it) }
      }
      .addOnFailureListener { fail("startAdvertising", it) }
  }

  @ReactMethod
  fun stopMeshSession(promise: Promise) {
    stopInternal()
    promise.resolve(null)
  }

  /** Sends [payloadJson] (a HazardPacket) to every rider currently connected over the mesh. */
  @ReactMethod
  fun broadcastHazard(payloadJson: String, promise: Promise) {
    val nearby = client
    if (!active || nearby == null) {
      promise.reject("mesh_inactive", "Mesh session is not running")
      return
    }
    val targets = connected.keys.toList()
    if (targets.isEmpty()) {
      promise.reject("mesh_no_peers", "No riders nearby on the mesh")
      return
    }
    nearby
      .sendPayload(targets, Payload.fromBytes(payloadJson.toByteArray(Charsets.UTF_8)))
      .addOnSuccessListener {
        Log.d(TAG, "hazard sent to ${targets.size} rider(s): $payloadJson")
        promise.resolve(null)
      }
      .addOnFailureListener {
        Log.d(TAG, "hazard send failed: ${describe(it)}")
        promise.reject("mesh_broadcast_failed", describe(it), it)
      }
  }

  /**
   * Sends [payload] to exactly one confirmed endpoint. Rejects, and never falls back to broadcast,
   * when the session is inactive or [endpointId] is empty, pending, unknown or disconnected.
   * Resolving means the Nearby send Task succeeded; it is not Rideaze delivery acknowledgement.
   */
  @ReactMethod
  fun sendPayloadTo(endpointId: String, payload: String, promise: Promise) {
    val nearby = client
    if (!active || nearby == null) {
      promise.reject("mesh_inactive", "Mesh session is not running")
      return
    }
    if (endpointId.isBlank()) {
      promise.reject("mesh_invalid_endpoint", "Endpoint id is empty")
      return
    }
    if (!connected.containsKey(endpointId)) {
      promise.reject("mesh_unknown_endpoint", "Endpoint $endpointId is not a confirmed connection")
      return
    }
    val bytes = payload.toByteArray(Charsets.UTF_8)
    nearby
      .sendPayload(endpointId, Payload.fromBytes(bytes))
      .addOnSuccessListener {
        Log.d(TAG, "payload (${bytes.size} bytes) sent to $endpointId")
        promise.resolve(null)
      }
      .addOnFailureListener {
        Log.d(TAG, "send to $endpointId failed: ${describe(it)}")
        promise.reject("mesh_send_failed", describe(it), it)
      }
  }

  // --- discovery ---------------------------------------------------------------------------

  private val discoveryCallback =
    object : EndpointDiscoveryCallback() {
      override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
        val parsed = parseEndpointName(info.endpointName) ?: return
        if (parsed.first != room) return
        Log.d(TAG, "found $endpointId (${parsed.third}, id=${parsed.second})")
        discovered[endpointId] = parsed.second
        connectToDiscovered()
      }

      override fun onEndpointLost(endpointId: String) {
        Log.d(TAG, "lost $endpointId")
        discovered.remove(endpointId)
      }
    }

  /** Dials every discovered same-room rider we are not yet connected to -- but only those with a
   * larger id than ours, so exactly one side of each pair initiates. */
  private fun connectToDiscovered() {
    val nearby = client ?: return
    for ((endpointId, remoteId) in discovered) {
      if (
        riderId >= remoteId ||
        connected.containsKey(endpointId) ||
        pending.containsKey(endpointId) ||
        !connecting.add(endpointId)
      ) continue
      Log.d(TAG, "requesting connection to $endpointId")
      nearby
        .requestConnection("$room|$riderId|$riderName", endpointId, lifecycle)
        .addOnFailureListener {
          connecting.remove(endpointId)
          Log.d(TAG, "requestConnection failed: ${describe(it)}")
        }
    }
  }

  // --- connections -------------------------------------------------------------------------

  private val lifecycle =
    object : ConnectionLifecycleCallback() {
      override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
        val parsed = parseEndpointName(info.endpointName)
        if (parsed == null || parsed.first != room) {
          Log.d(TAG, "rejecting $endpointId (other room)")
          client?.rejectConnection(endpointId)
          connecting.remove(endpointId)
          return
        }
        // Pending until onConnectionResult reports STATUS_OK; not a peer or send target yet.
        pending[endpointId] = Peer(parsed.third)
        client
          ?.acceptConnection(endpointId, payloadCallback)
          ?.addOnFailureListener {
            Log.d(TAG, "acceptConnection $endpointId failed: ${describe(it)}")
            pending.remove(endpointId)
            connecting.remove(endpointId)
          }
      }

      override fun onConnectionResult(endpointId: String, result: ConnectionResolution) {
        connecting.remove(endpointId)
        val peer = pending.remove(endpointId)
        if (result.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
          Log.d(TAG, "connected: $endpointId")
          connected[endpointId] = peer ?: Peer("")
        } else {
          Log.d(TAG, "connection to $endpointId failed: ${result.status.statusCode}")
          connected.remove(endpointId)
        }
        emitStatus()
      }

      override fun onDisconnected(endpointId: String) {
        Log.d(TAG, "disconnected: $endpointId")
        connected.remove(endpointId)
        pending.remove(endpointId)
        connecting.remove(endpointId)
        emitStatus()
      }
    }

  private val payloadCallback =
    object : PayloadCallback() {
      override fun onPayloadReceived(endpointId: String, payload: Payload) {
        val bytes = payload.asBytes() ?: return
        val json = String(bytes, Charsets.UTF_8)
        Log.d(TAG, "hazard received from $endpointId: $json")
        // Phase 1 event, unchanged shape (raw payload string).
        emit("onHazardReceived", json)
        // Endpoint-aware event for the connectivity protocol; the same payload with its sender.
        emit(
          "onPayloadReceivedFrom",
          JSONObject().put("endpointId", endpointId).put("payload", json).toString(),
        )
      }

      override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }

  // --- helpers -----------------------------------------------------------------------------

  /** "ROOM|riderId|name" -> (room, riderId, name), or null if it isn't one of ours. */
  private fun parseEndpointName(endpointName: String): Triple<String, String, String>? {
    val parts = endpointName.split('|', limit = 3)
    return if (parts.size == 3 && parts[1].isNotEmpty()) Triple(parts[0], parts[1], parts[2]) else null
  }

  private fun requiredPermissions(): List<String> {
    val permissions = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      permissions += Manifest.permission.BLUETOOTH_SCAN
      permissions += Manifest.permission.BLUETOOTH_ADVERTISE
      permissions += Manifest.permission.BLUETOOTH_CONNECT
    }
    permissions +=
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) Manifest.permission.NEARBY_WIFI_DEVICES
      else Manifest.permission.ACCESS_FINE_LOCATION
    return permissions
  }

  private fun describe(e: Exception): String {
    val code = (e as? ApiException)?.statusCode
    return if (code != null) "${ConnectionsStatusCodes.getStatusCodeString(code)} ($code)" else (e.message ?: "error")
  }

  private fun emitStatus() {
    val json = JSONObject().put("active", active).put("peers", connected.size)
    lastError?.let { json.put("error", it) }
    emit("onMeshStatus", json.toString())
    emit("onPeerCountChanged", JSONObject().put("peerCount", connected.size).toString())
  }

  private fun stopInternal() {
    val wasActive = active
    active = false
    handler.removeCallbacks(retryTick)
    val nearby = client
    client = null
    connected.clear()
    pending.clear()
    discovered.clear()
    connecting.clear()
    if (nearby != null) {
      Log.d(TAG, "stop")
      nearby.stopAdvertising()
      nearby.stopDiscovery()
      nearby.stopAllEndpoints()
    }
    if (wasActive) {
      lastError = null
      emitStatus()
    }
  }

  override fun invalidate() {
    stopInternal()
    super.invalidate()
  }

  private fun emit(event: String, payload: String) {
    if (!reactContext.hasActiveReactInstance()) return
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(event, payload)
  }
}

class NearbyMeshPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(NearbyMeshModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
