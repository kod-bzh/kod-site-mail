#!/usr/bin/env python3
"""Allow 50 MB decoded attachments plus MIME overhead; preserve higher limits."""
import json
import os
import urllib.request

base = os.environ.get("STALWART_URL", "http://127.0.0.1:8080").rstrip("/")
key = os.environ["STALWART_API_KEY"]


def jmap(calls):
    request = urllib.request.Request(
        base + "/jmap", data=json.dumps({
            "using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
            "methodCalls": calls,
        }).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)["methodResponses"]
    for name, body, *_ in result:
        if name == "error" or body.get("notUpdated") or body.get("notCreated"):
            raise RuntimeError(f"{name}: {body}")
    return result


limits = {
    "x:Email": {"maxAttachmentSize": 75_000_000, "maxMessageSize": 75_000_000},
    "x:Jmap": {"maxUploadSize": 50_000_000, "uploadQuota": 100_000_000},
}
changed = False
for kind, minimums in limits.items():
    current = jmap([[kind + "/get", {"ids": ["singleton"], "properties": list(minimums)}, "g"]])[0][1]["list"][0]
    patch = {name: value for name, value in minimums.items() if current.get(name, 0) < value}
    if patch:
        jmap([[kind + "/set", {"update": {"singleton": patch}}, "s"]])
        changed = True
if changed:
    jmap([["x:Action/set", {"create": {"framm-attachment-limits": {"@type": "ReloadSettings"}}}, "a"]])
print("Stalwart attachment limits ready (50 MB decoded plus MIME overhead)")
