import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("receipt_bridge", Path(__file__).parents[1] / "scripts/mail-receipt-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class MailReceiptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = str(Path(self.directory.name) / "receipts.sqlite")
        self.store = bridge.Store(self.path)
        self.queue_id = 336535801972610561  # Deliberately exceeds JavaScript's safe integer range.
        self.rfc_id = "d96cf67c-4409-47d4-bfa2-dbac288735dd@example.org"
        self.metadata = {"context": {"stage": "data", "sasl": {"login": "sender@example.org"}, "queue": {"id": format(self.queue_id, "x")}},
                         "envelope": {"from": {"address": "sender@example.org"}, "to": [{"address": "recipient@example.com"}]},
                         "headers": [["Message-ID", " <" + self.rfc_id + ">\r\n"]]}
        self.event = {"type": "delivery.delivered", "createdAt": "2026-10-23T11:00:00Z", "data": {
            "queueId": self.queue_id, "from": "sender@example.org", "to": "recipient@example.com", "code": 250, "hostname": "mx.example.com", "details": "2.0.0 OK"}}

    def tearDown(self):
        self.directory.cleanup()

    def receipts(self):
        with self.store.connection() as db:
            return db.execute("SELECT payload,sent FROM receipts").fetchall()

    def test_header_prefix_without_collecting_contents(self):
        value = {"context": self.metadata["context"], "envelope": self.metadata["envelope"],
                 "message": {"headers": self.metadata["headers"] + [["Subject", 'quoted "contents": marker']], "contents": "x" * 1000000}}
        raw = json.dumps(value).encode()
        result = bridge.metadata_prefix(raw[:4096])
        self.assertEqual(result["context"], value["context"])
        self.assertNotIn("contents", result)
        self.assertEqual(result["headers"], value["message"]["headers"])

    def test_exact_integer_binding_and_restart(self):
        self.store.bind(self.metadata)
        bridge.Store(self.path).ingest(json.loads(json.dumps([self.event])))
        stored = json.loads(self.receipts()[0][0])
        self.assertEqual(stored["queueId"], str(self.queue_id))
        self.assertEqual(stored["rfcMessageId"], self.rfc_id)
        self.assertNotIn("contents", stored)

    def test_duplicate_event_is_idempotent(self):
        self.store.bind(self.metadata)
        self.store.ingest([self.event, self.event])
        self.assertEqual(len(self.receipts()), 1)

    def test_native_event_id_collision_does_not_merge_recipients(self):
        self.metadata["envelope"]["to"].append({"address": "second@example.com"})
        self.store.bind(self.metadata)
        second = json.loads(json.dumps(self.event)); second["data"]["to"] = "second@example.com"
        self.event["id"] = second["id"] = "native-id-is-not-globally-unique"
        self.store.ingest([self.event, second])
        self.assertEqual(len(self.receipts()), 2)

    def test_refuses_unknown_queue_sender_recipient_and_local_success(self):
        self.store.bind(self.metadata)
        for field, value in [("queueId", self.queue_id + 1), ("from", "other@example.org"), ("to", "other@example.com"), ("hostname", "localhost"), ("code", 450)]:
            event = json.loads(json.dumps(self.event)); event["data"][field] = value
            self.store.ingest([event])
        self.assertEqual(self.receipts(), [])

    def test_ignores_unauthenticated_binding(self):
        self.metadata["context"]["sasl"] = None
        self.store.bind(self.metadata); self.store.ingest([self.event])
        self.assertEqual(self.receipts(), [])

    def test_failure_keeps_receipt_for_retry(self):
        self.store.bind(self.metadata); self.store.ingest([self.event])
        with patch.object(bridge.urllib.request, "urlopen", side_effect=OSError("offline")):
            self.store.forward("https://example.com/receipt", b"secret")
        self.assertIsNone(self.receipts()[0][1])
        with self.store.connection() as db:
            self.assertEqual(db.execute("SELECT attempts FROM receipts").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
