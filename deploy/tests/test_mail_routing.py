import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("mail_routing", Path(__file__).parents[1] / "scripts/ensure-mail-routing.py")
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)


class MailRoutingTests(unittest.TestCase):
    def test_external_mx_overrides_local_sender_domain_without_changing_hosted_mail(self):
        mx = {"sender.example": ["google.example"], "hosted.example": ["mail.kod.example"]}
        ips = {"google.example": {"192.0.2.2"}, "mail.kod.example": {"192.0.2.1"}}
        self.assertEqual(routing.external_domains(mx, {"192.0.2.1"}, [], mx.__getitem__, ips.__getitem__), ["sender.example"])

    def test_dns_failure_never_becomes_a_local_route(self):
        def unavailable(domain):
            raise RuntimeError("DNS unavailable")
        with self.assertRaises(RuntimeError):
            routing.external_domains(["sender.example"], {"192.0.2.1"}, [], unavailable)
        self.assertEqual(routing.external_domains(["sender.example"], set(), ["sender.example"], lambda _: []), ["sender.example"])

    def test_unresolved_mixed_primary_mx_requires_review(self):
        with self.assertRaises(RuntimeError):
            routing.external_domains(["sender.example"], {"192.0.2.1"}, [], lambda _: ["local", "remote"], lambda h: {"192.0.2.1" if h == "local" else "192.0.2.2"})

    def test_idempotent_owned_override_preserves_custom_rules_and_default(self):
        original = {"match": {"0": {"if": "is_local_domain(rcpt_domain)", "then": "'local'"}}, "else": "'mx-direct'"}
        first = routing.prepend(original, None, routing.condition(["sender.example"]), "mx-direct")
        self.assertEqual(first["match"]["0"]["then"], "'mx-direct'")
        self.assertEqual(first["match"]["1"], original["match"]["0"])
        self.assertEqual(routing.prepend(first, None, routing.condition(["sender.example"]), "mx-direct"), first)
        self.assertEqual(routing.prepend(first, routing.condition(["sender.example"]), "", "mx-direct"), original)

    def test_reconcile_dry_run_cannot_change_server_and_preserves_tls(self):
        strategy = {"route": {"match": {}, "else": "'mx-direct'"}, "schedule": {"match": {}, "else": "'remote'"}, "tls": "keep"}
        calls = []
        def api(method, args):
            calls.append(method)
            rows = {"x:Domain/get": [{"name": "sender.example"}], "x:MtaRoute/get": [{"name": "mx-direct", "@type": "Mx"}], "x:MtaDeliverySchedule/get": [{"name": "remote"}], "x:MtaOutboundStrategy/get": [strategy]}
            return {"list": rows[method]}
        with patch.object(routing, "external_domains", return_value=["sender.example"]):
            routing.reconcile(api, {}, set(), True)
        self.assertFalse(any(method.endswith("/set") for method in calls))
        self.assertEqual(strategy["tls"], "keep")

    def test_expression_injection_is_rejected(self):
        with self.assertRaises(RuntimeError):
            routing.condition(["bad' || true"])


if __name__ == "__main__":
    unittest.main()
