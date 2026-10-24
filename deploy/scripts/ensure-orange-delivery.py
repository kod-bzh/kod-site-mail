#!/usr/bin/env python3
"""Isolate ordinary Orange/Wanadoo deliveries on a two-thread queue.

Single MTA node policy. Preserves existing SMTP routes, TLS, retries and DSN/report
schedules. Does not submit, cancel, reschedule or replay any queued message.
"""
import argparse
import copy
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import time
import urllib.request

NAME = "kod-orng"
MARKER = "KOD managed Orange/Wanadoo ordinary mail safety"
CONDITION = "(rcpt_domain == 'orange.fr' || rcpt_domain == 'wanadoo.fr') && !is_local_domain(rcpt_domain) && source != 'dsn' && source != 'report'"


def schedule_expression(current, enabled):
    if not isinstance(current, dict) or not isinstance(current.get("else"), str) or (enabled and current["else"] != "'remote'") or not isinstance(current.get("match", {}), dict):
        raise RuntimeError("Unfamiliar scheduling policy; manual review required")
    rules = current.get("match", {})
    if any(not key.isdigit() for key in rules):
        raise RuntimeError("Unfamiliar scheduling order")
    retained = []
    for key in sorted(rules, key=int):
        rule = rules[key]
        if rule.get("if") == CONDITION:
            if rule.get("then") != f"'{NAME}'":
                raise RuntimeError("Managed condition has a different target")
            continue
        condition = rule.get("if", "")
        # Never override a custom provider, priority, or global schedule.
        standard = condition in ["is_local_domain(rcpt_domain)", "source == 'dsn'", "source == 'report'"]
        domains = re.fullmatch(r"rcpt_domain == '[a-z0-9.-]+'(?: \|\| rcpt_domain == '[a-z0-9.-]+')*", condition)
        if enabled and not standard and (not domains or any(domain in ["orange.fr", "wanadoo.fr"] for domain in re.findall(r"'([^']+)'", condition))):
            raise RuntimeError("Custom scheduling rule needs manual review")
        retained.append(copy.deepcopy(rule))
    if enabled:
        retained.insert(0, {"if": CONDITION, "then": f"'{NAME}'"})
    return {**current, "match": {str(i): value for i, value in enumerate(retained)}}


def reconcile(api, backup, dry_run=False, enabled=True):
    strategy = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
    desired = schedule_expression(strategy["schedule"], enabled)
    if not enabled:
        changed = desired != strategy["schedule"]
        if changed and not dry_run:
            backup({"schedule": strategy["schedule"]})
            api("x:MtaOutboundStrategy/set", {"update": {"singleton": {"schedule": desired}}})
            api("x:Action/set", {"create": {"orange-reload": {"@type": "ReloadSettings"}}})
            actual = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
            if actual["schedule"] != desired or any(actual.get(k) != strategy.get(k) for k in ["route", "tls", "connection"]):
                raise RuntimeError("Provider rule removal not confirmed")
        return {"enabled": False, "changed": changed, "queuedMessagesTouched": False}
    queues = api("x:MtaVirtualQueue/get", {})["list"]
    schedules = api("x:MtaDeliverySchedule/get", {})["list"]
    own_queues = [q for q in queues if q["name"] == NAME]
    own_schedules = [s for s in schedules if s["name"] == NAME]
    if len(own_queues) > 1 or len(own_schedules) > 1 or any(row.get("description") != MARKER for row in own_queues + own_schedules):
        raise RuntimeError("Provider policy name already used by an unmanaged object")
    remote = [s for s in schedules if s["name"] == "remote"]
    if len(remote) != 1:
        raise RuntimeError("Default remote schedule unavailable")
    queue = {"name": NAME, "description": MARKER, "threadsPerNode": 2}
    schedule = {key: copy.deepcopy(value) for key, value in remote[0].items() if key not in ["id", "name", "description", "queueId"]}
    schedule.update(name=NAME, description=MARKER)
    schedule["queueId"] = own_queues[0]["id"] if own_queues else "pending-create"
    changed = desired != strategy["schedule"] or not own_queues or not own_schedules
    changed |= bool(own_queues and any(own_queues[0].get(k) != v for k, v in queue.items()))
    changed |= bool(own_schedules and any(own_schedules[0].get(k) != v for k, v in schedule.items()))
    result = {"enabled": True, "changed": changed, "dryRun": dry_run, "threadsPerMtaNode": 2,
              "coverage": "ordinary_mail_to_orange.fr_and_wanadoo.fr; DSN/report/local delivery unchanged",
              "queuedMessagesTouched": False, "runtimeDeliveryObserved": False}
    if not changed or dry_run:
        return result
    backup({"schedule": strategy["schedule"], "managedQueue": own_queues, "managedSchedule": own_schedules})
    if own_queues:
        api("x:MtaVirtualQueue/set", {"update": {own_queues[0]["id"]: queue}})
    else:
        created = api("x:MtaVirtualQueue/set", {"create": {"orange-queue": queue}})
        schedule["queueId"] = created["created"]["orange-queue"]["id"]
    if own_schedules:
        api("x:MtaDeliverySchedule/set", {"update": {own_schedules[0]["id"]: schedule}})
    else:
        api("x:MtaDeliverySchedule/set", {"create": {"orange-schedule": schedule}})
    # Do not clobber changes made after the initial read (routing reconciler included).
    latest = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
    if latest["schedule"] != strategy["schedule"]:
        raise RuntimeError("Scheduling changed concurrently; unused provider objects left intact")
    api("x:MtaOutboundStrategy/set", {"update": {"singleton": {"schedule": desired}}})
    api("x:Action/set", {"create": {"orange-reload": {"@type": "ReloadSettings"}}})
    actual = api("x:MtaOutboundStrategy/get", {"ids": ["singleton"]})["list"][0]
    if actual["schedule"] != desired or any(actual.get(k) != strategy.get(k) for k in ["route", "tls", "connection"]):
        raise RuntimeError("Provider policy verification failed")
    actual_queue = next(q for q in api("x:MtaVirtualQueue/get", {})["list"] if q["name"] == NAME)
    actual_schedule = next(s for s in api("x:MtaDeliverySchedule/get", {})["list"] if s["name"] == NAME)
    if any(actual_queue.get(k) != v for k, v in queue.items()) or any(actual_schedule.get(k) != v for k, v in schedule.items()):
        raise RuntimeError("Provider queue/schedule configuration not confirmed")
    return {**result, "configurationReadBackVerified": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path("/opt/framm/deploy/.generated/env.production"))
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/framm-mail-provider-policy"))
    parser.add_argument("--routing-state-dir", type=Path, default=Path("/var/lib/framm-mail-routing"))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--disable", action="store_true", help="Remove only the managed rule; retain queue objects for drainage")
    args = parser.parse_args()
    values = dict(os.environ)
    for line in args.env_file.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
            continue
        name, value = line.removeprefix("export ").split("=", 1)
        tokens = shlex.split(value, comments=True)
        values.setdefault(name.strip(), tokens[0] if tokens else "")

    def api(method, arguments):
        req = urllib.request.Request("http://127.0.0.1:8080/jmap", data=json.dumps({"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
            "methodCalls": [[method, arguments, "r"]]}).encode(), headers={"Authorization": "Bearer " + values["STALWART_API_KEY"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            rows = json.load(response).get("methodResponses", [])
        if len(rows) != 1 or rows[0][0] != method or any(rows[0][1].get(k) for k in ["notCreated", "notUpdated", "notFound"]):
            raise RuntimeError("Provider configuration operation failed")
        return rows[0][1]

    args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    def backup(value):
        path = args.state_dir / f"orange-{time.time_ns()}.json"
        with path.open("x", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
            json.dump(value, stream)
    with (args.state_dir / "policy.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        # Share the production routing reconciler's lock, not merely our own.
        args.routing_state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        with (args.routing_state_dir / "lock").open("w") as routing_lock:
            fcntl.flock(routing_lock, fcntl.LOCK_EX)
            print(json.dumps(reconcile(api, backup, args.dry_run, not args.disable)))


if __name__ == "__main__":
    main()
