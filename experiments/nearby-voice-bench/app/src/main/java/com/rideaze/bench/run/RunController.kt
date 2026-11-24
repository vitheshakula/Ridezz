package com.rideaze.bench.run

import android.app.Application
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import com.rideaze.bench.BenchService
import com.rideaze.bench.core.MonotonicClock
import com.rideaze.bench.core.link.LinkNode
import com.rideaze.bench.core.measure.FileSink
import com.rideaze.bench.core.measure.Recorder
import com.rideaze.bench.core.pairing.PairRole
import com.rideaze.bench.core.pairing.PairingGate
import com.rideaze.bench.core.platform.RadioState
import com.rideaze.bench.core.platform.ReadinessCheck
import com.rideaze.bench.core.run.DeviceFlag
import com.rideaze.bench.core.run.DeviceFlagTracker
import com.rideaze.bench.core.run.Phase
import com.rideaze.bench.core.run.ReceiverSession
import com.rideaze.bench.core.run.RunContext
import com.rideaze.bench.core.run.ScenarioSpec
import com.rideaze.bench.core.run.Scenarios
import com.rideaze.bench.core.run.SenderSession
import com.rideaze.bench.measure.AndroidRadioState
import com.rideaze.bench.measure.AndroidResourceSampler
import com.rideaze.bench.transport.NearbyBytesTransport
import java.io.File
import java.security.SecureRandom
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns one benchmark attempt: pairing -> connected -> run -> finished/stopped. Everything with logic lives in
 * :core and is unit tested; this class only wires Android pieces (threads, files, Nearby) to it.
 *
 * The [LinkNode] is created together with the Nearby transport (at pairing), so clock probes are answered from the
 * moment the connection is established, independent of when either operator presses "Start run". Sessions attach
 * to the existing link later. stop() is idempotent and is the single place that releases threads, files and the
 * Nearby connection.
 */
class RunController(private val app: Application) {
    enum class Stage { IDLE, PAIRING, AWAITING_DIGITS, CONNECTED, RUNNING, FINISHED }

    data class Snapshot(val stage: Stage, val lines: List<String>, val digits: String?, val resultFile: String?)

    private val clock = MonotonicClock { SystemClock.elapsedRealtime() }
    private val sampler = AndroidResourceSampler(app)
    private val tracker = DeviceFlagTracker()
    private val lock = Any()
    private val log = ArrayDeque<String>()

    @Volatile private var stage = Stage.IDLE
    @Volatile private var digits: String? = null
    @Volatile private var digitsEndpoint: String? = null
    @Volatile private var resultPath: String? = null

    private var spec: ScenarioSpec? = null
    private var runIndex = 0
    private var role = PairRole.SENDER
    private var gate: PairingGate? = null
    private var transport: NearbyBytesTransport? = null
    private var link: LinkNode? = null
    private var recorder: Recorder? = null
    private var sink: FileSink? = null
    private var sender: SenderSession? = null
    private var receiver: ReceiverSession? = null
    private var driver: ScheduledExecutorService? = null
    private var sampling: ScheduledExecutorService? = null
    private var gmsBefore: String? = null
    private val tornDown = AtomicBoolean(true)
    private val endingStarted = AtomicBoolean(false)
    private val pendingApiFailures = ArrayList<String>()
    private val radioFailures = ArrayList<String>()
    private var radios = RadioState(null, null, null)
    private var readinessWarnings: List<String> = emptyList()

    /** Evaluated by the sessions when they FINALISE, so late-arriving conditions are included in run_end. */
    private val ctx = object : RunContext {
        override fun isolationBreaches() = gate?.isolationBreaches() ?: emptyList()
        override fun deviceFlags(): Set<DeviceFlag> {
            tracker.compareServiceVersion(gmsBefore, sampler.playServicesVersion())
            return tracker.flags()
        }
        override fun apiFailures(): List<String> = synchronized(pendingApiFailures) { pendingApiFailures.toList() }
        override fun configErrors(): List<String> = synchronized(pendingApiFailures) { radioFailures.toList() }
        override fun deviceInfo(): Map<String, Any?> = linkedMapOf(
            "model" to Build.MODEL, "sdk" to Build.VERSION.SDK_INT, "app_version" to "m1-0.2", "services_version" to gmsBefore,
            "simulated" to false, "radios" to radios.toMap(), "readiness_warnings" to readinessWarnings,
        )
    }

    fun snapshot(): Snapshot = synchronized(lock) { Snapshot(stage, log.toList(), digits, resultPath) }

    private fun note(msg: String) = synchronized(lock) { log.addLast(msg); while (log.size > 14) log.removeFirst() }

    /** Returns configuration errors, or an empty list when pairing has started. */
    fun beginPairing(scenarioId: String, label: String, runIdx: Int, myRole: PairRole): List<String> {
        synchronized(lock) {
            if (stage != Stage.IDLE) return listOf("a session is active: press Stop first")
            val errs = ArrayList<String>()
            val s = Scenarios.byId(scenarioId)
            if (s == null) errs.add("unknown scenario '$scenarioId'") else errs.addAll(s.validate())
            if (!label.matches(Regex("[A-Za-z0-9]{1,8}"))) errs.add("label must be 1-8 letters/digits")
            if (runIdx !in 0..15) errs.add("run index must be 0..15")
            if (errs.isNotEmpty() || s == null) return errs
            // Readiness is checked BEFORE anything is started. We never toggle a radio: we tell the operator what to switch on.
            val state = AndroidRadioState(app).read()
            val ready = ReadinessCheck.evaluate(Build.VERSION.SDK_INT, state)
            if (!ready.ok) { note("NOT READY: ${ready.blockers.size} problem(s)"); return ready.blockers.map { "NOT READY: $it" } }
            radios = state; readinessWarnings = ready.warnings
            ready.warnings.forEach { note("WARNING: $it") }
            spec = s; runIndex = runIdx; role = myRole
            log.clear(); resultPath = null; digits = null
            synchronized(pendingApiFailures) { pendingApiFailures.clear(); radioFailures.clear() }
            tornDown.set(false); endingStarted.set(false)

            val g = PairingGate(label, myRole)
            g.open(clock.nowMs())
            gate = g
            // Run id must be identical on both phones so analysis can pair the files: scenario + run index + session label.
            val rid = s.runId(runIdx, label)
            val roleName = myRole.name.lowercase()
            val dir = File(app.getExternalFilesDir(null) ?: app.filesDir, "results")
            val tag = java.lang.Long.toString(System.currentTimeMillis(), 36) // local, makes every file name unique
            val fs = FileSink(File(dir, "$rid.$roleName.$tag.jsonl")); sink = fs
            val rec = Recorder(fs, rid, roleName, clock); recorder = rec

            val t = NearbyBytesTransport(app, g, myRole, randomNonce(), object : NearbyBytesTransport.Listener {
                override fun onDigits(endpointId: String, digits: String) {
                    digitsEndpoint = endpointId; this@RunController.digits = digits; stage = Stage.AWAITING_DIGITS
                    note("compare digits with the other phone: $digits")
                }
                override fun onStatus(msg: String) = note(msg)
                override fun onApiFailure(msg: String, radio: Boolean) {
                    synchronized(pendingApiFailures) { if (radio) radioFailures.add("radio unavailable: $msg (turn Bluetooth and Wi-Fi ON and repeat the run)") else pendingApiFailures.add(msg) }
                    note((if (radio) "RADIO FAILURE: " else "API FAILURE: ") + msg)
                }
                override fun onPeerChanged(connected: Boolean) {
                    if (connected && stage != Stage.RUNNING) { stage = Stage.CONNECTED; digits = null; note("connected. Receiver: Start run first, then sender.") }
                    if (!connected && stage == Stage.CONNECTED) { stage = Stage.IDLE; note("peer disconnected before the run: press Stop and pair again") }
                }
            })
            transport = t
            // The link exists from now on: it answers clock probes as soon as the connection is up (receiver-first startup).
            val l = LinkNode(clock, t, rec, s, runIdx % 16, s.fingerprint(runIdx), initiatesProbes = myRole == PairRole.RECEIVER)
            link = l
            t.events = l
            gmsBefore = sampler.playServicesVersion()
            stage = Stage.PAIRING
            note("pairing window open 60 s as ${myRole.name} (${s.id}, run $runIdx)")
            try {
                if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(Intent(app, BenchService::class.java))
                else app.startService(Intent(app, BenchService::class.java))
                t.start()
            } catch (e: Throwable) {
                synchronized(pendingApiFailures) { pendingApiFailures.add("pairing start failed: ${e.javaClass.simpleName}: ${e.message}") }
                note("could not start pairing: ${e.message}")
                Thread { stop("start_failed") }.start()
            }
        }
        return emptyList()
    }

    fun confirmDigits(match: Boolean) {
        val ep = digitsEndpoint ?: return
        digits = null; digitsEndpoint = null
        stage = Stage.PAIRING
        transport?.confirm(ep, match)
        note(if (match) "accepted: waiting for the other phone" else "rejected digits (run will be flagged invalid)")
    }

    fun startRun(): String? {
        synchronized(lock) {
            if (stage != Stage.CONNECTED) return "not connected"
            val s = spec!!; val g = gate!!; val l = link!!; val rec = recorder!!
            resultPath = sink!!.file.absolutePath
            for (e in g.log()) rec.pairing(e.event, e.endpointHash, e.detail)
            val epoch = runIndex % 16
            try {
                if (role == PairRole.SENDER) sender = SenderSession(s, clock, l, rec, epoch, runIndex, ctx)
                else receiver = ReceiverSession(s, clock, l, rec, epoch, runIndex, ctx)
                sender?.start(); receiver?.start()
            } catch (e: Throwable) { fault(e); return "start failed: ${e.message}" }
            stage = Stage.RUNNING
            sampling = Executors.newSingleThreadScheduledExecutor().also { ex ->
                var n = 0
                ex.scheduleAtFixedRate({
                    try {
                        val smp = sampler.sample(); tracker.observe(smp); rec.sample(smp)
                        if (++n % 5 == 0) rec.flush()
                    } catch (e: Throwable) { fault(e) }
                }, 0, s.resourceSampleIntervalMs, TimeUnit.MILLISECONDS)
            }
            driver = Executors.newSingleThreadScheduledExecutor().also { ex ->
                ex.scheduleAtFixedRate({
                    try {
                        val now = clock.nowMs()
                        sender?.tick(now); receiver?.tick(now)
                        if (sender?.phase == Phase.FINISHED || receiver?.finished == true) finishedByItself()
                    } catch (e: Throwable) { fault(e) }
                }, 0, 2, TimeUnit.MILLISECONDS)
            }
            note("run started")
        }
        return null
    }

    private fun finishedByItself() {
        if (!endingStarted.compareAndSet(false, true)) return
        note("run finished: ${sender?.status ?: receiver?.status}")
        val isReceiver = receiver != null
        // Never tear down from the driver thread itself. The receiver waits briefly so its DONE message can leave
        // before the connection closes; the sender has already waited for DONE (or its timeout) inside the session.
        Thread { if (isReceiver) Thread.sleep(DONE_FLUSH_MS); stop("finished") }.start()
    }

    private fun fault(e: Throwable) {
        val m = "${e.javaClass.simpleName}: ${e.message}"
        note("FAULT $m")
        sender?.recordFault(m); receiver?.recordFault(m)
        if (endingStarted.compareAndSet(false, true)) Thread { stop("fault") }.start()
    }

    /** Idempotent. Ends the session (writing run_end if a run was active) and releases every resource. */
    fun stop(reason: String) {
        if (!tornDown.compareAndSet(false, true)) return
        runCatching { driver?.shutdownNow()?.also { driver?.awaitTermination(500, TimeUnit.MILLISECONDS) } }
        runCatching { sampling?.shutdownNow() }
        runCatching { sender?.abort(reason) }   // no-op if already finished
        runCatching { receiver?.stop(reason) }  // no-op if already finished
        runCatching { recorder?.close() }
        runCatching { transport?.close() }
        driver = null; sampling = null; transport = null; link = null; recorder = null; sink = null; sender = null; receiver = null; gate = null
        runCatching { app.stopService(Intent(app, BenchService::class.java)) }
        synchronized(lock) {
            note("stopped ($reason). results: ${resultPath ?: "none"}")
            digits = null; digitsEndpoint = null
            stage = if (resultPath != null) Stage.FINISHED else Stage.IDLE
        }
    }

    /** Back to IDLE so a new attempt can start (results files are kept). */
    fun reset() { stop("reset"); synchronized(lock) { stage = Stage.IDLE } }

    private fun randomNonce(): String {
        val a = "abcdefghijkmnpqrstuvwxyz23456789"; val r = SecureRandom()
        return (1..4).map { a[r.nextInt(a.length)] }.joinToString("")
    }

    private companion object { const val DONE_FLUSH_MS = 500L }
}
