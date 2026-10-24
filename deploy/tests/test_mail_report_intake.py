import base64
import gzip
import importlib.util
import json
import re
import subprocess
from unittest.mock import patch
import tempfile
import time
import unittest
from email.message import EmailMessage
from email import policy
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "scripts"
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
intake = load("report_intake_test", ROOT / "mail-report-intake.py")
bridge = load("receipt_bridge_test_reports", ROOT / "mail-receipt-bridge.py")

def xml():
    now = int(time.time())
    return f"<feedback><report_metadata><org_name>Fixture provider</org_name><report_id>fixture-only</report_id><date_range><begin>{now-86400}</begin><end>{now}</end></date_range></report_metadata><policy_published><domain>example.org</domain></policy_published><record><row><source_ip>192.0.2.1</source_ip><count>2</count><policy_evaluated><dkim>fail</dkim><spf>fail</spf></policy_evaluated></row><auth_results><dkim><domain>unaligned.example</domain><result>pass</result></dkim></auth_results></record></feedback>".encode()

def payload(message, address="dmarc@example.org"):
    raw = message.as_bytes(policy=policy.SMTP)
    head, body = raw.split(b"\r\n\r\n", 1)
    return {"context": {"stage": "data", "sasl": None, "client": {"ip": "192.0.2.5"}},
            "envelope": {"from": {"address": "reporter@example.net"}, "to": [{"address": address}]},
            "message": {"headers": [(str(k), str(v)) for k, v in message.items()], "serverHeaders": [], "contents": body.decode()}}

class ReportIntakeTest(unittest.TestCase):
    def test_dmarc_extraction_persists_only_aggregates_and_deduplicates_after_restart(self):
        message = EmailMessage()
        message["From"] = "reporter@example.net"
        message["To"] = "dmarc@example.org"
        message["Subject"] = "DMARC fixture"
        message.set_content("SECRET BODY NEVER PERSISTED")
        message.add_attachment(gzip.compress(xml()), maintype="application", subtype="gzip", filename="report.xml.gz")
        message.add_attachment(b"SECRET PDF NEVER PERSISTED", maintype="application", subtype="pdf", filename="invoice.pdf")
        target = {"address": "dmarc@example.org", "domain": "example.org", "kinds": ["dmarc"], "targetRef": "f" * 64}
        raw = payload(message)
        events = intake.extract_reports(raw, [target])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["report"]["sourcesJson"][0]["dkimAuth"][0]["result"], "pass")
        self.assertEqual(events[0]["report"]["sourcesJson"][0]["dkimAlignment"], "fail")
        self.assertNotIn("SECRET", json.dumps(events))
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "receipts.sqlite")
            store = bridge.Store(path)
            first = intake.ReportIntake(store)
            first.targets, first.last_targets = [target], time.time()
            first.ingest(raw)
            with store.connection() as db:
                db.execute("INSERT OR REPLACE INTO report_targets VALUES(1,?,?)", (json.dumps([target]), time.time()))
            second = intake.ReportIntake(bridge.Store(path))
            second.ingest(raw)
            with store.connection() as db:
                rows = db.execute("SELECT payload FROM incoming_reports").fetchall()
            self.assertEqual(len(rows), 1)
            self.assertNotIn("SECRET", rows[0][0])

    def test_unrelated_recipient_or_normal_invoice_is_never_collected(self):
        message = EmailMessage()
        message["To"] = "user@example.org"
        message.set_content("Private normal message")
        message.add_attachment(xml(), maintype="application", subtype="xml", filename="report.xml")
        self.assertEqual(intake.extract_reports(payload(message, "other@example.org"), [{"address": "dmarc@example.org", "domain": "example.org", "kinds": ["dmarc"], "targetRef": "f" * 64}]), [])
        self.assertEqual(intake.extract_reports(payload(message, "user@example.org"), [{"address": "user@example.org", "domain": "example.org", "kinds": ["feedback"], "targetRef": "f" * 64}]), [])

    def test_xml_entities_bombs_and_foreign_domains(self):
        with self.assertRaises(ValueError):
            intake.parse_aggregate(b'<!DOCTYPE x [<!ENTITY leak SYSTEM "file:///etc/passwd">]>' + xml(), "report.xml")
        with self.assertRaises(ValueError):
            intake.parse_aggregate(gzip.compress(b"x" * (intake.MAX_BYTES+1)), "report.xml.gz")
        message = EmailMessage()
        message.set_content("Report")
        message.add_attachment(xml(), maintype="application", subtype="xml", filename="report.xml")
        self.assertEqual(intake.extract_reports(payload(message), [{"address": "dmarc@example.org", "domain": "other.example", "kinds": ["dmarc"], "targetRef": "f" * 64}]), [])

    @unittest.skipUnless(importlib.util.find_spec("dkim"), "Install requirements-mail-reports.txt for cryptographic fixture")
    def test_real_rsa_signature_and_native_header_reconstruction(self):
        import dkim
        key = subprocess.check_output(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"], stderr=subprocess.DEVNULL)
        public = subprocess.check_output(["openssl", "pkey", "-pubout", "-outform", "DER"], input=key, stderr=subprocess.DEVNULL)
        record = b"v=DKIM1; k=rsa; p=" + base64.b64encode(public)
        raw = b"From: feedback@arf.mail.yahoo.com\r\nTo: dmarc@example.org\r\nSubject: DKIM fixture\r\nContent-Type: text/plain\r\n\r\nStructured report fixture\r\n"
        signature = dkim.sign(raw, b"fixture", b"arf.mail.yahoo.com", key, canonicalize=(b"relaxed", b"relaxed"))
        signed = signature + raw
        head, body = signed.split(b"\r\n\r\n", 1)
        # Stalwart serializes original names and raw folded values, not unfolded email.items().
        fields = []
        for match in re.finditer(br"^([^:\r\n]+):([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)", head, re.M):
            fields.append((match.group(1).decode(), match.group(2).decode() + "\r\n"))
        rebuilt = intake.reconstruct_message(fields, body.decode())
        self.assertEqual(rebuilt, signed)
        class Answer:
            strings = [record]
        with patch("dns.resolver.Resolver.resolve", return_value=[Answer()]):
            self.assertEqual(intake.verify_dkim(rebuilt), ["arf.mail.yahoo.com"])
            self.assertEqual(intake.verify_dkim(rebuilt.replace(b"Structured report fixture", b"FORGED REPORT")), [])

    def test_client_authentication_results_cannot_authenticate_a_provider(self):
        raw = b'From: fake@example.net\r\nTo: sender@example.org\r\nAuthentication-Results: mail.kod.bzh; dkim=pass header.d=arf.mail.yahoo.com\r\nContent-Type: multipart/report; report-type=disposition-notification; boundary="x"\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\nSECRET BODY\r\n--x\r\nContent-Type: message/disposition-notification\r\n\r\nOriginal-Message-ID: <opaque@example.org>\r\nFinal-Recipient: rfc822; recipient@example.net\r\nDisposition: manual-action/MDN-sent-manually; displayed\r\n\r\n--x--\r\n'
        from email.parser import BytesParser
        message = BytesParser(policy=policy.default).parsebytes(raw)
        events = intake.extract_reports(payload(message, "sender@example.org"), [{"address": "sender@example.org", "domain": "example.org", "kinds": ["feedback"], "targetRef": "f" * 64}])
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["kind"], "mdn")
        self.assertEqual(events[0]["verifiedDomains"], [])
        self.assertNotIn("SECRET", json.dumps(events))

if __name__ == "__main__":
    unittest.main()
