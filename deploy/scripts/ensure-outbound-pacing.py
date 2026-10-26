#!/usr/bin/env python3
"""Pace native remote deliveries without rejecting API submissions or replaying mail."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import shlex
import time
import urllib.request

MARKER = "KOD managed ordinary outbound queue pacing v1"
MATCH = {"match": {}, "else": "source != 'dsn' && source != 'report'"}


def reconcile(api, backup, count=20, dry_run=False, enabled=True):
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 1000000:
        raise ValueError("Invalid delivery cadence")
    rows = api("x:MtaOutboundThrottle/get", {})["list"]
    owned = [row for row in rows if row.get("description") == MARKER]
    if len(owned) > 1:
        raise RuntimeError("Duplicate managed pacing rules require review")
    # /get defaults need not be present in stored objects: compare owned fields only.
    desired = {"description": MARKER, "enable": enabled, "key": {"mx": True}, "match": MATCH, "rate": {"count": count, "period": 60000}}
    changed = (not owned and enabled) or bool(owned and any(owned[0].get(k) != v for k, v in desired.items()))
    result = {"enabled": enabled, "changed": changed, "dryRun": dry_run, "operationsPerMxPerMinute": count,
              "coverage": "ordinary remote SMTP delivery attempts; DSN/report excluded", "apiSubmissionQuota": None,
              "messagesResubmitted": False, "runtimePacingObserved": False, "otherRulesPreserved": len(rows) - len(owned)}
    if not changed or dry_run:
        return result
    backup({"ownedRule": owned, "desired": desired})
    if owned:
        api("x:MtaOutboundThrottle/set", {"update": {owned[0]["id"]: desired}})
    else:
        api("x:MtaOutboundThrottle/set", {"create": {"kod-pacing": desired}})
    api("x:Action/set", {"create": {"pacing-reload": {"@type": "ReloadSettings"}}})
    after = api("x:MtaOutboundThrottle/get", {})["list"]
    actual = [row for row in after if row.get("description") == MARKER]
    if len(actual) != 1 or any(actual[0].get(k) != v for k, v in desired.items()):
        raise RuntimeError("Pacing configuration readback failed")
    before_other = {row["id"]: row for row in rows if row.get("description") != MARKER}
    after_other = {row["id"]: row for row in after if row.get("description") != MARKER}
    if before_other != after_other:
        raise RuntimeError("Other pacing rules changed concurrently; review required")
    return {**result, "configurationReadBackVerified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path("/opt/framm/deploy/.generated/env.production"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/framm-mail-provider-policy"))
    parser.add_argument("--operations-per-minute", type=int, default=20)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--disable", action="store_true")
    args = parser.parse_args()
    values = dict(os.environ)
    for line in args.env_file.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, value = line.removeprefix("export ").split("=", 1)
        tokens = shlex.split(value, comments=True)
        values.setdefault(name.strip(), tokens[0] if tokens else "")

    def api(method, arguments):
        req = urllib.request.Request("http://127.0.0.1:8080/jmap", data=json.dumps({"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": [[method, arguments, "r"]]}).encode(), headers={"Authorization": "Bearer " + values["STALWART_API_KEY"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            rows = json.load(response).get("methodResponses", [])
        if len(rows) != 1 or rows[0][0] != method or any(rows[0][1].get(k) for k in ["notCreated", "notUpdated", "notFound"]):
            raise RuntimeError("Pacing operation failed")
        return rows[0][1]

    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    def backup(value):
        with open(args.state_dir / f"outbound-pacing-{time.time_ns()}.json", "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(value, stream)
    with (args.state_dir / "policy.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(reconcile(api, backup, args.operations_per_minute, args.dry_run, not args.disable)))


if __name__ == "__main__":
    main()
