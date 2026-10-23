#!/usr/bin/env python3
"""Install native, loopback-only queue binding and signed receipts."""
import hashlib
import hmac
import json
import os
import urllib.request


def configure():
    key = os.environ["STALWART_API_KEY"]
    secret = hmac.new(key.encode(), b"kod-mail-receipts-v1", hashlib.sha256).hexdigest()

    def jmap(calls):
        req = urllib.request.Request("http://127.0.0.1:8080/jmap", data=json.dumps({"using": ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], "methodCalls": calls}).encode(), headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as response:
            rows = json.load(response)["methodResponses"]
        for name, body, *_ in rows:
            if name == "error" or body.get("notCreated") or body.get("notUpdated"):
                raise RuntimeError("Mail receipt configuration failed")
        return rows

    settings = {
        "x:MtaHook": {"url": "http://127.0.0.1:8791/bind", "stages": {"data": True},
                      "enable": {"else": "!is_empty(authenticated_as)"}, "tempFailOnError": False,
                      "timeout": 5000, "maxResponseSize": 4096,
                      "httpAuth": {"@type": "Bearer", "bearerToken": {"@type": "Value", "secret": secret}}, "httpHeaders": {}},
        "x:WebHook": {"url": "http://127.0.0.1:8791/events", "enable": True, "lossy": False,
                      "events": {"delivery.delivered": True, "delivery.dsn-perm-fail": True, "delivery.dsn-temp-fail": True},
                      "eventsPolicy": "include", "throttle": 1000, "timeout": 5000, "discardAfter": 604800000,
                      "signatureKey": {"@type": "Value", "secret": secret}, "httpAuth": {"@type": "Unauthenticated"}, "httpHeaders": {}},
    }
    for kind, desired in settings.items():
        rows = jmap([[kind + "/query", {}, "q"], [kind + "/get", {"#ids": {"resultOf": "q", "name": kind + "/query", "path": "/ids"}}, "g"]])
        matching = [item for item in rows[1][1]["list"] if item.get("url") == desired["url"]]
        if len(matching) > 1:
            raise RuntimeError("Duplicate receipt hook: manual review required")
        if matching:
            # Secrets can be redacted on read; update this dedicated hook only.
            jmap([[kind + "/set", {"update": {matching[0]["id"]: desired}}, "s"]])
        else:
            jmap([[kind + "/set", {"create": {"kod-receipts": desired}}, "s"]])
    jmap([["x:Action/set", {"create": {"receipt-reload": {"@type": "ReloadSettings"}}}, "a"]])
    print("Native mail receipt hooks configured (local only)")


if __name__ == "__main__":
    configure()
