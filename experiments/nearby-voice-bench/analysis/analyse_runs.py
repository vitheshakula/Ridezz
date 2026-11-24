#!/usr/bin/env python3
"""Analyse nearby-voice-bench JSON Lines results (schema v1). Standard library only.

Run:   python3 -I analysis/analyse_runs.py <results_dir> [--out <dir>]

Input: <results_dir>/*.jsonl as pulled from the two phones (one file per run per phone; any file name).
       A run is the pair of files sharing a run_id: one with role "sender", one with role "receiver".
Output: a text report on stdout and, with --out, summary_runs.csv and summary_scenarios.csv.

DENOMINATORS (every derived fraction names its denominator; none is implicit):
  generated            frames the sender produced (the only denominator used for real-time/delivery success)
  submitted            generated - dropped_pre_submission  (= accepted + rejected + unresolved_submit)
  accepted             submissions the platform accepted (NOT delivery)
  received_intact      distinct frames received with valid CRC and PRBS (any timeliness class)
  received_distinct    distinct frames received including corrupt ones
  on_time / late / uncertain / unclassified   REALTIME receiver classes of received_intact
  missing_submitted    submitted frames never seen by the receiver (an upper bound if the receiver never saw END)
Pass criteria are PROPOSALS recorded in each run: RAW  accepted/generated and received_intact/generated;
REALTIME  on_time/generated (so frames dropped before submission count against the run); both: transfer_failed/accepted,
corrupt/received_distinct, stalls per 120 s.

WINDOW POLICY: scenario ids ending in "-ack" ran windowRelease=ACCEPTED (slot freed when the platform ACCEPTED the bytes); the
others ran TRANSFER_RESULT. Neither is delivery: delivery is only what the receiver ledger confirms. Runs from different policies,
device pairs (sender>receiver models) or Google Play services versions are never combined into one outcome.

SIMULATED data (device model "jvm-test" / device.simulated=true) is produced by the JVM fake link, never by Nearby. It is
labelled everywhere and never mixed with physical runs in one scenario outcome.

What this does NOT do: it makes no claim about Nearby in general. Thresholds are the PROPOSALS recorded in each
run's run_start (never hard-coded here). Runs classified CONFIGURATION / IMPLEMENTATION / API / DEVICE_DEPENDENT
are INVALID for transport conclusions and are excluded from pass/fail counting.
"""
import csv
import json
import math
import os
import sys

SCHEMA_VERSION = 1
COMMON = {"v", "type", "run_id", "role", "t_ms"}
TYPES = {
    "run_start": ({"scenario", "run_index", "epoch", "fingerprint", "device", "thresholds", "unavailable_metrics", "wire_overhead_bytes"}, set()),
    "pairing": ({"event", "endpoint_hash", "detail"}, set()),
    "probe": ({"seq", "t0", "t1", "t2", "t3", "delay_ms", "offset_ms", "accepted"}, set()),
    "sample": ({"cpu_user_ticks", "cpu_system_ticks", "clk_tck", "pss_kb", "batt_pct", "batt_charge_uah", "batt_current_ua",
                "batt_temp_deci_c", "thermal_status", "power_save", "screen_on", "wifi_on", "bt_on"}, set()),
    "event": ({"name", "detail"}, set()),
    "frame_tx": ({"seq", "gen_ms", "bytes", "submit", "drop", "reject_code", "transfer", "transfer_before_ack", "submit_ms", "ack_ms", "transfer_ms"}, set()),
    "frame_rx": ({"seq", "txms", "rx_ms", "cls", "latency_ms", "uncertainty_ms", "bytes"}, set()),
    "run_end": ({"status", "counts", "bytes", "invariants", "parser", "probes", "stalls", "verdict"},
                {"expected_frames", "never_received_upper_bound", "unterminated", "inflight_timeouts", "prbs_mismatch", "wrong_epoch_frames",
                 "callbacks", "callback_latency_ms", "peer_done_ack", "unhandled_audio_frames", "peer_lost"}),
}
FORBIDDEN_KEY_PARTS = ["serial", "imei", "android_id", "account", "email", "token", "location", "latitude", "longitude",
                       "ssid", "mac_addr", "bssid", "password", "jwt", "room", "rider", "livekit"]
INVALID_CLASSES = {"CONFIGURATION", "IMPLEMENTATION", "API", "DEVICE_DEPENDENT"}
PRIORITY = {"NONE": 0, "TRANSPORT_LIMITATION": 1, "DEVICE_DEPENDENT": 2, "API": 3, "IMPLEMENTATION": 4, "CONFIGURATION": 5}


# "location_services" is the on/off state of the device's location SETTING, not location data; Boolean/None values only.
ALLOWED_EXACT_KEYS = {"location_services"}


def validate_record(rec):
    """Return a list of schema problems for one parsed record."""
    errs = []
    spec = TYPES.get(rec.get("type"))
    if spec is None:
        return ["unknown type %r" % rec.get("type")]
    required, optional = spec
    if rec.get("v") != SCHEMA_VERSION:
        errs.append("bad version")
    for k in rec:
        if k not in COMMON | required | optional:
            errs.append("unexpected key %r in %s" % (k, rec["type"]))
    for k in COMMON | required:
        if k not in rec:
            errs.append("missing key %r in %s" % (k, rec["type"]))
    errs.extend(_forbidden(rec))
    return errs


def _forbidden(v):
    out = []
    if isinstance(v, dict):
        for k, x in v.items():
            if str(k).lower() in ALLOWED_EXACT_KEYS:
                if x is not None and not isinstance(x, bool):
                    out.append("key %r must hold a boolean or null" % k)
            elif any(p in str(k).lower() for p in FORBIDDEN_KEY_PARTS):
                out.append("forbidden key %r" % k)
            out.extend(_forbidden(x))
    elif isinstance(v, list):
        for x in v:
            out.extend(_forbidden(x))
    return out


def load_dir(path):
    """Returns ({run_id: {role: [records], "_dups": [...]}}, [problems]).

    Two files for the same (run_id, role) are NEVER merged (that would silently double a run): the first file is kept,
    the duplicates are listed under "_dups" and reported as problems, and analyse_run marks the run CONFIGURATION."""
    runs, problems = {}, []
    owner = {}
    for name in sorted(os.listdir(path)):
        if not name.endswith(".jsonl"):
            continue
        with open(os.path.join(path, name), encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError as e:
                    problems.append("%s:%d invalid JSON (%s)" % (name, n, e))
                    continue
                for p in validate_record(rec):
                    problems.append("%s:%d %s" % (name, n, p))
                key = (rec.get("run_id"), rec.get("role"))
                if owner.setdefault(key, name) != name:
                    d = runs.setdefault(key[0], {}).setdefault("_dups", [])
                    if (key[1], name) not in d:
                        d.append((key[1], name))
                        problems.append("%s: duplicate %s file for run %s (first seen in %s); not merged" % (name, key[1], key[0], owner[key]))
                    continue
                runs.setdefault(key[0], {}).setdefault(key[1], []).append(rec)
    return runs, problems


def percentile(sorted_vals, p):
    """Nearest-rank percentile of an already sorted list."""
    if not sorted_vals:
        return None
    k = max(1, int(math.ceil(p / 100.0 * len(sorted_vals))))
    return sorted_vals[k - 1]


def _one(recs, typ):
    for r in recs:
        if r["type"] == typ:
            return r
    return None


def analyse_run(run_id, by_role):
    """Metrics for one run. Needs both roles; otherwise returns an 'incomplete' row."""
    tx, rx = by_role.get("sender"), by_role.get("receiver")
    row = {"run_id": run_id, "complete": bool(tx and rx)}
    if by_role.get("_dups"):
        row.update(complete=False, valid=False, failure_class="CONFIGURATION",
                   notes="duplicate result files for %s: not merged; remove stale files and re-pull" % ", ".join("%s(%s)" % d for d in by_role["_dups"]))
        return row
    if not (tx and rx):
        row.update(valid=False, failure_class="CONFIGURATION", notes="missing %s file" % ("sender" if not tx else "receiver"))
        return row
    start, tx_end, rx_end = _one(tx, "run_start"), _one(tx, "run_end"), _one(rx, "run_end")
    if not (start and tx_end and rx_end):
        row.update(valid=False, failure_class="IMPLEMENTATION", notes="run_start/run_end missing (run did not finish writing)")
        return row
    sc, th = start["scenario"], start["thresholds"]
    rx_start = _one(rx, "run_start") or {}
    policy = sc.get("window_release")
    config_problems = []
    # the scenario id and the recorded policy must agree, and both phones must have run the same policy
    if policy is None:
        config_problems.append("run_start has no window_release: cannot tell which window policy produced this run")
    elif sc["id"].endswith("-ack") != (policy == "ACCEPTED"):
        config_problems.append("scenario id %s does not match its recorded window_release %s" % (sc["id"], policy))
    if rx_start.get("scenario", {}).get("window_release", policy) != policy:
        config_problems.append("sender ran window_release=%s but receiver ran %s" % (policy, rx_start["scenario"]["window_release"]))
    frames_tx = [r for r in tx if r["type"] == "frame_tx"]
    frames_rx = [r for r in rx if r["type"] == "frame_rx"]
    rx_by_seq = {r["seq"]: r for r in frames_rx}

    # --- reconcile: every generated frame lands in exactly one terminal bucket -------------------------------------
    b = dict(dropped_pre=0, received_intact=0, received_corrupt=0, lost_accepted=0, lost_rejected=0, lost_unresolved_submit=0,
             received_despite_rejected=0, received_despite_failed_transfer=0, received_from_dropped=0)
    c = dict(generated=len(frames_tx), accepted=0, rejected=0, unresolved_submit=0, transfer_success=0, transfer_failed=0,
             accepted_failed_transfer=0, accepted_no_transfer_report=0)
    drops = {}
    for t in frames_tx:
        r = rx_by_seq.get(t["seq"])
        s = t["submit"]
        if s in ("DROPPED", "QUEUED"):
            b["dropped_pre"] += 1
            drops[t["drop"]] = drops.get(t["drop"], 0) + 1
            if r is not None:
                b["received_from_dropped"] += 1
            continue
        c["accepted"] += s == "ACCEPTED"
        c["rejected"] += s == "REJECTED"
        c["unresolved_submit"] += s in ("UNRESOLVED_SUBMIT", "PENDING")
        c["transfer_success"] += t["transfer"] == "SUCCESS"
        c["transfer_failed"] += t["transfer"] == "FAILED"
        if s == "ACCEPTED":
            c["accepted_failed_transfer"] += t["transfer"] == "FAILED"
            c["accepted_no_transfer_report"] += t["transfer"] == "NONE"
        if r is not None:
            b["received_corrupt" if r["cls"] == "CORRUPT_PAYLOAD" else "received_intact"] += 1
            b["received_despite_rejected"] += s == "REJECTED"
            b["received_despite_failed_transfer"] += t["transfer"] == "FAILED"
        elif s == "ACCEPTED":
            b["lost_accepted"] += 1
        elif s == "REJECTED":
            b["lost_rejected"] += 1
        else:
            b["lost_unresolved_submit"] += 1
    known = {t["seq"] for t in frames_tx}
    b["received_unknown_seq"] = sum(1 for s in rx_by_seq if s not in known)
    terminal = sum(b[k] for k in ("dropped_pre", "received_intact", "received_corrupt", "lost_accepted", "lost_rejected", "lost_unresolved_submit"))
    violations = []
    if terminal != c["generated"]:
        violations.append("X1 terminal buckets %d != generated %d" % (terminal, c["generated"]))
    if b["received_unknown_seq"]:
        violations.append("X2 receiver saw %d unknown seqs" % b["received_unknown_seq"])
    if b["received_from_dropped"]:
        violations.append("X3 receiver saw %d frames recorded as dropped" % b["received_from_dropped"])
    # cross-check against the counts each phone wrote itself
    if tx_end["counts"]["generated"] != c["generated"] or tx_end["counts"]["submission_accepted"] != c["accepted"]:
        violations.append("X4 sender run_end counts disagree with frame_tx lines")
    if rx_end["counts"]["received_distinct"] != len(frames_rx):
        violations.append("X5 receiver run_end count disagrees with frame_rx lines")
    violations += ["sender: " + v for v in tx_end["invariants"]] + ["receiver: " + v for v in rx_end["invariants"]]

    classes = {}
    for r in frames_rx:
        classes[r["cls"]] = classes.get(r["cls"], 0) + 1
    intact = [r for r in frames_rx if r["cls"] != "CORRUPT_PAYLOAD"]
    lats = sorted(r["latency_ms"] for r in intact if r["latency_ms"] is not None)
    unc = sorted(r["uncertainty_ms"] for r in intact if r["uncertainty_ms"] is not None)
    dur = sc["duration_s"]
    stalls = rx_end["stalls"]["count"]
    stalls_120 = stalls * 120.0 / dur

    # --- derived metrics with explicit denominators ---------------------------------------------------------------
    gen, acc = c["generated"], c["accepted"]
    submitted = acc + c["rejected"] + c["unresolved_submit"]
    n_intact = b["received_intact"]
    n_on_time, n_late, n_unc, n_uncl = classes.get("ON_TIME", 0), classes.get("LATE", 0), classes.get("UNCERTAIN", 0), classes.get("UNCLASSIFIED", 0)
    missing_submitted = b["lost_accepted"] + b["lost_rejected"] + b["lost_unresolved_submit"]

    def frac(n, d):
        return (n / d) if d else None

    m = dict(
        accepted_of_generated=frac(acc, gen), pre_submission_drop_of_generated=frac(b["dropped_pre"], gen),
        intact_of_generated=frac(n_intact, gen), on_time_of_generated=frac(n_on_time, gen), on_time_of_submitted=frac(n_on_time, submitted),
        late_of_received_intact=frac(n_late, n_intact), uncertain_of_generated=frac(n_unc, gen), unclassified_of_generated=frac(n_uncl, gen),
        missing_submitted_of_submitted=frac(missing_submitted, submitted),
        transfer_failed_of_accepted=frac(c["accepted_failed_transfer"], acc),
        corrupt_of_received_distinct=frac(classes.get("CORRUPT_PAYLOAD", 0), len(frames_rx)),
    )

    # --- proposal thresholds (read from the run itself) ------------------------------------------------------------
    misses = []

    def need(name, value, key, minimum):
        if value is None or value < th[key]:
            misses.append("%s %s < %s" % (name, "n/a" if value is None else "%.4f" % value, th[key]))

    if gen == 0:
        misses.append("no frames generated")
    elif sc["mode"] == "raw":
        need("accepted_of_generated", m["accepted_of_generated"], "accepted_of_generated_min", True)
        need("intact_of_generated", m["intact_of_generated"], "intact_of_generated_min", True)
    else:
        need("on_time_of_generated", m["on_time_of_generated"], "on_time_of_generated_min", True)
    if m["transfer_failed_of_accepted"] is not None and m["transfer_failed_of_accepted"] > th["transfer_failure_of_accepted_max"]:
        misses.append("transfer_failed_of_accepted %.4f > %.3f" % (m["transfer_failed_of_accepted"], th["transfer_failure_of_accepted_max"]))
    if not frames_rx:
        misses.append("no frames received")
    elif m["corrupt_of_received_distinct"] > th["corrupt_of_received_max"]:
        misses.append("corrupt_of_received_distinct %.4f > %.3f" % (m["corrupt_of_received_distinct"], th["corrupt_of_received_max"]))
    if stalls_120 > th["stalls_per_120s_max"]:
        misses.append("stalls_per_120s %.2f > %d" % (stalls_120, th["stalls_per_120s_max"]))

    # --- failure class: strongest of what each phone reported; thresholds only count on otherwise valid runs ----------
    fc = max((tx_end["verdict"]["failure_class"], rx_end["verdict"]["failure_class"]), key=lambda x: PRIORITY[x])
    if violations and PRIORITY[fc] < PRIORITY["IMPLEMENTATION"]:
        fc = "IMPLEMENTATION"
    if config_problems:
        fc = "CONFIGURATION"
    if fc == "NONE" and misses:
        fc = "TRANSPORT_LIMITATION"
    valid = fc not in INVALID_CLASSES
    notes = list(config_problems)
    if rx_end.get("unterminated"):
        notes.append("receiver never saw END frame: loss counts are lower bounds")
    if tx_end["status"] != "complete" or rx_end["status"] != "complete":
        notes.append("status sender=%s receiver=%s" % (tx_end["status"], rx_end["status"]))

    dev = start.get("device", {})
    rdev = rx_start.get("device", {})
    simulated = dev.get("simulated") is True or dev.get("model") == "jvm-test"
    # Reproducibility is judged on a NORMALISED delivery outcome (a fraction of generated frames), never on raw frame counts.
    if sc["mode"] == "rt":
        outcome_name, outcome = "on_time_of_generated", m["on_time_of_generated"]
    else:
        outcome_name, outcome = "intact_of_generated", m["intact_of_generated"]
    cbk = tx_end.get("callbacks", {})
    lat = tx_end.get("callback_latency_ms", {})
    row.update(
        simulated=simulated, device_model=dev.get("model"), window_release=policy,
        device_pair="%s>%s" % (dev.get("model"), rdev.get("model")),
        services_versions="%s|%s" % (dev.get("services_version"), rdev.get("services_version")),
        radios_sender=dev.get("radios"), radios_receiver=rdev.get("radios"),
        transfer_reports_of_accepted=frac(acc - c["accepted_no_transfer_report"], acc),  # accepted frames that got ANY transfer result status_sender=tx_end["status"], status_receiver=rx_end["status"],
        submitted=submitted, missing_submitted=missing_submitted, **m,
        callbacks_duplicate=cbk.get("duplicate"), callbacks_conflicting=cbk.get("conflicting"), inflight_timeouts=tx_end.get("inflight_timeouts"),
        ack_latency_p95_ms=lat.get("ack_p95"), transfer_latency_p95_ms=lat.get("transfer_p95"),
        scenario=sc["id"], repeats=sc["repeats"], mode=sc["mode"], encoded_kbps=sc["encoded_kbps"], run_index=start["run_index"], duration_s=dur,
        generated=gen, dropped_pre=b["dropped_pre"], dropped_by_code=drops, accepted=acc, rejected=c["rejected"],
        unresolved_submit=c["unresolved_submit"], transfer_success=c["transfer_success"], transfer_failed=c["transfer_failed"],
        accepted_no_transfer_report=c["accepted_no_transfer_report"],
        unresolved_at_termination=c["unresolved_submit"] + c["accepted_no_transfer_report"],
        received_distinct=len(frames_rx), received_intact=b["received_intact"], received_corrupt=b["received_corrupt"],
        on_time=classes.get("ON_TIME", 0), uncertain=classes.get("UNCERTAIN", 0), late=classes.get("LATE", 0),
        valid_no_deadline=classes.get("VALID", 0), unclassified=classes.get("UNCLASSIFIED", 0),
        never_received_accepted=b["lost_accepted"], lost_rejected=b["lost_rejected"], lost_unresolved_submit=b["lost_unresolved_submit"],
        received_despite_rejected=b["received_despite_rejected"], received_despite_failed_transfer=b["received_despite_failed_transfer"],
        latency_p50_ms=percentile(lats, 50), latency_p95_ms=percentile(lats, 95), latency_p99_ms=percentile(lats, 99),
        latency_max_ms=lats[-1] if lats else None, uncertainty_median_ms=percentile(unc, 50),
        stalls=stalls, stalls_per_120s=round(stalls_120, 3), stall_max_ms=rx_end["stalls"]["max_ms"],
        offered_app_bytes=tx_end["bytes"]["offered_app_bytes"], accepted_app_bytes=tx_end["bytes"]["accepted_app_bytes"],
        received_valid_app_bytes=rx_end["bytes"]["received_valid_app_bytes"],
        failure_class=fc, valid=valid, threshold_misses="; ".join(misses), reconciliation_violations="; ".join(violations),
        notes="; ".join(notes),
        # reproducibility input: a unit-free fraction in [0, 1] (see summarise_scenario)
        repro_metric_name=outcome_name, delivery_outcome=outcome, repro_cv_max=th.get("repro_cv_max"),
    )
    return row


def cv(values):
    """Coefficient of variation (sample stdev / mean). None if undefined."""
    if len(values) < 2:
        return None
    m = sum(values) / len(values)
    if m == 0:
        return None
    var = sum((x - m) ** 2 for x in values) / (len(values) - 1)
    return math.sqrt(var) / m


def summarise_scenario(scn, rows):
    """Outcome per the workshop's decision categories. Invalid runs never count as transport evidence.

    Reproducibility: repro_cv = sample standard deviation / mean of the per-run delivery_outcome, a unit-free fraction
    (on_time/generated for REALTIME, intact/generated for RAW). It is a RELATIVE spread, so a CV of 0.15 on outcomes near 0.95
    would permit differences of about 14 percentage points; repro_spread_pp (max - min, in percentage points) is reported next
    to it so that is visible. The threshold is the repro_cv_max recorded in the runs, never a literal in this script.

    Heterogeneous input is REJECTED, not merged: one outcome must come from one device pair, one Play services version
    pair, one window-release policy, one recorded threshold and one source (simulated or physical).
    """
    rows = [r for r in rows if r.get("complete")]
    valid = [r for r in rows if r["valid"]]
    invalid = [r for r in rows if not r["valid"]]
    meeting = [r for r in valid if r["failure_class"] == "NONE"]
    missing = [r for r in valid if r["failure_class"] == "TRANSPORT_LIMITATION"]
    repeats = rows[0].get("repeats", 5) if rows else 5
    values = [r["delivery_outcome"] for r in valid if r.get("delivery_outcome") is not None]
    c = cv(values) if len(values) >= 2 else None
    spread_pp = round((max(values) - min(values)) * 100, 3) if values else None
    sim_flags = {bool(r.get("simulated")) for r in rows}
    all_sim = sim_flags == {True}
    thresholds = {r.get("repro_cv_max") for r in rows}
    cv_max = next(iter(thresholds)) if len(thresholds) == 1 else None
    out = dict(scenario=scn, simulated=all_sim, runs=len(rows), valid_runs=len(valid), invalid_runs=len(invalid),
               runs_meeting_targets=len(meeting), runs_missing_targets=len(missing),
               repro_metric=(rows[0].get("repro_metric_name") if rows else None), repro_cv=None if c is None else round(c, 4),
               repro_cv_max=cv_max, repro_spread_pp=spread_pp,
               device_pair=",".join(sorted({str(r.get("device_pair")) for r in rows})),
               services_versions=",".join(sorted({str(r.get("services_versions")) for r in rows})),
               window_release=",".join(sorted({str(r.get("window_release")) for r in rows})))

    def distinct(key):
        return sorted({str(r.get(key)) for r in rows})

    mixed = None
    if len(sim_flags) > 1:
        mixed = "simulated and physical runs mixed in one scenario: separate them"
    elif len(distinct("window_release")) > 1:
        mixed = "different window-release policies %s: analyse each policy separately" % distinct("window_release")
    elif len(distinct("device_pair")) > 1:
        mixed = "different device pairs %s: analyse each pair separately (sender>receiver)" % distinct("device_pair")
    elif len(distinct("services_versions")) > 1:
        mixed = "different Google Play services versions %s: analyse each version separately" % distinct("services_versions")
    elif len(thresholds) > 1:
        mixed = "runs recorded different repro_cv_max values %s: they were produced under different acceptance proposals" % sorted(map(str, thresholds))

    if mixed:
        out["outcome"] = "INCONCLUSIVE (%s)" % mixed
    elif invalid:
        out["outcome"] = "INCONCLUSIVE (%d invalid run(s): %s)" % (len(invalid), ", ".join(sorted({r["failure_class"] for r in invalid})))
    elif len(valid) < repeats:
        out["outcome"] = "INCONCLUSIVE (only %d of %d repeats)" % (len(valid), repeats)
    elif len(missing) >= 3:
        out["outcome"] = "TARGETS_MISSED in %d of %d repeats (measured limitation under tested conditions)" % (len(missing), len(valid))
    elif len(meeting) == len(valid) and c is not None and cv_max is not None and c <= cv_max:
        out["outcome"] = "TARGETS_MET in all %d repeats (within tested conditions only)" % len(valid)
    else:
        out["outcome"] = "PROMISING_BUT_INCONCLUSIVE (%d of %d met targets; repro CV %s of %s vs recorded max %s)" % (
            len(meeting), len(valid), out["repro_cv"], out["repro_metric"], cv_max)
    if all_sim:
        out["outcome"] = "[SIMULATED - NOT NEARBY] " + out["outcome"]
    return out


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 2
    path, out_dir = argv[0], None
    if "--out" in argv:
        out_dir = argv[argv.index("--out") + 1]
    runs, problems = load_dir(path)
    rows = [analyse_run(rid, roles) for rid, roles in sorted(runs.items())]
    # Explicit grouping: one summary per (scenario id, device pair, Play services versions). Different pairs/versions/policies
    # are therefore never combined; summarise_scenario additionally rejects heterogeneous input handed to it directly.
    scen = {}
    for r in rows:
        if r.get("scenario"):
            scen.setdefault((r["scenario"], r.get("device_pair"), r.get("services_versions"), bool(r.get("simulated"))), []).append(r)
    summaries = []
    for (name, pair, services, _sim), rs in sorted(scen.items(), key=lambda kv: tuple(map(str, kv[0]))):
        sm = summarise_scenario(name, rs)
        summaries.append(sm)

    if any(r.get("simulated") for r in rows):
        print("*" * 78)
        print("*** SIMULATED DATA PRESENT: runs marked [SIM] come from the JVM fake link (device 'jvm-test').")
        print("*** They test the benchmark software only and say NOTHING about Nearby or any phone.")
        print("*" * 78)
    print("files with schema/JSON problems: %d" % len(problems))
    for p in problems[:20]:
        print("  SCHEMA:", p)

    def pct(v):
        return "n/a" if v is None else "%.3f" % v

    print("\n== runs (fractions: gen=of generated, sub=of submitted) ==")
    for r in rows:
        if not r.get("complete"):
            print("%-34s INCOMPLETE %s" % (r["run_id"], r.get("notes", "")))
            continue
        print("%-4s%-32s gen=%-5d dropPre=%-5d sub=%-5d acc=%-5d rcvIntact=%-5d onTime=%-5d unc=%-4d late=%-5d unclass=%-4d miss=%-4d | onTime/gen=%s onTime/sub=%s intact/gen=%s | p95=%s stalls=%s class=%s%s" % (
            "[SIM]" if r["simulated"] else "", r["run_id"], r["generated"], r["dropped_pre"], r["submitted"], r["accepted"], r["received_intact"],
            r["on_time"], r["uncertain"], r["late"], r["unclassified"], r["missing_submitted"],
            pct(r["on_time_of_generated"]), pct(r["on_time_of_submitted"]), pct(r["intact_of_generated"]),
            "n/a" if r["latency_p95_ms"] is None else "%.1f" % r["latency_p95_ms"], r["stalls"], r["failure_class"],
            "  !! " + r["reconciliation_violations"] if r["reconciliation_violations"] else ""))
    print("\n== scenarios (proposal thresholds; not requirements) ==")
    for s_ in summaries:
        print("%-22s [%s | services %s | window %s] valid=%d invalid=%d met=%d missed=%d cv=%s(max %s) spread=%spp  ->  %s" % (
            s_["scenario"], s_["device_pair"], s_["services_versions"], s_["window_release"], s_["valid_runs"], s_["invalid_runs"],
            s_["runs_meeting_targets"], s_["runs_missing_targets"], s_["repro_cv"], s_["repro_cv_max"], s_["repro_spread_pp"], s_["outcome"]))
    print("\nNote: thresholds are proposals recorded in each run. A result describes the tested devices/conditions only.")
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        _csv(os.path.join(out_dir, "summary_runs.csv"), [r for r in rows if r.get("complete")])
        _csv(os.path.join(out_dir, "summary_scenarios.csv"), summaries)
    return 1 if problems or any(r.get("reconciliation_violations") for r in rows) else 0


def _csv(path, rows):
    if not rows:
        return
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v, sort_keys=True) if isinstance(v, dict) else v) for k, v in r.items()})


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
