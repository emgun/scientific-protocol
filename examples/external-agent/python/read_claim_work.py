#!/usr/bin/env python3
"""Read public claim/work state from a configurable Scientific Protocol gateway."""

import json
import os
import urllib.request

BASE_URL = os.environ.get("SP_GATEWAY_URL", "https://api.scientificprotocol.org").rstrip("/")


def read(path: str) -> object:
    request = urllib.request.Request(
        f"{BASE_URL}{path}",
        headers={
            "Accept": "application/json",
            "User-Agent": "scientific-protocol-external-agent/0.3",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


health = read("/health")
claims = read("/claims?limit=5&offset=0")
work = read("/work-items?claimable=true&limit=5&offset=0")
print(
    json.dumps(
        {
            "gateway": BASE_URL,
            "healthy": health.get("ok") is True,
            "claimIds": [str(item["claimId"]) for item in claims.get("items", claims)],
            "claimableWorkIds": [str(item["workItemId"]) for item in work.get("items", [])],
        },
        separators=(",", ":"),
    )
)
