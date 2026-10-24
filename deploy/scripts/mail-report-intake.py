"""Pre-encryption structured report intake. Never persists raw MIME/body/attachments."""
import gzip
import hashlib
import io
import ipaddress
import json
import re
import time
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from email import policy
from email.parser import BytesParser
from datetime import datetime, timezone

MAX_BYTES = 2_000_000

def stamp(value=None):
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat().replace("+00:00", "Z")

def canonical_id(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

def parse_aggregate(data, filename):
    if len(data) > MAX_BYTES:
        raise ValueError("Report limit")
    if data[:2] == b"\x1f\x8b":
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as source:
            data = source.read(MAX_BYTES + 1)
    elif data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as source:
            entries = source.infolist()
            xml = [entry for entry in entries if entry.filename.lower().endswith(".xml")]
            if len(entries) > 10 or len(xml) != 1 or xml[0].file_size > MAX_BYTES or xml[0].flag_bits & 1:
                raise ValueError("Archive limit")
            with source.open(xml[0]) as stream:
                data = stream.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or b"\x00" in data or re.search(br"<!DOCTYPE|<!ENTITY", data, re.I):
        raise ValueError("Forbidden XML")
    root = ET.fromstring(data)
    if root.tag != "feedback":
        raise ValueError("Not a DMARC report")
    def check_depth(node, depth=0):
        if depth > 32:
            raise ValueError("XML depth")
        for child in node:
            check_depth(child, depth + 1)
    check_depth(root)
    domain = (root.findtext("policy_published/domain") or "").lower()
    if not re.fullmatch(r"[a-z0-9.-]{1,253}", domain):
        raise ValueError("Domain required")
    reporter = (root.findtext("report_metadata/org_name") or "").strip()[:200]
    identifier = (root.findtext("report_metadata/report_id") or "").strip()[:300]
    start = int(root.findtext("report_metadata/date_range/begin") or "-1")
    end = int(root.findtext("report_metadata/date_range/end") or "-1")
    if not reporter or not identifier or start < 0 or not start < end <= time.time() + 86400 or end - start > 32 * 86400:
        raise ValueError("Report identity/period")
    records = root.findall("record")
    if not records or len(records) > 10000:
        raise ValueError("Record limit")
    rows = []
    for record in records:
        ip = record.findtext("row/source_ip") or ""
        ipaddress.ip_address(ip)
        count = int(record.findtext("row/count") or "-1")
        if not 0 <= count <= 100_000_000:
            raise ValueError("Count limit")
        dkim = record.findtext("row/policy_evaluated/dkim") or "unknown"
        spf = record.findtext("row/policy_evaluated/spf") or "unknown"
        def authentication(name):
            return [{"domain": (r.findtext("domain") or "")[:253], "result": (r.findtext("result") or "unknown")[:32],
                     "selector": (r.findtext("selector") or "")[:100], "scope": (r.findtext("scope") or "")[:32]}
                    for r in record.findall("auth_results/" + name)[:20]]
        rows.append({"ip": ip, "count": count, "dkim": dkim == "pass", "spf": spf == "pass", "dkimAlignment": dkim,
                     "spfAlignment": spf, "disposition": (record.findtext("row/policy_evaluated/disposition") or "unknown")[:32],
                     "headerFrom": (record.findtext("identifiers/header_from") or "")[:253],
                     "dkimAuth": authentication("dkim"), "spfAuth": authentication("spf")})
    if sum(row["count"] for row in rows) > 2_000_000_000:
        raise ValueError("Total limit")
    return {"reportedDomain": domain, "reporter": reporter, "reportIdentifier": identifier,
            "periodStart": stamp(start), "periodEnd": stamp(end), "sourcesJson": rows, "filename": filename[:255]}

def structured_fields(text, allowed):
    # Preserve only bounded machine fields. Human text and original message body are discarded.
    if len(text.encode()) > 256000:
        raise ValueError("Structured report limit")
    lines = re.sub(r"\r?\n[ \t]+", " ", text).splitlines()
    result = []
    for line in lines:
        name, separator, value = line.partition(":")
        if separator and name.lower() in allowed:
            result.append(name + ": " + value.strip()[:2100])
    return "\r\n".join(result)

def reconstruct_message(headers, contents):
    lines = []
    for key, value in headers:
        if not re.fullmatch(r"[A-Za-z0-9-]{1,100}", key) or len(value) > 10000:
            raise ValueError("Header limit")
        # Native values retain original folding/newlines. Preserve them for DKIM simple/relaxed.
        line = key + ":" + (value if value[:1] in [" ", "\t"] else " " + value)
        lines.append(line if line.endswith("\r\n") else line + "\r\n")
    return ("".join(lines) + "\r\n" + contents).encode()

def verify_dkim(raw):
    try:
        import dkim
        import dns.resolver
    except ImportError:
        return []
    head = raw.split(b"\r\n\r\n", 1)[0]
    signatures = re.findall(br"^DKIM-Signature:([^\r\n]*(?:\r\n[ \t][^\r\n]*)*)", head, re.I | re.M)
    if len(signatures) > 5:
        return []
    resolver = dns.resolver.Resolver()
    resolver.timeout, resolver.lifetime = 2, 2
    queries = 0
    def query(name, timeout=2):
        nonlocal queries
        queries += 1
        if queries > 10 or not re.fullmatch(br"[a-zA-Z0-9_.-]{1,254}", name):
            return b""
        try:
            rows = resolver.resolve(name.decode().rstrip("."), "TXT", lifetime=2)
            return b"".join(rows[0].strings) if len(rows) == 1 else b""
        except Exception:
            return b""
    verified = []
    for index, signature in enumerate(signatures):
        # Reject partial-body signatures; the entire structured complaint must be authenticated.
        if re.search(br"(?:^|;)\s*l\s*=", signature, re.I):
            continue
        domain = re.search(br"(?:^|;)\s*d\s*=\s*([a-zA-Z0-9.-]+)", signature, re.I)
        try:
            if domain and dkim.DKIM(raw).verify(idx=index, dnsfunc=query):
                verified.append(domain.group(1).decode().lower())
        except Exception:
            pass
    return verified

def extract_reports(payload, targets):
    context = payload.get("context", {})
    if context.get("sasl") or str(context.get("stage", "")).lower() != "data":
        return []
    recipients = {row.get("address", "").lower() for row in payload.get("envelope", {}).get("to", [])}
    destinations = [target for target in targets if target["address"] in recipients]
    if not destinations:
        return []
    message = payload.get("message", {})
    headers = message.get("headers", [])
    content_type = [v for k, v in headers if k.lower() == "content-type"]
    if len(content_type) != 1 or not any(kind in content_type[0].lower() for kind in ["multipart/report", "multipart/mixed", "application/zip", "application/gzip", "text/xml", "application/xml"]):
        return []
    if not any("dmarc" in target["kinds"] for target in destinations) and "multipart/report" not in content_type[0].lower():
        return []
    contents = message.get("contents", "")
    if not isinstance(contents, str) or len(contents.encode()) > MAX_BYTES:
        raise ValueError("MIME limit")
    raw = reconstruct_message(headers, contents)
    mime = BytesParser(policy=policy.default).parsebytes(raw)
    # Stalwart 0.16.8 always emits an empty serverHeaders array. Verify DKIM ourselves;
    # never trust a caller-supplied Authentication-Results header.
    verified = verify_dkim(raw)
    results = []
    peer = context.get("client", {}).get("ip", "")
    ipaddress.ip_address(peer)
    original = ""
    if mime.get_content_type() == "multipart/report":
        # RFC report fields are immediate children, never reports inside an attached original email.
        parts = list(mime.iter_parts())
    else:
        parts, pending = [], [(mime, 0)]
        while pending:
            part, depth = pending.pop()
            if depth > 32 or len(parts) >= 100:
                raise ValueError("MIME structure limit")
            parts.append(part)
            if part.get_content_maintype() == "multipart":
                pending.extend((child, depth + 1) for child in part.iter_parts())
    if len(parts) > 100:
        raise ValueError("Part limit")
    for part in parts:
        if part.get_content_type() in ["text/rfc822-headers", "message/rfc822"]:
            raw_headers = part.get_payload(decode=True)
            if raw_headers:
                original = structured_fields(raw_headers[:128000].decode("utf8", "replace").split("\r\n\r\n")[0], {"message-id"})
            elif isinstance(part.get_payload(), list) and part.get_payload():
                value = part.get_payload()[0].get("Message-ID", "")
                original = "Message-ID: " + str(value)[:320]
    for target in destinations:
        for part in parts:
            typ = part.get_content_type()
            base = {"address": target["address"], "occurredAt": stamp(), "peerIp": peer, "verifiedDomains": verified[:5]}
            name = part.get_filename() or ""
            if mime.get_content_type() == "multipart/report" and typ in ["message/disposition-notification", "message/feedback-report", "message/delivery-status", "message/global-delivery-status"]:
                data = part.get_payload(decode=True)
                if data is None and isinstance(part.get_payload(), list):
                    data = b"\r\n\r\n".join(child.as_bytes(policy=policy.SMTP).rstrip(b"\r\n") for child in part.get_payload())
                text = (data or b"").decode("utf8", "replace")
                if typ in ["message/delivery-status", "message/global-delivery-status"]:
                    # DSNs have multiple per-recipient blocks; keep those boundaries.
                    allowed = {"original-envelope-id", "reporting-mta", "final-recipient", "original-recipient", "action", "status", "remote-mta", "diagnostic-code"}
                    text = "\r\n\r\n".join(structured_fields(block, allowed) for block in re.split(r"\r?\n\s*\r?\n", text))
                    kind = "dsn"
                else:
                    kind = "mdn" if typ == "message/disposition-notification" else "arf"
                    text = structured_fields(text, {"original-message-id", "final-recipient", "original-recipient", "disposition", "feedback-type", "version", "original-rcpt-to", "original-mail-from"})
                results.append({**base, "kind": kind, "content": text, "originalHeaders": original})
            elif not part.is_multipart() and "dmarc" in target["kinds"] and (re.search(r"\.(xml|gz|zip)$", name, re.I) or typ in ["application/zip", "application/gzip", "application/xml", "text/xml"]):
                data = part.get_payload(decode=True) or b""
                report = parse_aggregate(data, name or "report.xml")
                if report["reportedDomain"] == target["domain"]:
                    results.append({**base, "kind": "dmarc", "report": report})
    for row in results:
        row["id"] = canonical_id({k: v for k, v in row.items() if k != "occurredAt"})
    return results

class ReportIntake:
    def __init__(self, store):
        self.store = store
        self.targets = []
        self.last_targets = 0
        self.last_error = None
        self.error_at = 0
        with store.connection() as db:
            db.execute("CREATE TABLE IF NOT EXISTS report_targets (id INTEGER PRIMARY KEY, payload TEXT NOT NULL, fetched REAL NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS incoming_reports (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created REAL NOT NULL, next_retry REAL NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, sent REAL)")
            row = db.execute("SELECT payload,fetched FROM report_targets WHERE id=1").fetchone()
            if row and row[1] > time.time() - 21600:
                self.targets, self.last_targets = json.loads(row[0]), row[1]

    def fail(self, reason):
        self.last_error, self.error_at = reason, time.time()

    def ingest(self, payload):
        if self.last_targets < time.time() - 21600:
            raise RuntimeError("Authorized report targets unavailable")
        events = extract_reports(payload, self.targets)
        with self.store.connection() as db:
            for event in events:
                db.execute("INSERT OR IGNORE INTO incoming_reports(id,payload,created,next_retry) VALUES(?,?,?,?)", (event["id"], json.dumps(event), time.time(), time.time()))
        return len(events)

    def forward(self, endpoint, key):
        import hmac
        base = endpoint.split("/api/internal/mail/")[0] + "/api/internal/mail/"
        def request(url, body=b"", method="POST"):
            timestamp = str(int(time.time()))
            signature = hmac.new(key, timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()
            req = urllib.request.Request(url, data=body if method == "POST" else None, method=method,
                headers={"Content-Type": "application/json", "X-Kod-Timestamp": timestamp, "X-Kod-Signature": "v1=" + signature, "X-Kod-Report-Error": self.last_error if self.error_at > time.time() - 3600 else ""})
            with urllib.request.urlopen(req, timeout=15) as response:
                data = response.read(4_000_001)
                if len(data) > 4_000_000:
                    raise ValueError("Intake response limit")
                return json.loads(data)
        with self.store.connection() as db:
            backlog = db.execute("SELECT MIN(created) FROM incoming_reports WHERE sent IS NULL").fetchone()[0]
        if backlog and backlog < time.time() - 300:
            self.fail("forwarding_unavailable")
        if self.last_targets < time.time() - 60:
            response = request(base + "report-targets", method="GET")
            targets = response["targets"]
            if len(targets) > 5000:
                raise ValueError("Target limit")
            with self.store.connection() as db:
                db.execute("INSERT OR REPLACE INTO report_targets VALUES(1,?,?)", (json.dumps(targets), time.time()))
            self.targets, self.last_targets = targets, time.time()
        with self.store.connection() as db:
            rows = db.execute("SELECT id,payload,attempts FROM incoming_reports WHERE sent IS NULL AND next_retry<=? ORDER BY created LIMIT 10", (time.time(),)).fetchall()
        for identifier, payload, attempts in rows:
            try:
                request(base + "reports", json.dumps({"events": [json.loads(payload)]}, separators=(",", ":")).encode())
                with self.store.connection() as db:
                    db.execute("UPDATE incoming_reports SET sent=? WHERE id=?", (time.time(), identifier))
            except Exception:
                with self.store.connection() as db:
                    db.execute("UPDATE incoming_reports SET attempts=attempts+1,next_retry=? WHERE id=?", (time.time() + min(300, 2 ** min(attempts + 1, 8)), identifier))
        with self.store.connection() as db:
            db.execute("DELETE FROM incoming_reports WHERE sent IS NOT NULL AND sent<?", (time.time() - 7 * 86400,))
            expired = db.execute("DELETE FROM incoming_reports WHERE sent IS NULL AND created<?", (time.time() - 8 * 86400,)).rowcount
            if expired:
                self.fail("expired_reports")
                print("Structured reports expired; coverage remains incomplete", flush=True)
