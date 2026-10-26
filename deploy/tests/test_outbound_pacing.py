import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("pacing", Path(__file__).resolve().parents[1] / "scripts/ensure-outbound-pacing.py")
pacing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pacing)


class PacingTests(unittest.TestCase):
    def setUp(self):
        self.rows = [{"id": "operator", "description": "Existing custom rule", "rate": {"count": 100, "period": 1000}}]
        self.calls = []
        self.backups = []

    def api(self, method, args):
        self.calls.append((method, args))
        if method == "x:MtaOutboundThrottle/get":
            return {"list": copy.deepcopy(self.rows)}
        if method == "x:MtaOutboundThrottle/set":
            for key, value in args.get("create", {}).items():
                self.rows.append({"id": key, **copy.deepcopy(value)})
            for key, value in args.get("update", {}).items():
                next(row for row in self.rows if row["id"] == key).update(copy.deepcopy(value))
        elif method != "x:Action/set":
            self.fail("Unexpected operation: " + method)
        return {}

    def test_delivery_pacing_preserves_other_rules_and_never_touches_messages(self):
        before = copy.deepcopy(self.rows[0])
        result = pacing.reconcile(self.api, self.backups.append)
        self.assertTrue(result["configurationReadBackVerified"])
        self.assertEqual(self.rows[0], before)
        self.assertEqual(self.rows[1]["key"], {"mx": True})
        self.assertEqual(self.rows[1]["rate"], {"count": 20, "period": 60000})
        self.assertIn("source != 'dsn'", self.rows[1]["match"]["else"])
        self.assertFalse(result["messagesResubmitted"])
        self.assertEqual(len(self.backups), 1)

    def test_repeat_is_read_only_and_disable_keeps_the_rule_for_auditing(self):
        pacing.reconcile(self.api, self.backups.append)
        self.calls.clear()
        self.assertFalse(pacing.reconcile(self.api, self.backups.append)["changed"])
        self.assertEqual([method for method, _ in self.calls], ["x:MtaOutboundThrottle/get"])
        pacing.reconcile(self.api, self.backups.append, enabled=False)
        self.assertFalse(self.rows[1]["enable"])
        self.assertEqual(len(self.rows), 2)

    def test_dry_run_and_absent_disable_never_mutate(self):
        pacing.reconcile(self.api, self.backups.append, dry_run=True)
        pacing.reconcile(self.api, self.backups.append, enabled=False)
        self.assertFalse(self.backups)
        self.assertTrue(all(method.endswith("/get") for method, _ in self.calls))

    def test_duplicates_and_invalid_cadence_are_rejected(self):
        for value in [0, -1, 1000001, True]:
            with self.assertRaises(ValueError):
                pacing.reconcile(self.api, self.backups.append, count=value)
        self.rows.extend([{"id": "a", "description": pacing.MARKER}, {"id": "b", "description": pacing.MARKER}])
        with self.assertRaises(RuntimeError):
            pacing.reconcile(self.api, self.backups.append)
