# nearby-voice-bench (M1: E1 BYTES benchmark foundation)

An **isolated experiment**, not part of the Rideaze product. It measures how a pair of Android phones behave when
a 20 ms-frame synthetic stream (50 frames/s, sized like encoded Opus at 12-96 kbit/s) is sent with Google Nearby
Connections **BYTES** payloads. It contains no audio, no codec, no LiveKit, no Rideaze room/hazard/identity code, and
imports nothing from `mobile/` or `server/`.

Scope of this milestone: **M1 only** (two phones, BYTES, both measurement modes). STREAM (M2) and relay / concurrent
sources (M3) are not implemented. No physical-device result exists yet: everything below marked *simulated* was run
on a deterministic fake link.

## Isolation guarantees

| Property | How |
| --- | --- |
| Separate app | `applicationId = com.rideaze.bench` (production: `com.ridezz.mobile`) |
| Separate Nearby service | `com.rideaze.bench.nearby.v1` (production: `com.ridezz.mobile.mesh`) |
| Own storage | app-specific external files dir `.../com.rideaze.bench/files/results/`, removed on uninstall; `allowBackup=false` |
| No production credentials | no JWT, room code, LiveKit token, Keystore key or server URL anywhere; no `INTERNET` permission |
| Operator-confirmed pairing | Nearby authentication digits shown on both phones, operator compares and confirms; 60 s window; one peer; stray connections rejected and recorded as run-invalidating breaches |
| Clean release | `RunController.stop()` is idempotent: stops executors, finalises the ledger and writes `run_end`, closes the file, stops advertising/discovery/endpoints, stops the foreground service |
| Schema privacy guard | recorder refuses keys like serial/email/token/location/room/rider/livekit; tests enforce it |

This pairing is **test hygiene, not a security boundary**. Do not reuse it for product pairing.

## Layout

```
core/      pure Kotlin/JVM: everything testable without a phone
  protocol/   Crc16, Prbs, FrameCodec (20-byte overhead wire format), FrameParser (resync, bounds, EOS)
  clock/      ProbeSample, ClockEstimator, Latency   (theta = receiver clock - sender clock)
  queue/      BoundedFrameQueue                      (drop newest / drop oldest, expiry at dequeue)
  measure/    Ledger (async-safe sender/receiver ledgers + reconciliation), Recorder (JSONL v1), Json, ResourceSample, FileSink (lazy, never overwrites), Stats
  platform/   ReadinessCheck (radio/location gate), PermissionPlan (per-API runtime permissions), NearbyStatus (radio status codes)
  pairing/    PairingGate                            (window, name/label/role rules, digits, one peer)
  link/       LinkNode                               (parser + clock probes + END frame; thread-safe)
  run/        ScenarioSpec/Scenarios (E1 matrix), SenderSession, ReceiverSession, RunClassifier, DeviceFlagTracker
  transport/  Transport interface (Nearby in :app, fake in tests)
app/       Android only (NOT compiled in the authoring environment)
  transport/NearbyBytesTransport, measure/AndroidResourceSampler, run/RunController,
  BenchActivity (operator UI), BenchService (foreground), BenchApp
analysis/  analyse_runs.py (+ unit tests), Python standard library only
```

## Build and test

JVM tests (needs only a JDK 17+ and Gradle 8.14+; downloads Kotlin and JUnit from Maven Central):

```bash
cd experiments/nearby-voice-bench
gradle :core:test
python3 -I analysis/test_analyse_runs.py
```

Analysis over the *simulated* fixtures that `:core:test` writes to `core/build/e2e-fixtures/`:

```bash
BENCH_FIXTURE_DIR=$PWD/core/build/e2e-fixtures python3 -I analysis/test_analyse_runs.py
python3 -I analysis/analyse_runs.py core/build/e2e-fixtures --out /tmp/bench-sim-out
```

APK (needs Android SDK platform 36 and access to Google Maven; **never built yet**):

```bash
cd experiments/nearby-voice-bench
export ANDROID_HOME=/path/to/android-sdk
gradle :app:assembleDebug
# -> app/build/outputs/apk/debug/app-debug.apk
```

## What the benchmark does

Two modes, never mixed in one queue or one pass criterion:

| | RAW capacity | REALTIME suitability |
| --- | --- | --- |
| Question | what does the transport sustain? | can frames arrive within speech deadlines? |
| Source queue | 50 frames, drop **newest** | 3 frames, drop **oldest** |
| Expiry | none | dropped at dequeue if older than 80 ms |
| In flight | up to 50 payloads | 2 payloads; a full window drops the oldest queued frame |
| Receiver | records latency, no deadline classes | `ON_TIME` / `UNCERTAIN` / `LATE` against 200 ms using offset-corrected latency **and its uncertainty**; no clock estimate means `UNCLASSIFIED`, never "on time" |

Completion lifecycle (so a normal teardown is never mistaken for a failure): after the last frame the sender sends END
(re-sent every 2 s) and **keeps the connection open until the receiver's DONE arrives or 8 s pass**. The receiver collects
for 3 s after END, then finishes `complete` and sends DONE, whether or not the sender has already disconnected. A disconnect
**before** END is a genuine failure (`DEVICE_DEPENDENT`); no END at all ends `unterminated_idle` (loss counts are then only lower
bounds). The link object exists from the moment the Nearby connection is established, so clock probes are answered even
before either operator presses Start run. A receiver armed *after* the sender started is reported as a configuration error.

In-flight window: slots are freed by the platform's transfer-complete callback (`windowRelease=TRANSFER_RESULT`). Google's
guide says BYTES are sent as one chunk and need not wait for SUCCESS, and describes that update only on the receiving side, so
**sender-side completion callbacks are unverified**. Missing, late, duplicated or contradictory callbacks are reported on their own
(`callbacks`, `inflight_timeouts`, `callback_latency_ms` in `run_end`) and classified **API**, never as a transport limitation.
If a device smoke test shows no sender-side updates, use the `-ack` twin of the scenario (`windowRelease=ACCEPTED`, frees the
slot when `sendPayload()` is accepted; still not delivery). **Both policies are selectable as separate scenario ids**:
`e1-bytes-rt-24k` (TRANSFER_RESULT) and `e1-bytes-rt-24k-ack` (ACCEPTED), 28 ids in total (7 bitrates x 2 modes x 2 policies).
The policy is part of the id, the run fingerprint and `run_start`; an id that disagrees with its policy, or two phones on different
policies, is a configuration error, and the analysis never combines runs from different policies. Three things stay separate in
every record: *accepted by the platform*, *transfer result reported*, and *delivery confirmed by the receiver*.

Every generated frame ends in exactly one state, tracked asynchronously so callbacks may arrive in any order:
generated, dropped before submission (by code), submission pending, accepted by Nearby, rejected, transfer
success/failure reported, received and validated, received after deadline, unresolved at termination.
**`sendPayload()` success is never treated as delivery.** After both phones finish, the analysis reconciles the two
ledgers so each generated frame lands in exactly one terminal bucket.

Timestamps: `theta = clock(receiver) - clock(sender)`; `latency = rx - tx - theta`. Probes run receiver-initiated
(four-timestamp exchange); the minimum-delay recent probe is used; reported uncertainty is `delta/2 + 2 ms
resolution + drift` where drift is estimated when possible and otherwise an **assumed** 100 ppm.

### Failure classes (a failed run is not proof that Nearby cannot carry voice)

| Class | Meaning | Counts as transport evidence? |
| --- | --- | --- |
| `CONFIGURATION` | bad scenario, mismatched scenario/run index between phones, isolation breach | no |
| `IMPLEMENTATION` | ledger/reconciliation invariant violated, driver exception | no |
| `API` | Nearby call failed/rejected (start, accept, send) | no |
| `DEVICE_DEPENDENT` | screen off, battery saver, severe throttling, low battery, radio off, Play services updated, peer lost | no |
| `TRANSPORT_LIMITATION` | clean run that missed a proposal threshold | yes, for the tested devices and conditions only |

Thresholds are the workshop **proposals** (recorded in each run, not hard-coded in the analysis). Every fraction names its
denominator, and real-time success is judged against **generated** frames, so frames dropped before submission count against
the run: REALTIME `on_time / generated`; RAW `accepted / generated` and `received_intact / generated`; both
`transfer_failed / accepted`, `corrupt / received_distinct`, stalls per 120 s. The analysis also prints `on_time / submitted`,
`late / received_intact`, `uncertain / generated`, `unclassified / generated`, `missing / submitted` and the pre-submission drop
fraction separately. Results from the JVM fake link carry `device.simulated=true` and are labelled `[SIM]` / `[SIMULATED - NOT NEARBY]`
and never merged with physical runs.

### Readiness, permissions and Nearby's radio behaviour

**Documented** (search snippets only; the primary pages `developers.google.com` and `android-developers.googleblog.com` were not
reachable): Google announced (Android Developers Blog, July 2026) that Nearby Connections will **stop turning Wi-Fi and Bluetooth on
for apps** from late 2026 (no exact date or Play services version found), so apps must check the radios and prompt the user;
`STATUS_RADIO_ERROR` (8013) covers Bluetooth/Wi-Fi/NFC problems and `STATUS_BLUETOOTH_ERROR` (8007) is deprecated in its favour;
location and Bluetooth permissions are runtime requests (BLUETOOTH_ADVERTISE/CONNECT/SCAN from Android 12).
**Assumed** (not verified): P2P_CLUSTER needs Bluetooth and Wi-Fi enabled (Wi-Fi need not be connected to a network); location
services must be on only before Android 12; COARSE location must accompany FINE on SDK 31-32 because the app targets SDK 36;
`neverForLocation` on BLUETOOTH_SCAN/NEARBY_WIFI_DEVICES is copied from production Rideaze and unverified on a device.

Before pairing, **Start pairing refuses to run** if Bluetooth or Wi-Fi is off (or Location is off on Android 11 and below) and tells the
operator exactly what to switch on. The benchmark never toggles a radio. A state that cannot be read is a warning, not a pass. The
radio and location state of both phones is recorded in `run_start.device.radios`, and a radio status code reported later by Nearby
is classified as a configuration error, not an API defect. Runtime permissions come from one table (`PermissionPlan`) and a test
checks that the manifest declares each of them for every API level it is requested on.

| API level | Runtime permissions requested |
| --- | --- |
| 24-30 | ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION |
| 31-32 | BLUETOOTH_ADVERTISE/CONNECT/SCAN, ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION |
| 33+ | BLUETOOTH_ADVERTISE/CONNECT/SCAN, NEARBY_WIFI_DEVICES, POST_NOTIFICATIONS |

### Completion rules added in M1.1

* A DONE that arrives before the sender has sent END is **ignored and counted** (`callbacks.premature_done_ignored`); it can never
  complete a session.
* If DONE and a disconnect are both recorded when the sender looks, **DONE wins** (`complete`), whichever callback came first.
* A rejected END is judged by how the run ended: benign if DONE confirmed completion or the peer closed after END; an API
  failure only if the receiver never confirmed (`callbacks.end_rejection_disposition`).
* The receiver decides "disconnect before END" when it **processes** the loss, so an END already received counts.

### Reproducibility and grouping

Repeat consistency is `repro_cv` = sample stdev / mean of the per-run **delivery outcome**, a unit-free fraction of *generated*
frames (`on_time/generated` for REALTIME, `intact/generated` for RAW), not raw frame counts. It is a **relative** spread: the
recorded numeric threshold (`repro_cv_max`, currently 0.15, unchanged) would still allow about 14 percentage points on an outcome
near 0.95, so `repro_spread_pp` (max - min in percentage points) is reported beside it. The threshold is read from the runs, never
hard-coded; runs that recorded different thresholds are rejected. One outcome is computed per (scenario id, sender>receiver device
pair, Play services versions); datasets that differ in any of those, in policy, or in simulated/physical origin are never merged.

## Operating on two phones

Preconditions: two Android 7.0+ phones with Google Play services, USB debugging, Bluetooth and Wi-Fi **on**,
battery saver **off**, screens stay on, similar charge level, nothing else running. Record both models and the
Play services version (the app records them too).

1. Install on both phones:
   ```bash
   adb -s <SERIAL_A> install -r app/build/outputs/apk/debug/app-debug.apk
   adb -s <SERIAL_B> install -r app/build/outputs/apk/debug/app-debug.apk
   ```
2. On both: turn **Bluetooth and Wi-Fi ON** (and Location on Android 11 and below), open **Rideaze Bench**, press **1. Grant
   permissions** and accept everything. Pairing refuses to start otherwise and says what to switch on.
3. On both: pick the **same scenario**, the **same session label** (e.g. `A1`) and the **same run index** (0-4 for
   five repeats). Set one phone to **RECEIVER**, the other to **SENDER**.
4. Press **2. Start pairing** on both within a few seconds (window is 60 s). Each phone shows 4 digits. Compare them
   physically; press **Digits MATCH** on both, or **Digits DIFFER** to abort (that invalidates the run).
5. Wait until both show `STAGE: CONNECTED`.
6. Press **3. Start run** on the **RECEIVER** first, then on the **SENDER** (clock probes are already answered once
   connected; a receiver started after the sender is flagged as a configuration error).
7. A 120 s run finishes by itself (sender about 125 s including the completion handshake; the receiver finishes about 3 s after END). Both show `FINISHED`
   and the result path. Press **Reset for a new attempt**, increment the run index, repeat from step 3.
8. Optional operator-side readings the app cannot take (record manually before/after a campaign):
   `adb shell dumpsys cpuinfo | grep gms`, `adb shell dumpsys meminfo com.google.android.gms`.
9. Pull results from **both** phones into one folder and analyse:
   ```bash
   mkdir -p results
   adb -s <SERIAL_A> pull /sdcard/Android/data/com.rideaze.bench/files/results/. results/
   adb -s <SERIAL_B> pull /sdcard/Android/data/com.rideaze.bench/files/results/. results/
   python3 -I analysis/analyse_runs.py results --out results/summary
   ```
10. Clean up: press **Stop / release everything**, then `adb uninstall com.rideaze.bench` on both phones.

Run each scenario five times; do not interpret fewer. A pass on two phones is not evidence for 10 or 30 riders.

## Verification status

| Item | Status |
| --- | --- |
| `:core` compile (warnings are errors) and JUnit tests | **Real**: run with a JDK and Gradle |
| Python analysis tests and Kotlin-written JSONL compatibility | **Real** (the compatibility run reads files the real Kotlin recorder wrote from the fake link) |
| `:app` against handwritten Java stubs of Android and Nearby | Compiles, but the stubs are the author's recollection of the APIs: this checks internal consistency only |
| `:app` against the real Android SDK and play-services-nearby 19.3.0 | **Never built. Unverified.** (no SDK; Google Maven is blocked in the authoring environment) |
| Nearby callback semantics, `authenticationDigits`, permission set, AGP/Gradle/compileSdk, Android 12-15 service rules | **Unverified** |
| Any physical-device behaviour | **Unknown** |

Documentation consulted (search snippets only; the primary pages were not reachable): Google's *Manage connections* guide
describes `onConnectionInitiated` authentication tokens/digits and both-sides accept/reject; its *Exchange data* guide says BYTES
are sent as a single chunk and the SUCCESS update need not be awaited; its *Get started* guide lists location and Bluetooth
permissions as runtime requests.

## Known limitations

* The Android module has **never been built or run**. Do not treat it as a buildable APK until a real build succeeds.
* Nearby API details are unverified against Google's primary documentation. Highest risk: `ConnectionInfo.authenticationDigits`
  in play-services-nearby 19.3.0 (if absent, pairing cannot complete; the gate refuses to skip digits), `NEARBY_WIFI_DEVICES`
  and the rest of the permission set, sender-side transfer updates for BYTES, and callback threading.
* Receive timestamps are taken at callback entry and include any delay before the callback runs (probably the main thread).
  The reported uncertainty does **not** include that delay. Moving parsing off the callback thread would be a larger change and is
  not done; callback-thread entry points only record state, and all finalisation and file writing happen on the driver thread.
* Not measured (no verified method): radio airtime, platform retransmissions, physical medium used, Play services CPU/memory
  (use the `dumpsys` readings above). Battery current/charge are indicative only.
* A missing END plus a sender hang-up looks identical to an early disconnect and is flagged `DEVICE_DEPENDENT`.
* Everything in "Readiness, permissions and Nearby's radio behaviour" marked *assumed* is unverified; the Android 13+ behaviour with
  `neverForLocation` and the radio-enablement change (rollout date unknown) in particular need a device.
* Build files pin AGP 8.13 / compileSdk 36 (Rideaze uses AGP 9 / compileSdk 37), declared once in `settings.gradle.kts`.
  `android.useAndroidX=true` is set because play-services artifacts are AndroidX-based. All unverified.
* The frame payload is pseudo-random bytes, not audio; it ignores codec behaviour and packet-loss concealment.
* Offsets between the two phones' uptimes within ~50 ms of exactly 24.8 days (2^31 ms) are mis-estimated by the modular arithmetic.
