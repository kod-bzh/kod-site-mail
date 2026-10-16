#!/usr/bin/env python3
"""Keep sender domains with external primary MX out of local delivery.

Only manages its own highest-priority rule; preserves custom routes, TLS and
scheduling. DNS failures abort reconciliation without changing any settings.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import time
import urllib.request


def mx_hosts(domain):
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", domain):
        raise RuntimeError("Invalid domain name")
    result = subprocess.run(
        ["dig", "+time=3", "+tries=1", "+noall", "+comments", "+answer", "MX", domain],
        capture_output=True, text=True, check=True, timeout=8,
    ).stdout
    if not re.search(r"status: (NOERROR|NXDOMAIN),", result):
        raise RuntimeError(f"MX lookup unavailable for {domain}")
    records = []
    for line in result.splitlines():
        fields = line.split()
        if len(fields) >= 6 and fields[3] == "MX":
            if fields[5] == ".":
                raise RuntimeError(f"Null MX for {domain}; manual review required")
            records.append((int(fields[4]), fields[5].rstrip(".").lower()))
    if not records:
        return []
    priority = min(p for p, _ in records)
    return sorted({host for p, host in records if p == priority})


def addresses(host):
    return {row[4][0] for row in socket.getaddrinfo(host, 25, type=socket.SOCK_STREAM)}


def external_domains(domains, own_addresses, previous, lookup=mx_hosts, resolve=addresses):
    external = []
    for domain in sorted(domains):
        hosts = lookup(domain)
        if not hosts:
            # An absent MX is not evidence that a previously external domain
            # has moved onto this server. Preserve its last safe classification.
            if domain in previous:
                external.append(domain)
            continue
        local = [bool(resolve(host) & own_addresses) for host in hosts]
        if any(local) and not all(local):
            raise RuntimeError(f"Mixed local/external primary MX for {domain}")
        if not any(local):
            external.append(domain)
    return external


def condition(domains):
    for domain in domains:
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]*", domain):
            raise RuntimeError("Invalid domain in routing condition")
    return " || ".join(f"rcpt_domain == '{domain}'" for domain in sorted(domains))


def prepend(expression, old_condition, new_condition, target):
    # Refuse an unfamiliar schema instead of silently replacing user policy.
    if not isinstance(expression, dict) or "else" not in expression:
        raise RuntimeError("Unsupported routing expression; manual review required")
    rules = expression.get("match", {})
    if any(not key.isdigit() for key in rules):
        raise RuntimeError("Unsupported routing rule order")
    retained = [copy.deepcopy(rules[key]) for key in sorted(rules, key=int)
                if rules[key].get("if") not in {old_condition, new_condition}]
    if new_condition:
        retained.insert(0, {"if": new_condition, "then": "'" + target + "'"})
    return {**expression, "match": {str(i): rule for i, rule in enumerate(retained)}}


def call(base, token, method, args):
    request = urllib.request.Request(base.rstrip("/") + "/jmap", data=json.dumps({
        "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
        "methodCalls": [[method, args, "r"]],
    }).encode(), headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        rows = json.load(response).get("methodResponses", [])
    if len(rows) != 1 or rows[0][0] != method:
        raise RuntimeError(f"{method} failed")
    body = rows[0][1]
    if any(body.get(key) for key in ["notCreated", "notUpdated", "notFound"]):
        raise RuntimeError(f"{method} refused requested objects")
    return body


def reconcile(api, state, own_addresses, dry_run=False):
    domains = [d["name"] for d in api("x:Domain/get", {"properties": ["name"]})["list"]]
    external = external_domains(domains, own_addresses, state.get("externalDomains", []))
    routes = api("x:MtaRoute/get", {"properties": ["name", "@type"]})["list"]
    mx = next((r["name"] for r in routes if r["@type"] == "Mx" and r["name"] == "mx-direct"), None)
    if not mx:
        mx = next((r["name"] for r in routes if r["@type"] == "Mx"), None)
    if not mx:
        raise RuntimeError("Direct MX route missing; no relay is configured automatically")
    schedules = api("x:MtaDeliverySchedule/get", {"properties": ["name"]})["list"]
    if not any(s.get("name") == "remote" for s in schedules):
        raise RuntimeError("Remote delivery schedule missing")
    current = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
    new_condition = condition(external)
    patch = {
        "route": prepend(current["route"], state.get("condition"), new_condition, mx),
        "schedule": prepend(current["schedule"], state.get("condition"), new_condition, "remote"),
    }
    changed = any(current.get(key) != value for key, value in patch.items())
    print(json.dumps({"externalDomains": external, "changed": changed, "dryRun": dry_run}))
    if changed and not dry_run:
        api("x:MtaOutboundStrategy/set", {"update": {"singleton": patch}})
        api("x:Action/set", {"create": {"reload-routing": {"@type": "ReloadSettings"}}})
        actual = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
        if any(actual.get(key) != value for key, value in patch.items()):
            raise RuntimeError("Routing update not confirmed")
    return {"externalDomains": external, "condition": new_condition}, current if changed else None


def ensure_logging(api, state_dir, dry_run=False):
    tracers = api("x:Tracer/get", {"properties": ["@type", "path"]})["list"]
    patch = {t["id"]: {"path": "/var/lib/stalwart/logs"} for t in tracers
             if t.get("@type") == "Log" and t.get("path", "").rstrip("/") == "/var/log/stalwart"}
    if patch and not dry_run:
        backup = state_dir / f"tracers-{time.time_ns()}.json"
        backup.write_text(json.dumps(tracers, indent=2) + "\n")
        backup.chmod(0o600)
        api("x:Tracer/set", {"update": patch})
        api("x:Action/set", {"create": {"reload-logging": {"@type": "ReloadSettings"}}})
    print(json.dumps({"persistentLogPathsUpdated": len(patch), "dryRun": dry_run}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--env-file", type=Path, default=Path("/opt/framm/deploy/.generated/env.production"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/framm-mail-routing"))
    args = parser.parse_args()
    values = dict(os.environ)
    for line in args.env_file.read_text().splitlines():
        if line.startswith(("STALWART_API_KEY=", "MAIL_PUBLIC_IP=", "PRIMARY_PLATFORM_DOMAIN=")):
            key, raw = line.split("=", 1)
            parsed = shlex.split(raw)
            if parsed:
                values[key] = parsed[0]
    token = values["STALWART_API_KEY"]
    own = addresses("mail." + values.get("PRIMARY_PLATFORM_DOMAIN", "kod.bzh"))
    if values.get("MAIL_PUBLIC_IP"):
        own.add(values["MAIL_PUBLIC_IP"])
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (args.state_dir / "lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = args.state_dir / "state.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        api = lambda method, args: call(values.get("STALWART_ROUTING_URL", "http://127.0.0.1:8080"), token, method, args)
        # Save the exact pre-change policy before any mutation, including custom rules.
        before = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
        backup = args.state_dir / f"policy-{time.time_ns()}.json"
        if not args.dry_run:
            backup.write_text(json.dumps(before, indent=2) + "\n")
            backup.chmod(0o600)
        new_state, changed = reconcile(api, state, own, args.dry_run)
        if not args.dry_run:
            temporary = state_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(new_state, indent=2) + "\n")
            temporary.chmod(0o600)
            temporary.replace(state_path)
            if not changed:
                backup.unlink()
        ensure_logging(api, args.state_dir, args.dry_run)


if __name__ == "__main__":
    main()
