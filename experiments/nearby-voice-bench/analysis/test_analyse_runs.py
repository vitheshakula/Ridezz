#!/usr/bin/env python3
"""Unit tests for analyse_runs.py using hand-built synthetic fixtures with hand-computed expectations.

Run:  python3 -I analysis/test_analyse_runs.py
Optional: BENCH_FIXTURE_DIR=<dir of Kotlin-written .jsonl> also checks the real writer's output.
"""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("analyse_runs", os.path.join(HERE, "analyse_runs.py"))
ar = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ar)

THRESH = {"version": "proposal-v2", "accepted_of_generated_min": 0.98, "intact_of_generated_min": 0.98, "on_time_of_generated_min": 0.95,
          "transfer_failure_of_accepted_max": 0.01, "corrupt_of_received_max": 0.001, "stalls_per_120s_max": 2, "repro_cv_max": 0.15,
          "is_requirement": False}


def rec(typ, run_id, role, **kw):
    d = {"v": 1, "type": typ, "run_id": run_id, "role": role, "t_ms": 0}
    d.update(kw)
    return d


def tx_frame(rid, seq, submit, drop=None, transfer="NONE"):
    return rec("frame_tx", rid, "sender", seq=seq, gen_ms=seq * 20, bytes=80, submit=submit, drop=drop, reject_code=None,
               transfer=transfer, transfer_before_ack=False, submit_ms=None, ack_ms=None, transfer_ms=None)


def rx_frame(rid, seq, cls, lat=30.0, unc=27.0):
    return rec("frame_rx", rid, "receiver", seq=seq, txms=seq * 20, rx_ms=seq * 20 + 30, cls=cls,
               latency_ms=None if cls == "CORRUPT_PAYLOAD" else lat, uncertainty_ms=None if cls == "CORRUPT_PAYLOAD" else unc, bytes=80)


def build_run(rid="e1-bytes-rt-24k-r0-x", mode="rt", kbps=24, dur=120, tx=(), rx=(), stalls=0, tx_class="NONE", rx_class="NONE",
              invariants_tx=(), invariants_rx=(), tx_status="complete", rx_status="complete", unterminated=False, run_index=0,
              simulated=False, release="TRANSFER_RESULT", models=("x", "x"), services=("1.0", "1.0"), thresh=None, rx_release=None):
    scen = {"id": "e1-bytes-%s-%dk%s" % (mode, kbps, "-ack" if release == "ACCEPTED" else ""), "mode": mode, "transport": "BYTES",
            "encoded_kbps": kbps, "duration_s": dur, "repeats": 5, "window_release": release}
    roles = {"sender": 0, "receiver": 1}

    def start(role):
        sc = dict(scen)
        if role == "receiver" and rx_release:
            sc["window_release"] = rx_release
        dev = {"model": "jvm-test" if simulated else models[roles[role]], "sdk": 1, "simulated": simulated, "services_version": services[roles[role]]}
        return rec("run_start", rid, role, scenario=sc, run_index=run_index, epoch=0, fingerprint=1, device=dev,
                   thresholds=thresh or THRESH, unavailable_metrics=[], wire_overhead_bytes=20)
    acc = sum(1 for f in tx if f["submit"] == "ACCEPTED")
    tx_end = rec("run_end", rid, "sender", status=tx_status,
                 counts={"generated": len(tx), "submission_accepted": acc}, bytes={"offered_app_bytes": 80 * len(tx), "accepted_app_bytes": 80 * acc},
                 invariants=list(invariants_tx), parser={}, probes={}, stalls={"count": 0, "max_ms": 0},
                 verdict={"failure_class": tx_class})
    rx_end = rec("run_end", rid, "receiver", status=rx_status, counts={"received_distinct": len(rx)},
                 bytes={"received_valid_app_bytes": 0}, invariants=list(invariants_rx), parser={}, probes={},
                 stalls={"count": stalls, "max_ms": 250 if stalls else 0}, verdict={"failure_class": rx_class}, unterminated=unterminated)
    return {"sender": [start("sender")] + list(tx) + [tx_end], "receiver": [start("receiver")] + list(rx) + [rx_end]}


class PercentileCv(unittest.TestCase):
    def test_nearest_rank(self):
        v = list(range(1, 101))
        self.assertEqual(ar.percentile(v, 50), 50)
        self.assertEqual(ar.percentile(v, 95), 95)
        self.assertEqual(ar.percentile(v, 99), 99)
        self.assertEqual(ar.percentile(v, 100), 100)
        self.assertEqual(ar.percentile([7], 99), 7)
        self.assertIsNone(ar.percentile([], 50))

    def test_nearest_rank_with_non_integral_rank_rounds_up(self):
        v = list(range(1, 11))                      # 10 values: p95 rank = ceil(9.5) = 10, p50 rank = 5, p51 rank = ceil(5.1) = 6
        self.assertEqual(ar.percentile(v, 95), 10)
        self.assertEqual(ar.percentile(v, 50), 5)
        self.assertEqual(ar.percentile(v, 51), 6)

    def test_cv(self):
        self.assertEqual(ar.cv([10, 10, 10]), 0.0)
        self.assertAlmostEqual(ar.cv([90, 100, 110]), 0.1, places=12)
        self.assertIsNone(ar.cv([5]))
        self.assertIsNone(ar.cv([0, 0, 0]))


class Reconciliation(unittest.TestCase):
    def test_hand_computed_buckets(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, 0, "DROPPED", "SRC_FULL")]
        tx += [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in (1, 2, 3, 4)]
        tx += [tx_frame(rid, 5, "ACCEPTED", transfer="FAILED"), tx_frame(rid, 6, "ACCEPTED", transfer="NONE")]
        tx += [tx_frame(rid, 7, "REJECTED"), tx_frame(rid, 8, "UNRESOLVED_SUBMIT"), tx_frame(rid, 9, "UNRESOLVED_SUBMIT")]
        rx = [rx_frame(rid, 1, "ON_TIME", 30), rx_frame(rid, 2, "LATE", 250), rx_frame(rid, 3, "UNCERTAIN", 190),
              rx_frame(rid, 4, "CORRUPT_PAYLOAD"), rx_frame(rid, 7, "ON_TIME", 31), rx_frame(rid, 9, "ON_TIME", 29)]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))
        self.assertEqual(r["generated"], 10)
        self.assertEqual(r["dropped_pre"], 1)
        self.assertEqual(r["accepted"], 6)
        self.assertEqual(r["rejected"], 1)
        self.assertEqual(r["unresolved_submit"], 2)
        self.assertEqual(r["accepted_no_transfer_report"], 1)
        self.assertEqual(r["unresolved_at_termination"], 3)
        self.assertEqual(r["received_intact"], 5)
        self.assertEqual(r["received_corrupt"], 1)
        self.assertEqual(r["never_received_accepted"], 2)           # accepted 1..6 minus received {1,2,3,4}
        self.assertEqual(r["lost_unresolved_submit"], 1)            # seq 8
        self.assertEqual(r["received_despite_rejected"], 1)         # seq 7
        self.assertEqual((r["on_time"], r["late"], r["uncertain"]), (3, 1, 1))
        self.assertEqual(r["reconciliation_violations"], "")
        terminal = (r["dropped_pre"] + r["received_intact"] + r["received_corrupt"] + r["never_received_accepted"]
                    + r["lost_rejected"] + r["lost_unresolved_submit"])
        self.assertEqual(terminal, r["generated"])

    def test_rejected_frame_that_never_arrives_is_lost_rejected_not_lost_accepted(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS"), tx_frame(rid, 1, "REJECTED"), tx_frame(rid, 2, "ACCEPTED", transfer="SUCCESS")]
        rx = [rx_frame(rid, 0, "ON_TIME")]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))
        self.assertEqual((r["lost_rejected"], r["never_received_accepted"], r["lost_unresolved_submit"]), (1, 1, 0))

    def test_latency_percentiles_use_intact_frames_only(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(5)]
        rx = [rx_frame(rid, 0, "ON_TIME", 10), rx_frame(rid, 1, "ON_TIME", 20), rx_frame(rid, 2, "ON_TIME", 30),
              rx_frame(rid, 3, "ON_TIME", 40), rx_frame(rid, 4, "CORRUPT_PAYLOAD")]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))
        self.assertEqual((r["latency_p50_ms"], r["latency_max_ms"]), (20, 40))

    def test_receiver_seeing_a_dropped_or_unknown_frame_is_an_implementation_problem(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, 0, "DROPPED", "SRC_FULL"), tx_frame(rid, 1, "ACCEPTED", transfer="SUCCESS")]
        rx = [rx_frame(rid, 0, "ON_TIME"), rx_frame(rid, 1, "ON_TIME"), rx_frame(rid, 77, "ON_TIME")]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))
        self.assertIn("X2", r["reconciliation_violations"])
        self.assertIn("X3", r["reconciliation_violations"])
        self.assertEqual(r["failure_class"], "IMPLEMENTATION")
        self.assertFalse(r["valid"])

    def test_disagreement_with_phones_own_counts_is_flagged(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(4)]
        rx = [rx_frame(rid, s, "ON_TIME") for s in range(4)]
        run = build_run(rid, tx=tx, rx=rx)
        run["receiver"][-1]["counts"]["received_distinct"] = 3
        r = ar.analyse_run(rid, run)
        self.assertIn("X5", r["reconciliation_violations"])

    def test_phone_reported_invariant_violations_are_surfaced(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")]
        run = build_run(rid, tx=tx, rx=[rx_frame(rid, 0, "ON_TIME")], invariants_tx=["I1: broken"])
        r = ar.analyse_run(rid, run)
        self.assertIn("sender: I1: broken", r["reconciliation_violations"])
        self.assertFalse(r["valid"])

    def test_missing_receiver_file_is_incomplete_configuration(self):
        rid = "e1-bytes-rt-24k-r0-x"
        r = ar.analyse_run(rid, {"sender": build_run(rid)["sender"]})
        self.assertFalse(r["complete"])
        self.assertEqual(r["failure_class"], "CONFIGURATION")


class Thresholds(unittest.TestCase):
    def _rt(self, on_time, total=100, stalls=0, dur=120, failed_transfers=0, corrupt=0):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="FAILED" if s < failed_transfers else "SUCCESS") for s in range(total)]
        rx = [rx_frame(rid, s, "ON_TIME" if s < on_time else "LATE", 30 if s < on_time else 300) for s in range(total) if s >= corrupt]
        rx += [rx_frame(rid, s, "CORRUPT_PAYLOAD") for s in range(corrupt)]
        return ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx, stalls=stalls, dur=dur))

    def test_on_time_fraction_boundary(self):
        self.assertEqual(self._rt(95)["failure_class"], "NONE")                 # exactly 0.95 passes
        r = self._rt(94)
        self.assertEqual(r["failure_class"], "TRANSPORT_LIMITATION")
        self.assertIn("on_time_of_generated", r["threshold_misses"])
        self.assertTrue(r["valid"], "a threshold miss on an otherwise clean run is a valid (negative) measurement")

    def test_transfer_failure_boundary(self):
        self.assertEqual(self._rt(100, total=100, failed_transfers=1)["failure_class"], "NONE")   # 0.01 passes
        self.assertEqual(self._rt(100, total=100, failed_transfers=2)["failure_class"], "TRANSPORT_LIMITATION")

    def test_corrupt_fraction(self):
        r = self._rt(99, total=100, corrupt=1)
        self.assertIn("corrupt_of_received_distinct", r["threshold_misses"])

    def test_stalls_scaled_to_120_seconds(self):
        self.assertEqual(self._rt(100, stalls=2, dur=120)["failure_class"], "NONE")
        r = self._rt(100, stalls=2, dur=60)
        self.assertAlmostEqual(r["stalls_per_120s"], 4.0)
        self.assertIn("stalls_per_120s", r["threshold_misses"])

    def test_raw_mode_uses_accepted_fraction_not_deadline(self):
        rid = "e1-bytes-raw-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED" if s < 97 else "DROPPED", None if s < 97 else "SRC_FULL", "SUCCESS" if s < 97 else "NONE") for s in range(100)]
        rx = [rx_frame(rid, s, "VALID", 500) for s in range(97)]
        r = ar.analyse_run(rid, build_run(rid, mode="raw", tx=tx, rx=rx))
        self.assertIn("accepted_of_generated 0.9700", r["threshold_misses"])
        self.assertIn("intact_of_generated 0.9700", r["threshold_misses"])
        tx2 = [tx_frame(rid, s, "ACCEPTED" if s < 98 else "DROPPED", None if s < 98 else "SRC_FULL", "SUCCESS" if s < 98 else "NONE") for s in range(100)]
        r2 = ar.analyse_run(rid, build_run(rid, mode="raw", tx=tx2, rx=[rx_frame(rid, s, "VALID", 500) for s in range(98)]))
        self.assertEqual(r2["failure_class"], "NONE", "RAW mode has no deadline: 500 ms latency alone is not a failure")

    def test_no_frames_received_is_a_miss(self):
        rid = "e1-bytes-rt-24k-r0-x"
        r = ar.analyse_run(rid, build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[]))
        self.assertIn("no frames received", r["threshold_misses"])

    def test_device_flag_outranks_threshold_miss_and_invalidates_run(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(100)]
        rx = [rx_frame(rid, s, "LATE", 400) for s in range(100)]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx, rx_class="DEVICE_DEPENDENT"))
        self.assertEqual(r["failure_class"], "DEVICE_DEPENDENT")
        self.assertFalse(r["valid"])

    def test_unterminated_receiver_is_noted(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=[rx_frame(rid, 0, "ON_TIME")], unterminated=True))
        self.assertIn("lower bounds", r["notes"])


class DenominatorsAndRealtimeSuccess(unittest.TestCase):
    """H4: real-time success is judged against GENERATED frames. Expected values are hand-computed."""

    def test_every_fraction_has_the_documented_denominator(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, s, "DROPPED", "SRC_FULL") for s in (0, 1)]
        tx += [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(2, 8)]
        tx += [tx_frame(rid, 8, "REJECTED"), tx_frame(rid, 9, "UNRESOLVED_SUBMIT")]
        rx = [rx_frame(rid, s, "ON_TIME") for s in (2, 3, 4, 5)] + [rx_frame(rid, 6, "LATE", 300), rx_frame(rid, 7, "UNCERTAIN", 190),
                                                                    rx_frame(rid, 8, "UNCLASSIFIED", None, None)]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))
        self.assertEqual((r["generated"], r["dropped_pre"], r["submitted"], r["accepted"]), (10, 2, 8, 6))
        self.assertEqual(r["received_intact"], 7)
        self.assertEqual(r["missing_submitted"], 1)                                   # only seq 9
        self.assertAlmostEqual(r["on_time_of_generated"], 4 / 10)
        self.assertAlmostEqual(r["on_time_of_submitted"], 4 / 8)
        self.assertAlmostEqual(r["intact_of_generated"], 7 / 10)
        self.assertAlmostEqual(r["late_of_received_intact"], 1 / 7)
        self.assertAlmostEqual(r["uncertain_of_generated"], 1 / 10)
        self.assertAlmostEqual(r["unclassified_of_generated"], 1 / 10)
        self.assertAlmostEqual(r["pre_submission_drop_of_generated"], 2 / 10)
        self.assertAlmostEqual(r["accepted_of_generated"], 6 / 10)
        self.assertAlmostEqual(r["missing_submitted_of_submitted"], 1 / 8)

    def test_missing_submitted_counts_accepted_rejected_and_unresolved_frames_that_never_arrived(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS"), tx_frame(rid, 1, "ACCEPTED", transfer="SUCCESS"),
              tx_frame(rid, 2, "REJECTED"), tx_frame(rid, 3, "UNRESOLVED_SUBMIT")]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=[rx_frame(rid, 0, "ON_TIME")]))
        self.assertEqual((r["submitted"], r["missing_submitted"]), (4, 3))
        self.assertAlmostEqual(r["missing_submitted_of_submitted"], 0.75)

    def test_corrupt_fraction_uses_received_distinct_not_generated_as_denominator(self):
        rid = "e1-bytes-raw-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(100)]
        rx = [rx_frame(rid, s, "CORRUPT_PAYLOAD") for s in range(5)] + [rx_frame(rid, s, "VALID", 40) for s in range(5, 50)]
        r = ar.analyse_run(rid, build_run(rid, mode="raw", tx=tx, rx=rx))
        self.assertAlmostEqual(r["corrupt_of_received_distinct"], 5 / 50)         # 0.10, not 5/100
        self.assertAlmostEqual(r["intact_of_generated"], 45 / 100)

    def _heavy_drop_run(self, rid, cls):
        tx = [tx_frame(rid, s, "DROPPED", "SRC_FULL") for s in range(5142)]
        tx += [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(5142, 6000)]
        rx = [rx_frame(rid, s, cls, 30 if cls == "ON_TIME" else 300) for s in range(5142, 6000)]
        return ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))

    def test_5142_of_6000_dropped_is_never_successful_realtime_delivery_even_if_every_submitted_frame_is_on_time(self):
        r = self._heavy_drop_run("e1-bytes-rt-24k-r0-x", "ON_TIME")
        self.assertEqual((r["generated"], r["dropped_pre"], r["accepted"], r["on_time"]), (6000, 5142, 858, 858))
        self.assertAlmostEqual(r["on_time_of_generated"], 858 / 6000)                 # 0.143
        self.assertEqual(r["on_time_of_submitted"], 1.0, "the OLD denominator would have called this a perfect run")
        self.assertGreaterEqual(r["on_time_of_submitted"], 0.95)
        self.assertIn("on_time_of_generated 0.1430 < 0.95", r["threshold_misses"])
        self.assertEqual(r["failure_class"], "TRANSPORT_LIMITATION")
        self.assertTrue(r["valid"])

    def test_5142_of_6000_with_all_submitted_frames_late_also_fails(self):
        r = self._heavy_drop_run("e1-bytes-rt-24k-r0-x", "LATE")
        self.assertEqual(r["on_time"], 0); self.assertEqual(r["late"], 858)
        self.assertEqual(r["failure_class"], "TRANSPORT_LIMITATION")

    def test_five_such_runs_are_a_missed_scenario_not_a_met_one(self):
        rows = [self._heavy_drop_run("e1-bytes-rt-24k-r%d-x" % i, "ON_TIME") for i in range(5)]
        for r in rows:
            r["repeats"] = 5
        out = ar.summarise_scenario("e1-bytes-rt-24k", rows)["outcome"]
        self.assertTrue(out.startswith("TARGETS_MISSED"), out)

    def test_raw_mode_silent_loss_is_caught_by_intact_over_generated(self):
        rid = "e1-bytes-raw-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="SUCCESS") for s in range(100)]       # platform accepted everything...
        rx = [rx_frame(rid, s, "VALID", 40) for s in range(60)]                            # ...but only 60 arrived
        r = ar.analyse_run(rid, build_run(rid, mode="raw", tx=tx, rx=rx))
        self.assertEqual(r["accepted_of_generated"], 1.0); self.assertAlmostEqual(r["intact_of_generated"], 0.6)
        self.assertEqual(r["failure_class"], "TRANSPORT_LIMITATION"); self.assertIn("intact_of_generated", r["threshold_misses"])


class ClassificationPassThrough(unittest.TestCase):
    def test_api_class_from_the_phones_beats_a_threshold_miss(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, s, "ACCEPTED", transfer="NONE") for s in range(100)]
        rx = [rx_frame(rid, s, "LATE", 400) for s in range(10)]
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx, tx_class="API"))
        self.assertEqual(r["failure_class"], "API"); self.assertFalse(r["valid"])
        self.assertTrue(r["threshold_misses"], "the miss is still reported, but it must not be called a transport limitation")
        r["repeats"] = 5
        self.assertTrue(ar.summarise_scenario("s", [r])["outcome"].startswith("INCONCLUSIVE"))

    def test_run_end_optional_callback_fields_are_schema_valid_and_surface_in_the_row(self):
        rid = "e1-bytes-rt-24k-r0-x"
        run = build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")])
        end = run["sender"][-1]
        end.update(callbacks={"duplicate": 3, "conflicting": 1}, callback_latency_ms={"ack_p95": 12, "transfer_p95": 40}, inflight_timeouts=2, peer_done_ack=True, peer_lost=False)
        self.assertEqual(ar.validate_record(end), [])
        r = ar.analyse_run(rid, run)
        self.assertEqual((r["callbacks_duplicate"], r["callbacks_conflicting"], r["inflight_timeouts"]), (3, 1, 2))
        self.assertEqual((r["ack_latency_p95_ms"], r["transfer_latency_p95_ms"]), (12, 40))


class SimulatedAndDuplicates(unittest.TestCase):
    def _row(self, simulated):
        rid = "e1-bytes-rt-24k-r0-x"
        r = ar.analyse_run(rid, build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")], simulated=simulated))
        r["repeats"] = 1
        return r

    def test_simulated_runs_are_identified_and_labelled(self):
        r = self._row(True)
        self.assertTrue(r["simulated"]); self.assertEqual(r["device_model"], "jvm-test")
        self.assertTrue(ar.summarise_scenario("s", [r])["outcome"].startswith("[SIMULATED - NOT NEARBY]"))
        self.assertFalse(self._row(False)["simulated"])
        self.assertFalse(ar.summarise_scenario("s", [self._row(False)])["outcome"].startswith("[SIM"))

    def test_simulated_and_physical_runs_never_share_an_outcome(self):
        out = ar.summarise_scenario("s", [self._row(True), self._row(False)])["outcome"]
        self.assertTrue(out.startswith("INCONCLUSIVE") and "mixed" in out, out)

    def test_two_files_for_the_same_run_and_role_are_not_merged(self):
        with tempfile.TemporaryDirectory() as d:
            rid = "e1-bytes-rt-24k-r0-x"
            run = build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")])
            for fname, role in (("a.sender.jsonl", "sender"), ("b.receiver.jsonl", "receiver"), ("c.sender.jsonl", "sender")):
                with open(os.path.join(d, fname), "w") as fh:
                    fh.write("\n".join(json.dumps(r) for r in run[role]) + "\n")
            runs, problems = ar.load_dir(d)
            self.assertTrue(any("duplicate sender file" in p for p in problems))
            self.assertEqual(len(runs[rid]["sender"]), len(run["sender"]), "first file kept, duplicate not appended")
            r = ar.analyse_run(rid, runs[rid])
            self.assertFalse(r["complete"]); self.assertEqual(r["failure_class"], "CONFIGURATION"); self.assertIn("not merged", r["notes"])


def _simple_run(rid, n, delivered, **kw):
    """n frames, all accepted with a transfer result; the first `delivered` arrive on time."""
    tx = [tx_frame(rid, i, "ACCEPTED", transfer="SUCCESS") for i in range(n)]
    rx = [rx_frame(rid, i, "ON_TIME") for i in range(delivered)]
    return ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx, **kw))


class WindowPolicySeparation(unittest.TestCase):
    """Finding 2: the two window-release policies are distinct experiments."""

    def test_id_and_recorded_policy_must_agree(self):
        rid = "e1-bytes-rt-24k-ack-r0-x"
        ok = _simple_run(rid, 10, 10, release="ACCEPTED")
        self.assertEqual((ok["scenario"], ok["window_release"], ok["failure_class"]), ("e1-bytes-rt-24k-ack", "ACCEPTED", "NONE"))
        # an id WITHOUT the suffix that claims ACCEPTED, and an -ack id that claims TRANSFER_RESULT, are both rejected
        tx = [tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")]; rx = [rx_frame(rid, 0, "ON_TIME")]
        run = build_run(rid, tx=tx, rx=rx, release="ACCEPTED")
        run["sender"][0]["scenario"]["window_release"] = "TRANSFER_RESULT"
        run["receiver"][0]["scenario"]["window_release"] = "TRANSFER_RESULT"
        r = ar.analyse_run(rid, run)
        self.assertEqual(r["failure_class"], "CONFIGURATION"); self.assertIn("does not match its recorded window_release", r["notes"])
        run2 = build_run("e1-bytes-rt-24k-r0-x", tx=tx, rx=rx)
        for role in ("sender", "receiver"):
            run2[role][0]["scenario"]["window_release"] = "ACCEPTED"
        self.assertEqual(ar.analyse_run("e1-bytes-rt-24k-r0-x", run2)["failure_class"], "CONFIGURATION")

    def test_phones_that_ran_different_policies_are_rejected(self):
        r = _simple_run("e1-bytes-rt-24k-r0-x", 5, 5, rx_release="ACCEPTED")
        self.assertEqual(r["failure_class"], "CONFIGURATION"); self.assertIn("sender ran window_release=TRANSFER_RESULT but receiver ran ACCEPTED", r["notes"])

    def test_missing_policy_field_is_rejected_not_defaulted(self):
        rid = "e1-bytes-rt-24k-r0-x"
        run = build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")])
        del run["sender"][0]["scenario"]["window_release"]; del run["receiver"][0]["scenario"]["window_release"]
        r = ar.analyse_run(rid, run)
        self.assertEqual(r["failure_class"], "CONFIGURATION"); self.assertIn("no window_release", r["notes"])

    def test_policies_cannot_be_combined_in_one_outcome(self):
        a = dict(TestRows.row("NONE"), window_release="TRANSFER_RESULT"); b = dict(TestRows.row("NONE"), window_release="ACCEPTED")
        out = ar.summarise_scenario("s", [a, b])["outcome"]
        self.assertTrue(out.startswith("INCONCLUSIVE") and "different window-release policies" in out and "ACCEPTED" in out, out)

    def test_acceptance_transfer_result_and_delivery_stay_separate_measurements(self):
        rid = "e1-bytes-raw-24k-ack-r0-x"
        tx = [tx_frame(rid, i, "ACCEPTED", transfer="NONE") for i in range(100)]            # platform accepted all, reported no transfer results
        rx = [rx_frame(rid, i, "VALID", 40) for i in range(60)]                             # the receiver confirms only 60
        r = ar.analyse_run(rid, build_run(rid, mode="raw", tx=tx, rx=rx, release="ACCEPTED"))
        self.assertEqual(r["accepted_of_generated"], 1.0)
        self.assertEqual(r["transfer_reports_of_accepted"], 0.0)
        self.assertAlmostEqual(r["intact_of_generated"], 0.6)
        self.assertEqual(r["failure_class"], "TRANSPORT_LIMITATION")                          # judged on RECEIVER-confirmed delivery


class TestRows:
    @staticmethod
    def row(cls, outcome=0.96, **kw):
        r = {"complete": True, "valid": cls not in ar.INVALID_CLASSES, "failure_class": cls, "delivery_outcome": outcome, "repeats": 5,
             "repro_cv_max": 0.15, "repro_metric_name": "on_time_of_generated", "device_pair": "A>B", "services_versions": "1|1",
             "window_release": "TRANSFER_RESULT", "simulated": False}
        r.update(kw)
        return r


class Reproducibility(unittest.TestCase):
    """Finding 3. Expected values are calculated here, independently of ar.cv."""

    OUTCOMES = (0.96, 0.97, 0.95, 0.98, 0.96)

    def test_independent_hand_calculation(self):
        mean = sum(self.OUTCOMES) / 5                                               # 0.964
        sd = (sum((x - mean) ** 2 for x in self.OUTCOMES) / 4) ** 0.5               # 0.0114018
        self.assertAlmostEqual(mean, 0.964); self.assertAlmostEqual(sd / mean, 0.0118275, places=6)   # sum sq dev 5.2e-4; /4 = 1.3e-4; sd 0.0114018; /0.964
        out = ar.summarise_scenario("s", [TestRows.row("NONE", v) for v in self.OUTCOMES])
        self.assertAlmostEqual(out["repro_cv"], round(sd / mean, 4), places=4)
        self.assertEqual(out["repro_metric"], "on_time_of_generated")

    def test_threshold_comes_from_the_recorded_configuration_not_a_literal(self):
        rows = lambda cvmax: [TestRows.row("NONE", v, repro_cv_max=cvmax) for v in self.OUTCOMES]    # CV is 0.01183
        self.assertTrue(ar.summarise_scenario("s", rows(0.02))["outcome"].startswith("TARGETS_MET"))
        tight = ar.summarise_scenario("s", rows(0.01))
        self.assertTrue(tight["outcome"].startswith("PROMISING_BUT_INCONCLUSIVE"), tight["outcome"])
        self.assertEqual(tight["repro_cv_max"], 0.01); self.assertIn("recorded max 0.01", tight["outcome"])
        loose = ar.summarise_scenario("s", [TestRows.row("NONE", v, repro_cv_max=0.5) for v in (0.95, 0.50, 0.99, 0.70, 0.85)])   # CV ~0.27
        self.assertTrue(loose["outcome"].startswith("TARGETS_MET"), "a larger recorded threshold must be honoured too")

    def test_runs_that_recorded_different_thresholds_are_not_combined(self):
        rows = [TestRows.row("NONE", 0.96, repro_cv_max=0.15)] * 4 + [TestRows.row("NONE", 0.96, repro_cv_max=0.05)]
        out = ar.summarise_scenario("s", rows)["outcome"]
        self.assertTrue(out.startswith("INCONCLUSIVE") and "different acceptance proposals" in out, out)

    def test_raw_frame_counts_would_have_failed_a_run_set_that_is_perfectly_consistent(self):
        # five runs of different length, each delivering exactly 96% on time
        lengths = (100, 50, 200, 100, 150)
        rows = [_simple_run("e1-bytes-rt-24k-r%d-x" % i, n, round(n * 0.96), run_index=i) for i, n in enumerate(lengths)]
        for r in rows:
            self.assertAlmostEqual(r["delivery_outcome"], 0.96); self.assertEqual(r["failure_class"], "NONE")
        counts = [round(n * 0.96) for n in lengths]                                  # 96, 48, 192, 96, 144
        import statistics
        raw_cv = statistics.stdev(counts) / statistics.mean(counts)                  # the OLD metric
        self.assertGreater(raw_cv, 0.15, "old metric would have rejected consistent runs")
        out = ar.summarise_scenario("e1-bytes-rt-24k", rows)
        self.assertEqual(out["repro_cv"], 0.0); self.assertTrue(out["outcome"].startswith("TARGETS_MET"), out["outcome"])

    def test_the_reproducibility_input_is_judged_against_generated_not_submitted_frames(self):
        rid = "e1-bytes-rt-24k-r0-x"
        tx = [tx_frame(rid, i, "DROPPED", "SRC_FULL") for i in range(20)] + [tx_frame(rid, i, "ACCEPTED", transfer="SUCCESS") for i in range(20, 100)]
        rx = [rx_frame(rid, i, "ON_TIME") for i in range(20, 96)]                    # 76 on time: 76/100 generated, 76/80 = 0.95 submitted
        r = ar.analyse_run(rid, build_run(rid, tx=tx, rx=rx))
        self.assertAlmostEqual(r["on_time_of_submitted"], 0.95)
        self.assertAlmostEqual(r["delivery_outcome"], 0.76)
        self.assertNotAlmostEqual(r["delivery_outcome"], r["on_time_of_submitted"])

    def test_raw_mode_uses_intact_over_generated_as_its_outcome(self):
        rid = "e1-bytes-raw-24k-r0-x"
        tx = [tx_frame(rid, i, "ACCEPTED", transfer="SUCCESS") for i in range(100)]
        r = ar.analyse_run(rid, build_run(rid, mode="raw", tx=tx, rx=[rx_frame(rid, i, "VALID", 40) for i in range(99)]))
        self.assertEqual(r["repro_metric_name"], "intact_of_generated"); self.assertAlmostEqual(r["delivery_outcome"], 0.99)
        self.assertEqual(r["repro_cv_max"], 0.15)

    def test_spread_in_percentage_points_is_reported_next_to_the_relative_cv(self):
        out = ar.summarise_scenario("s", [TestRows.row("NONE", v) for v in (0.99, 0.85, 0.99, 0.99, 0.99)])
        self.assertAlmostEqual(out["repro_spread_pp"], 14.0, places=6)               # (0.99 - 0.85) * 100


class DeviceAndServicesGrouping(unittest.TestCase):
    """Finding 5."""

    def test_device_pair_and_services_versions_are_recorded_per_run(self):
        r = _simple_run("e1-bytes-rt-24k-r0-x", 5, 5, models=("PhoneA", "PhoneB"), services=("25.10.1", "25.11.0"))
        self.assertEqual((r["device_pair"], r["services_versions"]), ("PhoneA>PhoneB", "25.10.1|25.11.0"))

    def test_different_device_pairs_are_rejected_with_an_actionable_message(self):
        rows = [TestRows.row("NONE", device_pair="A>B")] * 3 + [TestRows.row("NONE", device_pair="C>D")] * 2
        out = ar.summarise_scenario("s", rows)["outcome"]
        self.assertTrue(out.startswith("INCONCLUSIVE") and "different device pairs" in out and "A>B" in out and "C>D" in out and "separately" in out, out)

    def test_swapping_sender_and_receiver_is_a_different_pair(self):
        out = ar.summarise_scenario("s", [TestRows.row("NONE", device_pair="A>B"), TestRows.row("NONE", device_pair="B>A")])["outcome"]
        self.assertIn("different device pairs", out)

    def test_different_play_services_versions_are_rejected(self):
        rows = [TestRows.row("NONE", services_versions="25.10|25.10")] * 3 + [TestRows.row("NONE", services_versions="25.11|25.11")] * 2
        out = ar.summarise_scenario("s", rows)["outcome"]
        self.assertTrue(out.startswith("INCONCLUSIVE") and "Google Play services versions" in out and "25.11|25.11" in out, out)

    def test_an_unknown_services_version_is_its_own_group_not_a_wildcard(self):
        out = ar.summarise_scenario("s", [TestRows.row("NONE", services_versions="25.10|25.10"), TestRows.row("NONE", services_versions="None|None")])["outcome"]
        self.assertIn("Google Play services versions", out)

    def test_main_groups_explicitly_instead_of_merging(self):
        import contextlib, io
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as out_dir:
            for pair, services in ((("A", "B"), ("1", "1")), (("C", "D"), ("2", "2"))):
                for i in range(2):
                    rid = "e1-bytes-rt-24k-r%d-%s" % (i, pair[0])
                    run = build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")],
                                    models=pair, services=services, run_index=i)
                    for role, recs in run.items():
                        with open(os.path.join(d, "%s.%s.jsonl" % (rid, role)), "w") as fh:
                            fh.write("\n".join(json.dumps(r) for r in recs) + "\n")
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                ar.main([d, "--out", out_dir])
            text = buf.getvalue()
            self.assertIn("A>B", text); self.assertIn("C>D", text)
            self.assertNotIn("different device pairs", text, "main must group first, so nothing reaches the rejection path")
            with open(os.path.join(out_dir, "summary_scenarios.csv")) as fh:
                self.assertEqual(len(fh.readlines()) - 1, 2, "one summary row per (scenario, device pair, services)")


class ScenarioOutcomes(unittest.TestCase):
    def _row(self, cls, outcome=0.96, **kw):
        r = {"complete": True, "valid": cls not in ar.INVALID_CLASSES, "failure_class": cls, "delivery_outcome": outcome, "repeats": 5,
             "repro_cv_max": 0.15, "repro_metric_name": "on_time_of_generated", "device_pair": "A>B", "services_versions": "1|1",
             "window_release": "TRANSFER_RESULT", "simulated": False}
        r.update(kw)
        return r

    def test_all_met_with_low_cv(self):
        # outcomes are fractions of generated frames; hand-computed: mean 0.964, sample sd 0.011402, CV 0.011827
        s = ar.summarise_scenario("s", [self._row("NONE", v) for v in (0.96, 0.97, 0.95, 0.98, 0.96)])
        self.assertTrue(s["outcome"].startswith("TARGETS_MET"))
        self.assertAlmostEqual(s["repro_cv"], 0.0118, places=4)
        self.assertAlmostEqual(s["repro_spread_pp"], 3.0, places=6)               # (0.98 - 0.95) * 100

    def test_all_met_with_high_cv_is_only_promising(self):
        s = ar.summarise_scenario("s", [self._row("NONE", m) for m in (0.95, 0.50, 0.99, 0.70, 0.85)])
        self.assertTrue(s["outcome"].startswith("PROMISING_BUT_INCONCLUSIVE"))

    def test_three_of_five_missed_is_targets_missed(self):
        rows = [self._row("TRANSPORT_LIMITATION")] * 3 + [self._row("NONE")] * 2
        self.assertTrue(ar.summarise_scenario("s", rows)["outcome"].startswith("TARGETS_MISSED"))

    def test_two_of_five_missed_is_promising_not_failed(self):
        rows = [self._row("TRANSPORT_LIMITATION")] * 2 + [self._row("NONE")] * 3
        self.assertTrue(ar.summarise_scenario("s", rows)["outcome"].startswith("PROMISING"))

    def test_invalid_run_makes_scenario_inconclusive_not_failed(self):
        rows = [self._row("API")] + [self._row("TRANSPORT_LIMITATION")] * 4
        out = ar.summarise_scenario("s", rows)["outcome"]
        self.assertTrue(out.startswith("INCONCLUSIVE"), out)
        self.assertNotIn("MISSED", out)
        self.assertIn("1 invalid run(s): API", out, "must say WHY it is inconclusive, not just that it is")

    def test_fewer_than_repeats_is_inconclusive(self):
        self.assertTrue(ar.summarise_scenario("s", [self._row("NONE")] * 3)["outcome"].startswith("INCONCLUSIVE"))


class SchemaAndIo(unittest.TestCase):
    def test_location_setting_state_is_allowed_but_location_data_is_still_forbidden(self):
        base = rec("event", "r", "sender", name="n", detail="d")
        for v in (True, False, None):
            self.assertEqual(ar.validate_record(dict(base, name={"location_services": v})), [])
        self.assertTrue(ar.validate_record(dict(base, name={"location_services": "52.1,0.1"})))
        for k in ("location", "location_lat", "last_location", "location_services_lat", "latitude"):
            self.assertTrue(ar.validate_record(dict(base, name={k: 1})), k)

    def test_builder_records_are_schema_valid(self):
        rid = "e1-bytes-rt-24k-r0-x"
        run = build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")])
        for recs in run.values():
            for r in recs:
                self.assertEqual(ar.validate_record(r), [], r["type"])

    def test_schema_rejects_unknown_missing_and_forbidden(self):
        base = rec("event", "r", "sender", name="n", detail="d")
        self.assertEqual(ar.validate_record(base), [])
        self.assertTrue(ar.validate_record(dict(base, extra=1)))
        broken = dict(base)
        del broken["detail"]
        self.assertTrue(ar.validate_record(broken))
        self.assertTrue(ar.validate_record(dict(base, name={"device_serial": "x"})))
        self.assertTrue(ar.validate_record(dict(base, type="bogus")))
        self.assertTrue(ar.validate_record(dict(base, v=2)))

    def test_load_dir_reports_bad_json_and_groups_by_run(self):
        with tempfile.TemporaryDirectory() as d:
            rid = "e1-bytes-rt-24k-r0-x"
            run = build_run(rid, tx=[tx_frame(rid, 0, "ACCEPTED", transfer="SUCCESS")], rx=[rx_frame(rid, 0, "ON_TIME")])
            for role, recs in run.items():
                with open(os.path.join(d, role + ".jsonl"), "w") as fh:
                    fh.write("\n".join(json.dumps(r) for r in recs) + "\n")
            with open(os.path.join(d, "bad.jsonl"), "w") as fh:
                fh.write("{not json\n")
            runs, problems = ar.load_dir(d)
            self.assertEqual(set(runs[rid]), {"sender", "receiver"})
            self.assertEqual(len(problems), 1)
            self.assertIn("invalid JSON", problems[0])


@unittest.skipUnless(os.environ.get("BENCH_FIXTURE_DIR"), "set BENCH_FIXTURE_DIR to check Kotlin-written files")
class KotlinWriterCompatibility(unittest.TestCase):
    def test_real_recorder_output_is_schema_valid_and_reconciles(self):
        runs, problems = ar.load_dir(os.environ["BENCH_FIXTURE_DIR"])
        self.assertEqual(problems, [])
        self.assertGreater(len(runs), 0)
        for rid, roles in runs.items():
            r = ar.analyse_run(rid, roles)
            self.assertTrue(r["complete"], rid)
            self.assertEqual(r["reconciliation_violations"], "", rid)

    def test_kotlin_generated_heavy_drop_run_is_not_a_realtime_success(self):
        runs, _ = ar.load_dir(os.environ["BENCH_FIXTURE_DIR"])
        r = ar.analyse_run("e1-bytes-rt-30k-r0-drop", runs["e1-bytes-rt-30k-r0-drop"])
        self.assertTrue(r["simulated"])
        self.assertGreater(r["on_time_of_submitted"], 0.999)                      # the old, misleading denominator: perfect
        self.assertAlmostEqual(r["on_time_of_generated"], 2 / 3, delta=0.02)       # the honest one
        self.assertAlmostEqual(r["pre_submission_drop_of_generated"], 1 / 3, delta=0.02)
        self.assertEqual(r["failure_class"], "TRANSPORT_LIMITATION")
        self.assertIn("on_time_of_generated", r["threshold_misses"])

    def test_every_kotlin_fixture_run_is_marked_simulated(self):
        runs, _ = ar.load_dir(os.environ["BENCH_FIXTURE_DIR"])
        for rid, roles in runs.items():
            self.assertTrue(ar.analyse_run(rid, roles)["simulated"], rid)


if __name__ == "__main__":
    unittest.main(verbosity=1)
