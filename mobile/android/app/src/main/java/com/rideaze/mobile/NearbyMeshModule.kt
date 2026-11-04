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

  private val connected = ConcurrentHashMap<String, Peer>()
  private val pending = ConcurrentHashMap<String, Peer>()
  private val discovered = ConcurrentHashMap<String, String>()
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

    stopInternal()
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
        emit("onHazardReceived", json)
        emit(
          "onPayloadReceivedFrom",
          JSONObject().put("endpointId", endpointId).put("payload", json).toString(),
        )
      }

      override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {}
    }

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
