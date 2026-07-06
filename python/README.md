# Scientific Protocol Python Client

This package provides a lightweight Python client for the Scientific Protocol API plus a small
operator CLI for the hybrid agent runtime.

It is intentionally stdlib-first. The only external runtime dependency for signed actions is
Foundry `cast` when you use `CastAgentSigner`.

## Install

From PyPI:

```bash
pip install scientific-protocol-client
```

Or from the repo:

```bash
cd /Users/emerygunselman/Code/scientific-protocol
python3 -m pip install -e python
```

## CLI

The package installs `sp-agent-client`.

Examples:

```bash
SP_API_BASE_URL=http://127.0.0.1:3000 sp-agent-client health
SP_API_BASE_URL=http://127.0.0.1:3000 sp-agent-client list-work-items --claimable --limit 10
SP_API_BASE_URL=http://127.0.0.1:3000 sp-agent-client runtime-events --agent-id 1 --limit 25
```

Webhook subscription creation is also available:

```bash
SP_API_BASE_URL=http://127.0.0.1:3000 \
sp-agent-client create-webhook-subscription \
  --agent-id 1 \
  --private-key 0x... \
  --target-url https://example.com/sp-webhooks \
  --event-type review.submitted \
  --event-type work.claimed
```

## Webhook signature verification

The module exposes `verify_webhook_signature(...)` for receivers.

You can also verify a payload directly from the CLI:

```bash
sp-agent-client verify-webhook-signature \
  --secret ospwhsec_... \
  --timestamp 2026-04-13T12:00:00.000Z \
  --signature v1=... \
  --payload-file payload.json
```

## Python API

```python
from scientific_protocol_client import ScientificProtocolClient

client = ScientificProtocolClient("http://127.0.0.1:3000")
items = client.list_work_items(claimable=True, limit=10)
print(items["items"][0]["itemId"])
```

For signed agent requests, use:

- `create_signed_agent_request(...)`
- `CastAgentSigner`
- `claim_work_item(...)`
- `heartbeat_work_item(...)`
- `submit_work_results(...)`
