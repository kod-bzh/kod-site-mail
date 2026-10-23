#!/usr/bin/env python3
"""Loopback-only, durable SMTP receipts. Never stores message bodies or attachments."""
import hashlib
import hmac
import json
import os
import re
import sqlite3
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PURPOSE = b"kod-mail-receipts-v1"
MAX_PREFIX = 262144
EVENT_TYPES = {"delivery.delivered": "smtp.accepted", "delivery.dsn-perm-fail": "smtp.failed", "delivery.dsn-temp-fail": "smtp.deferred"}


def signing_key(master):
    return hmac.new(master.encode(), PURPOSE, hashlib.sha256).digest()


def metadata_prefix(raw):
    """Decode only context/envelope/headers, before the (potentially huge) contents string.

    This is the serialization order of Stalwart 0.16.8's MTA Hook Request.
    JSONDecoder handles escaped header values; substring/regex extraction is unsafe.
    """
    text = raw.decode("utf-8")
    decoder = json.JSONDecoder()
    pos = 0

    def whitespace():
        nonlocal pos
        while pos < len(text) and text[pos].isspace():
            pos += 1

    def char(value):
        nonlocal pos
        whitespace()
        if pos >= len(text) or text[pos] != value:
            raise ValueError("Incomplete metadata")
        pos += 1

    def value():
        nonlocal pos
        whitespace()
        result, pos = decoder.raw_decode(text, pos)
        return result

    result = {}
    char("{")
    for index, expected in enumerate(("context", "envelope", "message")):
        if index:
            char(",")
        if value() != expected:
            raise ValueError("Unsupported metadata order")
        char(":")
        if expected == "message":
            char("{")
            if value() != "headers":
                raise ValueError("Missing headers")
            char(":")
            result["headers"] = value()
        else:
            result[expected] = value()
    return result


class Store:
    def __init__(self, path):
        self.path = path
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("CREATE TABLE IF NOT EXISTS bindings (queue_id TEXT PRIMARY KEY, rfc_id TEXT NOT NULL, sender TEXT NOT NULL, recipients TEXT NOT NULL, created REAL NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created REAL NOT NULL, next_retry REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent REAL)")

    def connection(self):
        return sqlite3.connect(self.path, timeout=10)

    def bind(self, metadata):
        context, envelope = metadata["context"], metadata["envelope"]
        if not context.get("sasl") or str(context.get("stage", "")).lower() != "data":
            return
        raw_id = context.get("queue", {}).get("id", "")
        if not re.fullmatch(r"[0-9a-fA-F]{1,16}", raw_id):
            return
        headers = [str(v).strip() for k, v in metadata["headers"] if k.lower() == "message-id"]
        if len(headers) != 1:
            return
        rfc_id = headers[0].strip("<>")
        if not re.fullmatch(r"[0-9a-f-]{36}@[A-Za-z0-9.-]+", rfc_id):
            return
        sender = envelope["from"]["address"].lower()
        recipients = sorted({x["address"].lower() for x in envelope["to"]})
        with self.connection() as db:
            db.execute("INSERT OR IGNORE INTO bindings VALUES(?,?,?,?,?)", (str(int(raw_id, 16)), rfc_id, sender, json.dumps(recipients), time.time()))

    def ingest(self, events):
        with self.connection() as db:
            for event in events:
                typ = EVENT_TYPES.get(event.get("type"))
                data = event.get("data", {})
                if not typ or not isinstance(data.get("to"), str):
                    continue
                binding = db.execute("SELECT rfc_id,sender,recipients FROM bindings WHERE queue_id=?", (str(data.get("queueId", "")),)).fetchone()
                if not binding:
                    continue
                rfc_id, sender, recipients = binding
                recipient = data["to"].lower()
                if recipient not in json.loads(recipients) or sender != data.get("from", "").lower():
                    continue
                hostname = str(data.get("hostname", ""))
                code = data.get("code")
                if typ == "smtp.accepted" and (not isinstance(code, int) or not 200 <= code < 300 or not hostname or hostname.lower() in ("localhost", "127.0.0.1", "::1")):
                    continue
                payload = {"type": typ, "rfcMessageId": rfc_id, "from": sender, "recipient": recipient,
                           "occurredAt": event["createdAt"], "queueId": str(data["queueId"]),
                           "remoteMta": hostname[:255], "smtpReply": ((str(code) + " ") if isinstance(code, int) else "") + str(data.get("details", ""))[:2000]}
                identity = json.dumps(payload, sort_keys=True, separators=(",", ":"))
                payload["id"] = hashlib.sha256(identity.encode()).hexdigest()
                now = time.time()
                db.execute("INSERT OR IGNORE INTO receipts(id,payload,created,next_retry) VALUES(?,?,?,?)", (payload["id"], json.dumps(payload), now, now))

    def forward(self, endpoint, key):
        with self.connection() as db:
            expired = db.execute("DELETE FROM receipts WHERE sent IS NULL AND created<?", (time.time() - 8 * 86400,)).rowcount
            if expired:
                print(f"{expired} receipts expired outside the observation window; delivery remains unconfirmed", flush=True)
            rows = db.execute("SELECT id,payload,attempts FROM receipts WHERE sent IS NULL AND next_retry<=? ORDER BY created LIMIT 50", (time.time(),)).fetchall()
        if rows:
            body = json.dumps({"events": [json.loads(x[1]) for x in rows]}, separators=(",", ":")).encode()
            timestamp = str(int(time.time()))
            signature = hmac.new(key, timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
            request = urllib.request.Request(endpoint, data=body, headers={"Content-Type": "application/json", "X-Kod-Timestamp": timestamp, "X-Kod-Signature": "v1=" + signature})
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    if not 200 <= response.status < 300:
                        raise RuntimeError("Receipt acknowledgement unavailable")
                    response.read(4096)
                with self.connection() as db:
                    db.executemany("UPDATE receipts SET sent=? WHERE id=?", [(time.time(), row[0]) for row in rows])
            except Exception:
                with self.connection() as db:
                    db.executemany("UPDATE receipts SET attempts=attempts+1,next_retry=? WHERE id=?", [(time.time() + min(300, 2 ** min(row[2] + 1, 8)), row[0]) for row in rows])
                print("Receipt forwarding deferred; durable queue retained", flush=True)
        with self.connection() as db:
            db.execute("DELETE FROM receipts WHERE sent IS NOT NULL AND sent<?", (time.time() - 7 * 86400,))
            db.execute("DELETE FROM bindings WHERE created<?", (time.time() - 8 * 86400,))


def serve():
    key = signing_key(os.environ["STALWART_API_KEY"])
    path = os.environ.get("MAIL_RECEIPT_DB", "/var/lib/framm-mail-receipts/receipts.sqlite")
    Path(path).parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    store = Store(path)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.reply(200 if self.path == "/health" else 404, {"ok": True})

        def do_POST(self):
            self.connection.settimeout(10)
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if self.path == "/bind":
                    if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + key.hex()):
                        return self.reply(401, {})
                    if not 0 < length <= 100_000_000:
                        return self.reply(413, {})
                    prefix, metadata = bytearray(), None
                    remaining = length
                    while remaining:
                        chunk = self.rfile.read(min(65536, remaining))
                        if not chunk:
                            raise ValueError("Interrupted hook")
                        remaining -= len(chunk)
                        if metadata is None:
                            prefix.extend(chunk)
                            try:
                                metadata = metadata_prefix(prefix)
                            except (ValueError, UnicodeDecodeError):
                                if len(prefix) > MAX_PREFIX:
                                    raise ValueError("Metadata limit")
                    if metadata is None:
                        raise ValueError("Missing metadata")
                    store.bind(metadata)
                    return self.reply(200, {"action": "accept"})
                if self.path == "/events":
                    if not 0 < length <= 2_000_000:
                        return self.reply(413, {})
                    body = self.rfile.read(length)
                    import base64
                    expected = base64.b64encode(hmac.new(key.hex().encode(), body, hashlib.sha256).digest()).decode()
                    if not hmac.compare_digest(expected, self.headers.get("X-Signature", "")):
                        return self.reply(401, {})
                    store.ingest(json.loads(body)["events"])
                    return self.reply(200, {"ok": True})
                self.reply(404, {})
            except Exception:
                self.reply(503, {"error": "receipt_unavailable"})

    def forward_loop():
        while True:
            try:
                store.forward(os.environ.get("MAIL_RECEIPT_URL", "https://kod.bzh/api/internal/mail/receipts"), key)
            except Exception:
                print("Receipt processing unavailable; will retry", flush=True)
            time.sleep(2)

    threading.Thread(target=forward_loop, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", 8791), Handler).serve_forever()


if __name__ == "__main__":
    serve()
