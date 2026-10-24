import copy
import importlib.util
from pathlib import Path
import unittest
import json
import tempfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("orange", Path(__file__).resolve().parents[1] / "scripts/ensure-orange-delivery.py")
orange = importlib.util.module_from_spec(spec)
spec.loader.exec_module(orange)


class PolicyTests(unittest.TestCase):
    def test_real_backup_is_private_and_cannot_overwrite_existing_snapshot(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(orange.time, "time_ns", return_value=123):
            path = orange.write_backup(Path(directory), {"schedule": {"else": "'remote'"}})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), {"schedule": {"else": "'remote'"}})
            with self.assertRaises(FileExistsError):
                orange.write_backup(Path(directory), {})

    def setUp(self):
        self.strategy = {"schedule": {"match": {"0": {"if": "rcpt_domain == 'example.org'", "then": "'remote'"},
                         "1": {"if": "is_local_domain(rcpt_domain)", "then": "'local'"}, "2": {"if": "source == 'dsn'", "then": "'dsn'"}}, "else": "'remote'"},
                         "route": {"else": "'mx-direct'"}, "tls": {"else": "'default'"}, "connection": {"else": "'default'"}}
        self.queues = [{"id": "remote-q", "name": "remote", "threadsPerNode": 50}]
        self.schedules = [{"id": "remote-s", "name": "remote", "queueId": "remote-q", "retry": {"@type": "Default"}, "expiry": {"@type": "Ttl", "expire": 259200000}, "notify": {"@type": "Default"}}]
        self.calls = []

    def api(self, method, args):
        self.calls.append((method, copy.deepcopy(args)))
        if method == "x:MtaOutboundStrategy/get":
            return {"list": [copy.deepcopy(self.strategy)]}
        for kind, rows in [("x:MtaVirtualQueue", self.queues), ("x:MtaDeliverySchedule", self.schedules)]:
            if method == kind + "/get":
                return {"list": copy.deepcopy(rows)}
            if method == kind + "/set":
                for key, value in args.get("create", {}).items():
                    row = {"id": "created-" + kind, **value}
                    rows.append(copy.deepcopy(row))
                    return {"created": {key: {"id": row["id"]}}}
                for identity, value in args.get("update", {}).items():
                    next(row for row in rows if row["id"] == identity).update(copy.deepcopy(value))
                return {}
        if method == "x:MtaOutboundStrategy/set":
            self.strategy.update(copy.deepcopy(args["update"]["singleton"]))
        return {}

    def test_preserves_routes_retry_tls_and_control_message_policies(self):
        before = copy.deepcopy(self.strategy)
        result = orange.reconcile(self.api, lambda value: None)
        self.assertTrue(result["configurationReadBackVerified"])
        self.assertEqual(self.queues[-1]["threadsPerNode"], 2)
        for key in ["route", "tls", "connection"]:
            self.assertEqual(self.strategy[key], before[key])
        for key in ["retry", "expiry", "notify"]:
            self.assertEqual(self.schedules[-1][key], self.schedules[0][key])
        self.assertEqual(list(self.strategy["schedule"]["match"].values())[1:], list(before["schedule"]["match"].values()))
        self.assertIn("source != 'dsn'", self.strategy["schedule"]["match"]["0"]["if"])

    def test_second_run_is_idempotent_and_disable_keeps_queues_for_drainage(self):
        orange.reconcile(self.api, lambda value: None)
        self.calls.clear()
        self.assertFalse(orange.reconcile(self.api, lambda value: self.fail("unexpected backup"))["changed"])
        self.assertTrue(all(method.endswith("/get") for method, _ in self.calls))
        orange.reconcile(self.api, lambda value: None, enabled=False)
        self.assertFalse(any(rule["if"] == orange.CONDITION for rule in self.strategy["schedule"]["match"].values()))
        self.assertEqual(len(self.queues), 2)

    def test_dry_run_never_changes_configuration(self):
        self.assertTrue(orange.reconcile(self.api, lambda value: self.fail("unexpected backup"), dry_run=True)["changed"])
        self.assertTrue(all(method.endswith("/get") for method, _ in self.calls))

    def test_disable_removes_only_owned_rule_after_custom_policy_changes(self):
        orange.reconcile(self.api, lambda value: None)
        self.strategy["schedule"]["else"] = "'custom-priority'"
        self.strategy["schedule"]["match"]["9"] = {"if": "retry_num > 2", "then": "'custom-retry'"}
        orange.reconcile(self.api, lambda value: None, enabled=False)
        self.assertEqual(self.strategy["schedule"]["else"], "'custom-priority'")
        self.assertIn({"if": "retry_num > 2", "then": "'custom-retry'"}, self.strategy["schedule"]["match"].values())

    def test_refuses_unmanaged_names_custom_schedules_and_provider_rules(self):
        self.queues.append({"id": "private", "name": orange.NAME})
        with self.assertRaises(RuntimeError):
            orange.reconcile(self.api, lambda value: None)
        for expression in [{"else": "'priority'"}, {"else": "'remote'", "match": {"0": {"if": "rcpt_domain == 'orange.fr'", "then": "'custom'"}}}]:
            with self.assertRaises(RuntimeError):
                orange.schedule_expression(expression, True)

    def test_concurrent_operator_change_is_not_overwritten(self):
        reads = 0
        def api(method, args):
            nonlocal reads
            if method == "x:MtaOutboundStrategy/get":
                reads += 1
                if reads == 2:
                    self.strategy["schedule"]["else"] = "'operator-custom'"
            return self.api(method, args)
        with self.assertRaisesRegex(RuntimeError, "concurrently"):
            orange.reconcile(api, lambda value: None)
        self.assertEqual(self.strategy["schedule"]["else"], "'operator-custom'")
        self.assertFalse(any(method == "x:MtaOutboundStrategy/set" for method, _ in self.calls))


if __name__ == "__main__":
    unittest.main()
