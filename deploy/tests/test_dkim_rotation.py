import copy
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("rotation", Path(__file__).parents[1] / "scripts/rotate-dkim-ovh.py")
r = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(r)
NOW = 1792060000


def key(ident="old", stage="active", algorithm="Dkim1RsaSha256", selector="v1-rsa-20261015"):
    return {"id": ident, "domainId": "i", "@type": algorithm, "selector": selector, "publicKey": ident + "-public", "stage": stage, "createdAt": r.iso(NOW - 100)}


class Server:
    domain_id = "i"
    def __init__(self):
        self.rows = [key(), key("ed", "retired", "Dkim1Ed25519Sha256", "v1-ed25519-20261015")]
        self.fail_activation = False
        self.fail_retirement = False
        self.events = []
    def keys(self): return copy.deepcopy(self.rows)
    def create_pending(self, now):
        new = key("new", "pending", selector="framm-rsa-new")
        new["createdAt"] = r.iso(now)
        self.rows.append(new)
        return copy.deepcopy(new)
    def stage(self, item, stage):
        if stage == "active" and self.fail_activation: raise RuntimeError("activation unavailable")
        if stage == "retiring" and self.fail_retirement: raise RuntimeError("retirement unavailable")
        self.events.append((item["id"], stage))
        next(k for k in self.rows if k["id"] == item["id"])["stage"] = stage


class Dns:
    def __init__(self, server):
        self.server = server
        self.propagated = True
        self.fail_publication = False
        self.removed = []
    def verify(self, item): return item["id"] != "new" or self.propagated
    def publish(self, item):
        assert next(k for k in self.server.rows if k["id"] == "old")["stage"] == "active"
        if self.fail_publication: raise RuntimeError("OVH unavailable")
    def remove(self, item): self.removed.append(item["id"])


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.server = Server(); self.dns = Dns(self.server); self.state = {}; self.saved = []
        self.clock = NOW
        self.job = r.Coordinator(self.server, self.dns, self.state, lambda data: self.saved.append(copy.deepcopy(data)), lambda: self.clock)
    def stage(self, ident): return next(k for k in self.server.rows if k["id"] == ident)["stage"]
    def test_idle_preserves_current_key_and_ed25519(self):
        self.job.run()
        self.assertEqual(len(self.server.rows), 2)
        self.assertEqual(self.stage("old"), "active")
        self.assertEqual(self.stage("ed"), "retired")
    def test_publication_failure_never_retires_current_key(self):
        self.dns.fail_publication = True
        with self.assertRaisesRegex(RuntimeError, "OVH"): self.job.run("exercise")
        self.assertEqual(self.stage("old"), "active")
        self.assertEqual(self.stage("new"), "pending")
    def test_propagation_failure_never_activates_new_key(self):
        self.dns.propagated = False
        self.job.run("exercise")
        self.assertEqual(self.stage("old"), "active")
        self.assertEqual(self.stage("new"), "pending")
        self.assertEqual(self.state["phase"], "waiting_for_dns")
        self.dns.propagated = True
        self.job.run("exercise")
        self.assertEqual(self.stage("new"), "active")
    def test_activation_failure_preserves_old_signer(self):
        self.server.fail_activation = True
        with self.assertRaises(RuntimeError): self.job.run("exercise")
        self.assertEqual(self.stage("old"), "active")
        self.assertNotIn(("old", "retiring"), self.server.events)
    def test_cutover_order_and_idempotent_operation(self):
        self.job.run("exercise")
        self.assertEqual(self.server.events, [("new", "active"), ("old", "retiring")])
        self.job.run("exercise")
        self.assertEqual(len(self.server.rows), 3)
        self.assertEqual(self.dns.removed, [])
    def test_partial_cutover_reconciles_two_valid_signers(self):
        self.server.fail_retirement = True
        with self.assertRaises(RuntimeError): self.job.run("exercise")
        self.assertEqual(self.stage("new"), "active")
        self.assertEqual(self.stage("old"), "active")
        self.server.fail_retirement = False
        self.job.run("exercise")
        self.assertEqual(self.stage("old"), "retiring")
        self.assertEqual(len(self.server.rows), 3)
    def test_cleanup_waits_thirty_days_and_keeps_ed25519(self):
        self.job.run("exercise")
        self.clock += r.RETAIN_DNS - 1
        self.job.run()
        self.assertEqual(self.dns.removed, [])
        self.clock += 2
        self.job.run()
        self.assertEqual(self.dns.removed, ["old"])
        self.assertEqual(self.stage("old"), "retired")
        self.assertEqual(self.stage("ed"), "retired")
    def test_cleanup_requires_valid_replacement_dns(self):
        self.job.run("exercise")
        self.clock += r.RETAIN_DNS + 1
        self.dns.propagated = False
        with self.assertRaises(RuntimeError): self.job.run()
        self.assertEqual(self.dns.removed, [])
    def test_scope_and_conflict_guards(self):
        for selector in ["../root", "selector._domainkey", "", "x" * 64]:
            with self.assertRaises(RuntimeError): r.relative(selector)
        self.assertEqual(r.relative("framm-rsa-test"), "framm-rsa-test._domainkey.mail")
        with self.assertRaises(RuntimeError): r.material("v=DKIM1; k=ed25519; p=x")
        with self.assertRaises(RuntimeError): r.material("v=DKIM1; p=x; p=y")

    def test_provider_refuses_conflict_and_duplicate_records(self):
        provider = object.__new__(r.Ovh)
        for rows in [
            [{"id": 1, "subDomain": "v1-rsa-20261015._domainkey.mail", "fieldType": "TXT", "target": '"v=DKIM1; k=rsa; p=wrong"'}],
            [{"id": 1, "subDomain": "selector1._domainkey", "fieldType": "TXT", "target": '"v=DKIM1; k=rsa; p=old-public"'}],
        ]:
            provider.call = lambda method, path, body=None: [1] if "?" in path else rows[0]
            with self.assertRaises(RuntimeError): provider.records(key())
    def test_provider_reassembles_split_txt_without_touching_apex(self):
        provider = object.__new__(r.Ovh)
        calls = []
        def call(method, path, body=None):
            calls.append((method, path, body))
            return [1] if "?" in path else {"id": 1, "subDomain": "v1-rsa-20261015._domainkey.mail", "fieldType": "TXT", "target": '\"v=DKIM1; k=rsa; p=old-\" \"public\"'}
        provider.call = call
        provider.publish(key())
        self.assertFalse(any(method in ["DELETE", "PUT"] for method, _, _ in calls))
        self.assertTrue(all(path.startswith("/domain/zone/d2-group.fr/") for _, path, _ in calls))


if __name__ == "__main__": unittest.main()
