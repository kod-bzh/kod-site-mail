#!/usr/bin/env python3
"""Fail-closed DKIM rotation for mail.d2-group.fr; secrets stay on the mail VM."""
import argparse
import configparser
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import time
import urllib.error
import urllib.request

DOMAIN = "mail.d2-group.fr"
ZONE = "d2-group.fr"
PREFIX = "framm-rsa-"
DAY = 86400
ROTATE_AFTER = 90 * DAY
RETAIN_DNS = 30 * DAY


def epoch(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def iso(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def material(value):
    values = {}
    for part in value.split(";"):
        if "=" in part:
            key, text = part.strip().split("=", 1)
            if key in values:
                raise RuntimeError("Duplicate DKIM tag")
            values[key] = text.strip()
    if values.get("v", "DKIM1") != "DKIM1" or values.get("k", "rsa") != "rsa":
        raise RuntimeError("Unexpected DKIM algorithm")
    return values.get("p", "")


def relative(selector):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,63}", selector):
        raise RuntimeError("Selector outside permitted scope")
    return selector + "._domainkey.mail"


def txt(value):
    # OVH and dig return one RR as one or more quoted strings.
    return "".join(shlex.split(value)) if value.startswith('"') else value


def request(url, method="GET", body=None, headers=None):
    raw = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    req = urllib.request.Request(url, data=raw, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise RuntimeError("API response too large")
            return json.loads(data) if data else None
    except urllib.error.HTTPError as error:
        # Never log response bodies: a rejected secret field could be echoed there.
        raise RuntimeError(f"API HTTP {error.code}") from None
    except urllib.error.URLError:
        raise RuntimeError("API network unavailable") from None


class Stalwart:
    def __init__(self, token, url="http://127.0.0.1:8080/jmap"):
        self.token, self.url = token, url
        found = self.call("x:Domain/query", {"filter": {"name": DOMAIN}}).get("ids", [])
        domains = self.call("x:Domain/get", {"ids": found, "properties": ["name", "dkimManagement", "dnsManagement"]}).get("list", [])
        exact = [d for d in domains if d["name"] == DOMAIN]
        if len(exact) != 1:
            raise RuntimeError("Dedicated mail domain not uniquely resolved")
        self.domain = exact[0]
        self.domain_id = self.domain["id"]

    def call(self, method, args):
        result = request(self.url, "POST", {"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": [[method, args, "c"]]}, {"Authorization": "Bearer " + self.token})
        rows = result.get("methodResponses", [])
        if len(rows) != 1 or rows[0][0] != method:
            raise RuntimeError(f"Stalwart {method} failed")
        body = rows[0][1]
        if any(body.get(field) for field in ["notCreated", "notUpdated", "notDestroyed", "notFound"]):
            raise RuntimeError(f"Stalwart {method} refused requested objects")
        return body

    def configure(self):
        # Native v0.16.8 rotation retires active keys even on failed DNS publication.
        # Disable its scheduler only for this domain; this coordinator owns lifecycle.
        self.call("x:Domain/set", {"update": {self.domain_id: {"dkimManagement": {"@type": "Manual"}}}})
        self.reload()

    def keys(self):
        ids = self.call("x:DkimSignature/query", {"filter": {"domainId": self.domain_id}}).get("ids", [])
        return self.call("x:DkimSignature/get", {"ids": ids, "properties": ["domainId", "selector", "publicKey", "@type", "stage", "createdAt", "nextTransitionAt"]}).get("list", [])

    def create_pending(self, now):
        selector = PREFIX + dt.datetime.fromtimestamp(now, dt.timezone.utc).strftime("%Y%m%d%H%M%S") + "-" + secrets.token_hex(4)
        generated = subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"], capture_output=True, check=True, timeout=30)
        body = self.call("x:DkimSignature/set", {"create": {"next": {"@type": "Dkim1RsaSha256", "domainId": self.domain_id, "selector": selector, "stage": "pending", "nextTransitionAt": None, "privateKey": {"@type": "Text", "secret": generated.stdout.decode()}}}})
        key_id = body.get("created", {}).get("next", {}).get("id")
        if not key_id:
            raise RuntimeError("Pending signature creation unconfirmed")
        return next(k for k in self.keys() if k["id"] == key_id)

    def stage(self, key, stage):
        self.call("x:DkimSignature/set", {"update": {key["id"]: {"stage": stage, "nextTransitionAt": None}}})
        self.reload()
        actual = next(k for k in self.keys() if k["id"] == key["id"])
        if actual["stage"] != stage:
            raise RuntimeError("Signature transition unconfirmed")

    def reload(self):
        self.call("x:Action/set", {"create": {"reload": {"@type": "ReloadSettings"}}})


class Ovh:
    def __init__(self, path):
        if path.stat().st_mode & 0o077:
            raise RuntimeError("OVH credential permissions must be 0600")
        config = configparser.ConfigParser()
        config.read(path)
        section = config["d2-group"]
        self.key = section["application_key"]
        self.secret = section["application_secret"]
        self.consumer = section["consumer_key"]
        self.endpoint = "https://eu.api.ovh.com/1.0"
        self.call("GET", f"/domain/zone/{ZONE}")

    def call(self, method, path, body=None):
        url = self.endpoint + path
        raw = "" if body is None else json.dumps(body, separators=(",", ":"))
        with urllib.request.urlopen(self.endpoint + "/auth/time", timeout=20) as response:
            timestamp = response.read(32).decode().strip()
        signature = "$1$" + hashlib.sha1("+".join([self.secret, self.consumer, method, url, raw, timestamp]).encode()).hexdigest()
        return request(url, method, body, {"X-Ovh-Application": self.key, "X-Ovh-Consumer": self.consumer, "X-Ovh-Timestamp": timestamp, "X-Ovh-Signature": signature})

    def records(self, key):
        name = relative(key["selector"])
        ids = self.call("GET", f"/domain/zone/{ZONE}/record?fieldType=TXT&subDomain={name}")
        rows = [self.call("GET", f"/domain/zone/{ZONE}/record/{ident}") for ident in ids]
        if any(r.get("subDomain") != name or r.get("fieldType") != "TXT" for r in rows):
            raise RuntimeError("OVH returned records outside permitted selector")
        if rows and (len(rows) != 1 or material(txt(rows[0]["target"])) != key["publicKey"]):
            raise RuntimeError("Refusing to overwrite a conflicting DKIM record")
        return rows

    def publish(self, key):
        if not self.records(key):
            self.call("POST", f"/domain/zone/{ZONE}/record", {"fieldType": "TXT", "subDomain": relative(key["selector"]), "ttl": 300, "target": '"v=DKIM1; k=rsa; p=' + key["publicKey"] + '"'})
        self.call("POST", f"/domain/zone/{ZONE}/refresh")

    def remove(self, key):
        for row in self.records(key):
            self.call("DELETE", f"/domain/zone/{ZONE}/record/{row['id']}")
        self.call("POST", f"/domain/zone/{ZONE}/refresh")

    def verify(self, key):
        name = relative(key["selector"]) + "." + ZONE
        for resolver in ["ns107.ovh.net", "dns107.ovh.net", "1.1.1.1", "8.8.8.8"]:
            result = subprocess.run(["dig", "+short", "+time=3", "+tries=1", "TXT", name, "@" + resolver], capture_output=True, text=True, timeout=8)
            rows = [line.strip() for line in result.stdout.splitlines() if line.startswith('"')]
            if result.returncode or len(rows) != 1 or material(txt(rows[0])) != key["publicKey"]:
                return False
        return True


class Coordinator:
    def __init__(self, server, dns, state, save, now=time.time):
        self.server, self.dns, self.state, self.save, self.now = server, dns, state, save, now

    def checkpoint(self):
        self.save(self.state)

    def run(self, operation=None):
        now = self.now()
        keys = [k for k in self.server.keys() if k["domainId"] == self.server.domain_id and k["@type"] == "Dkim1RsaSha256"]
        active = [k for k in keys if k["stage"] == "active"]
        if not active:
            raise RuntimeError("No active RSA signature; operator recovery required")
        for key in active:
            if not self.dns.verify(key):
                raise RuntimeError("Current RSA signature DNS not confirmed; signing preserved")
        pending = [k for k in keys if k["stage"] == "pending"]
        if len(pending) > 1 or any(not k["selector"].startswith(PREFIX) for k in pending):
            raise RuntimeError("Unrecognized pending signatures; operator review required")
        completed = self.state.setdefault("completedOperations", [])
        newest = max(active, key=lambda k: epoch(k["createdAt"]))
        due = now - epoch(newest["createdAt"]) >= ROTATE_AFTER
        if not pending and (due or (operation and operation not in completed)):
            key = self.server.create_pending(now)
            self.state["operation"] = operation
            self.state["pendingKeyId"] = key["id"]
            self.checkpoint()
            pending = [key]
        if pending:
            if operation and operation not in completed:
                if self.state.get("operation") not in [None, operation]:
                    raise RuntimeError("Another controlled rotation is pending")
                self.state["operation"] = operation
            key = pending[0]
            self.state["pendingKeyId"] = key["id"]
            self.checkpoint()
            self.dns.publish(key)
            if not self.dns.verify(key):
                self.state["phase"] = "waiting_for_dns"
                self.checkpoint()
                return
            # Activation precedes retirement. A partial failure can leave two valid
            # signatures, never zero. Reconciliation repairs that on the next run.
            self.server.stage(key, "active")
            newest = key
            if self.state.get("operation"):
                completed.append(self.state["operation"])
                self.state["completedOperations"] = completed[-20:]
            self.state.pop("pendingKeyId", None)
            self.state.pop("operation", None)
            self.checkpoint()
        active = [k for k in self.server.keys() if k["@type"] == "Dkim1RsaSha256" and k["domainId"] == self.server.domain_id and k["stage"] == "active"]
        newest = max(active, key=lambda k: epoch(k["createdAt"]))
        retiring = self.state.setdefault("retiring", {})
        for old in active:
            if old["id"] == newest["id"]:
                continue
            if not self.dns.verify(newest):
                raise RuntimeError("Replacement DNS not confirmed; old signature preserved")
            # Persist the grace period before mutation, so interrupted runs retain it.
            retiring.setdefault(old["id"], {"selector": old["selector"], "since": now})
            self.checkpoint()
            self.server.stage(old, "retiring")
        for key in self.server.keys():
            record = retiring.get(key["id"])
            if key["domainId"] != self.server.domain_id or key["@type"] != "Dkim1RsaSha256" or not record or key["stage"] != "retiring" or now - record["since"] < RETAIN_DNS:
                continue
            if not self.dns.verify(newest):
                raise RuntimeError("Active DNS unavailable; old public key retained")
            if key["selector"] != record["selector"]:
                raise RuntimeError("Retiring selector mismatch")
            self.dns.remove(key)
            self.server.stage(key, "retired")
            # Private material is retained on Stalwart; no irreversible purge here.
        self.state.update(phase="healthy", activeSelector=newest["selector"], nextRotationAt=iso(epoch(newest["createdAt"]) + ROTATE_AFTER), lastError=None)
        self.checkpoint()


def save_state(path, state):
    temporary = path.with_suffix(".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as output:
        json.dump(state, output, indent=2)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ovh-config", type=Path, default=Path("/etc/framm/ovh-dkim.ini"))
    parser.add_argument("--state", type=Path, default=Path("/var/lib/framm-dkim/state.json"))
    parser.add_argument("--env-file", type=Path, default=Path("/opt/framm/deploy/.generated/env.production"))
    parser.add_argument("--operation-id", help="Idempotent one-off controlled rotation; omit for scheduled maintenance")
    parser.add_argument("--configure", action="store_true", help="Delegate lifecycle to this coordinator on this domain only")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.status:
        status = json.loads(args.state.read_text()) if args.state.exists() else {"phase": "not_initialized"}
        status["fresh"] = bool(status.get("lastCheckedAt") and time.time() - epoch(status["lastCheckedAt"]) < 1800)
        print(json.dumps(status))
        return
    with open(args.state.with_suffix(".lock"), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('{"phase":"already_running"}')
            return
        state = json.loads(args.state.read_text()) if args.state.exists() else {"version": 1, "domain": DOMAIN}
        try:
            values = {}
            for line in args.env_file.read_text().splitlines():
                if line.startswith("STALWART_API_KEY="):
                    values["token"] = shlex.split(line.split("=", 1)[1])[0]
            server = Stalwart(values["token"])
            dns = Ovh(args.ovh_config)
            if args.configure:
                server.configure()
            elif server.domain["dkimManagement"]["@type"] != "Manual":
                raise RuntimeError("Native DKIM scheduler still enabled; configure coordinator first")
            Coordinator(server, dns, state, lambda data: save_state(args.state, data)).run(args.operation_id)
            state["lastCheckedAt"] = iso(time.time())
            save_state(args.state, state)
            print(json.dumps(state))
        except Exception as error:
            state.update(phase="error", lastError=str(error), lastFailedAt=iso(time.time()))
            save_state(args.state, state)
            print(json.dumps({"phase": "error", "detail": str(error)}))
            raise SystemExit(1)


if __name__ == "__main__":
    main()
