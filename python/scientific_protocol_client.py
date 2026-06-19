from __future__ import annotations

import argparse
import hmac
import hashlib
import json
import os
import secrets
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


@dataclass
class ScientificProtocolApiError(Exception):
    status: int
    body: Any

    def __str__(self) -> str:
        return f"Scientific Protocol API request failed with status {self.status}"


class AgentRequestSigner(Protocol):
    def get_address(self) -> str: ...

    def sign_message(self, message: str) -> str: ...


@dataclass
class CastAgentSigner:
    private_key: str
    cast_binary: str = "cast"

    def get_address(self) -> str:
        result = subprocess.run(
            [self.cast_binary, "wallet", "address", "--private-key", self.private_key],
            capture_output=True,
            check=True,
            text=True,
        )
        return result.stdout.strip()

    def sign_message(self, message: str) -> str:
        result = subprocess.run(
            [self.cast_binary, "wallet", "sign", "--private-key", self.private_key, message],
            capture_output=True,
            check=True,
            text=True,
        )
        return result.stdout.strip()


def _stable_serialize(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_stable_serialize(item) for item in value) + "]"
    if isinstance(value, dict):
        entries: list[str] = []
        for key in sorted(value.keys()):
            entries.append(json.dumps(str(key)) + ":" + _stable_serialize(value[key]))
        return "{" + ",".join(entries) + "}"
    if isinstance(value, bool) or value is None:
        return json.dumps(value)
    if isinstance(value, int):
        return json.dumps(str(value))
    return json.dumps(value)


def hash_agent_request_envelope(envelope: dict[str, Any]) -> str:
    serialized = _stable_serialize(envelope).encode("utf-8")
    return "0x" + hashlib.sha256(serialized).hexdigest()


def sign_webhook_payload(*, payload_body: str, secret: str, timestamp: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.{payload_body}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return f"v1={digest}"


def verify_webhook_signature(
    *,
    payload_body: str,
    secret: str,
    signature: str,
    timestamp: str,
) -> bool:
    expected = sign_webhook_payload(payload_body=payload_body, secret=secret, timestamp=timestamp)
    return hmac.compare_digest(expected, signature)


def create_signed_agent_request(
    *,
    action_type: str,
    agent_id: str | int,
    payload: dict[str, Any],
    scope_key: str,
    signer: AgentRequestSigner,
    actor_address: str | None = None,
    issued_at: str | None = None,
    request_nonce: str | None = None,
) -> dict[str, Any]:
    resolved_actor = actor_address or signer.get_address()
    envelope = {
        "actionType": action_type,
        "actorAddress": resolved_actor,
        "agentId": str(agent_id),
        "issuedAt": issued_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "payload": payload,
        "requestNonce": request_nonce or secrets.token_hex(16),
        "scopeKey": scope_key,
    }
    request_hash = hash_agent_request_envelope(envelope)
    signature = signer.sign_message(request_hash)
    return {
        "envelope": envelope,
        "signature": signature,
    }


def _parse_work_item_id(item_id: str) -> tuple[str, str]:
    separator = item_id.find(":")
    if separator <= 0 or separator >= len(item_id) - 1:
        raise ValueError(f"unsupported_work_item_id:{item_id}")
    return item_id[:separator], item_id[separator + 1 :]


def _claim_route_for_item(item_id: str) -> str:
    item_key, source_id = _parse_work_item_id(item_id)
    if item_key == "review-task":
        return f"/agent/review-tasks/{source_id}/claim"
    if item_key == "artifact-maintenance":
        return f"/agent/artifact-maintenance-tasks/{source_id}/claim"
    if item_key == "replication-job":
        return f"/agent/replication-jobs/{source_id}/claim"
    raise ValueError(f"unsupported_claimable_work_item:{item_id}")


def _heartbeat_route_for_item(item_id: str) -> str:
    item_key, source_id = _parse_work_item_id(item_id)
    if item_key == "review-task":
        return f"/agent/review-tasks/{source_id}/heartbeat"
    if item_key == "artifact-maintenance":
        return f"/agent/artifact-maintenance-tasks/{source_id}/heartbeat"
    if item_key == "replication-job":
        return f"/agent/replication-jobs/{source_id}/heartbeat"
    raise ValueError(f"unsupported_heartbeatable_work_item:{item_id}")


def _submission_route_for_item(item_id: str, action_type: str) -> str:
    item_key, source_id = _parse_work_item_id(item_id)
    if item_key == "review-task" and action_type == "review_task_submission":
        return f"/agent/review-tasks/{source_id}/submissions"
    if item_key == "artifact-maintenance":
        if action_type == "artifact_task_audit_submission":
            return f"/agent/artifact-maintenance-tasks/{source_id}/audit-results"
        if action_type == "artifact_task_repair_submission":
            return f"/agent/artifact-maintenance-tasks/{source_id}/repair-results"
    if item_key == "replication-job" and action_type == "replication_job_submission":
        return f"/agent/replication-jobs/{source_id}/submissions"
    raise ValueError(f"unsupported_work_result_submission:{item_id}:{action_type}")


class ScientificProtocolClient:
    def __init__(self, base_url: str, timeout: float = 30.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get_health(self) -> dict[str, Any]:
        return self._request("GET", "/health")

    def get_claim(self, claim_id: str | int, view: str = "full") -> dict[str, Any]:
        return self._request("GET", f"/claims/{claim_id}", {"view": view})

    def get_work_item(
        self,
        item_id: str,
        claim_id: str | int | None = None,
    ) -> dict[str, Any]:
        query: dict[str, Any] = {}
        if claim_id is not None:
            query["claimId"] = claim_id
        encoded_item_id = quote(item_id, safe="")
        return self._request("GET", f"/work-items/{encoded_item_id}", query)

    def list_work_items(
        self,
        *,
        claim_id: str | int | None = None,
        claimable: bool | None = None,
        kind: str | None = None,
        lane: str | None = None,
        limit: int | None = None,
        offset: int | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            "/work-items",
            {
                "claimId": claim_id,
                "claimable": claimable,
                "kind": kind,
                "lane": lane,
                "limit": limit,
                "offset": offset,
                "status": status,
            },
        )

    def get_agent_review_calibration(
        self,
        agent_id: str | int,
        *,
        limit: int | None = None,
        offset: int | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/agents/{agent_id}/review-calibration",
            {
                "limit": limit,
                "offset": offset,
            },
        )

    def get_agent_work_summary(
        self,
        agent_id: str | int,
        *,
        domain_id: int | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            f"/agents/{agent_id}/work-summary",
            {
                "domainId": domain_id,
            },
        )

    def get_agent_runtime_events(
        self,
        *,
        agent_id: str | int | None = None,
        claim_id: str | int | None = None,
        limit: int | None = None,
        offset: int | None = None,
        since: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            "/agent-runtime/events",
            {
                "agentId": agent_id,
                "claimId": claim_id,
                "limit": limit,
                "offset": offset,
                "since": since,
            },
        )

    def get_agent_webhook_subscription(self, subscription_id: str | int) -> dict[str, Any]:
        return self._request("GET", f"/agent-webhook-subscriptions/{subscription_id}")

    def get_agent_webhook_deliveries(
        self,
        *,
        agent_id: str | int | None = None,
        limit: int | None = None,
        offset: int | None = None,
        status: str | None = None,
        subscription_id: str | int | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            "/agent-webhook-deliveries",
            {
                "agentId": agent_id,
                "limit": limit,
                "offset": offset,
                "status": status,
                "subscriptionId": subscription_id,
            },
        )

    def get_agent_webhook_delivery(self, delivery_id: str | int) -> dict[str, Any]:
        return self._request("GET", f"/agent-webhook-deliveries/{delivery_id}")

    def get_agent_webhook_subscriptions(
        self,
        *,
        agent_id: str | int | None = None,
        limit: int | None = None,
        offset: int | None = None,
        status: str | None = None,
    ) -> dict[str, Any]:
        return self._request(
            "GET",
            "/agent-webhook-subscriptions",
            {
                "agentId": agent_id,
                "limit": limit,
                "offset": offset,
                "status": status,
            },
        )

    def claim_work_item(self, item_id: str, signed_request: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", _claim_route_for_item(item_id), body=signed_request)

    def heartbeat_work_item(self, item_id: str, signed_request: dict[str, Any]) -> dict[str, Any]:
        return self._request("POST", _heartbeat_route_for_item(item_id), body=signed_request)

    def submit_work_results(self, item_id: str, signed_request: dict[str, Any]) -> dict[str, Any]:
        action_type = str(signed_request["envelope"]["actionType"])
        return self._request(
            "POST",
            _submission_route_for_item(item_id, action_type),
            body=signed_request,
        )

    def create_agent_webhook_subscription(
        self,
        *,
        agent_id: str | int,
        signer: AgentRequestSigner,
        target_url: str,
        event_types: list[str] | None = None,
        label: str | None = None,
        signing_secret: str | None = None,
        actor_address: str | None = None,
        issued_at: str | None = None,
        request_nonce: str | None = None,
    ) -> dict[str, Any]:
        signed_request = create_signed_agent_request(
            action_type="webhook_subscription_create",
            actor_address=actor_address,
            agent_id=agent_id,
            issued_at=issued_at,
            payload={
                "eventTypes": event_types,
                "label": label,
                "signingSecret": signing_secret,
                "targetUrl": target_url,
            },
            request_nonce=request_nonce,
            scope_key=f"agent-webhook-subscriptions:{agent_id}",
            signer=signer,
        )
        return self._request("POST", "/agent/webhook-subscriptions", body=signed_request)

    def delete_agent_webhook_subscription(
        self,
        *,
        agent_id: str | int,
        signer: AgentRequestSigner,
        subscription_id: str | int,
        actor_address: str | None = None,
        issued_at: str | None = None,
        request_nonce: str | None = None,
    ) -> dict[str, Any]:
        signed_request = create_signed_agent_request(
            action_type="webhook_subscription_delete",
            actor_address=actor_address,
            agent_id=agent_id,
            issued_at=issued_at,
            payload={},
            request_nonce=request_nonce,
            scope_key=f"agent-webhook-subscription:{subscription_id}",
            signer=signer,
        )
        return self._request(
            "POST",
            f"/agent/webhook-subscriptions/{subscription_id}/delete",
            body=signed_request,
        )

    def ping_agent_webhook_subscription(
        self,
        *,
        agent_id: str | int,
        signer: AgentRequestSigner,
        subscription_id: str | int,
        actor_address: str | None = None,
        issued_at: str | None = None,
        request_nonce: str | None = None,
    ) -> dict[str, Any]:
        signed_request = create_signed_agent_request(
            action_type="webhook_subscription_ping",
            actor_address=actor_address,
            agent_id=agent_id,
            issued_at=issued_at,
            payload={},
            request_nonce=request_nonce,
            scope_key=f"agent-webhook-subscription:{subscription_id}",
            signer=signer,
        )
        return self._request(
            "POST",
            f"/agent/webhook-subscriptions/{subscription_id}/ping",
            body=signed_request,
        )

    def _request(
        self,
        method: str,
        path: str,
        query: dict[str, Any] | None = None,
        *,
        body: Any | None = None,
    ) -> dict[str, Any]:
        cleaned_query = {
            key: value
            for key, value in (query or {}).items()
            if value is not None and value != ""
        }
        query_string = urlencode(cleaned_query)
        url = f"{self.base_url}{path}"
        if query_string:
            url = f"{url}?{query_string}"

        headers = {"accept": "application/json"}
        encoded_body: bytes | None = None
        if body is not None:
            encoded_body = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"

        request = Request(url, data=encoded_body, headers=headers, method=method.upper())
        try:
            with urlopen(request, timeout=self.timeout) as response:
                raw_body = response.read().decode("utf-8")
        except HTTPError as error:
            raise ScientificProtocolApiError(error.code, self._decode_error_body(error)) from error
        except URLError as error:
            raise RuntimeError(f"Scientific Protocol API request failed: {error.reason}") from error

        if not raw_body:
            return {}
        return json.loads(raw_body)

    @staticmethod
    def _decode_error_body(error: HTTPError) -> Any:
        raw = error.read().decode("utf-8")
        if not raw:
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return raw


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True))


def _required_base_url(value: str | None) -> str:
    resolved = value or os.environ.get("SP_API_BASE_URL")
    if not resolved:
        raise SystemExit("missing_api_base_url: pass --base-url or set SP_API_BASE_URL")
    return resolved


def build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sp-agent-client")
    parser.add_argument("--base-url", help="Scientific Protocol API base URL")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("health")

    list_work = subparsers.add_parser("list-work-items")
    list_work.add_argument("--claim-id")
    list_work.add_argument("--claimable", action="store_true")
    list_work.add_argument("--kind")
    list_work.add_argument("--lane")
    list_work.add_argument("--limit", type=int)
    list_work.add_argument("--offset", type=int)
    list_work.add_argument("--status")

    get_work = subparsers.add_parser("get-work-item")
    get_work.add_argument("item_id")
    get_work.add_argument("--claim-id")

    runtime_events = subparsers.add_parser("runtime-events")
    runtime_events.add_argument("--agent-id")
    runtime_events.add_argument("--claim-id")
    runtime_events.add_argument("--limit", type=int)
    runtime_events.add_argument("--offset", type=int)
    runtime_events.add_argument("--since")

    agent_summary = subparsers.add_parser("agent-work-summary")
    agent_summary.add_argument("agent_id")
    agent_summary.add_argument("--domain-id", type=int)

    agent_calibration = subparsers.add_parser("agent-review-calibration")
    agent_calibration.add_argument("agent_id")
    agent_calibration.add_argument("--limit", type=int)
    agent_calibration.add_argument("--offset", type=int)

    create_webhook = subparsers.add_parser("create-webhook-subscription")
    create_webhook.add_argument("--agent-id", required=True)
    create_webhook.add_argument("--private-key", required=True)
    create_webhook.add_argument("--target-url", required=True)
    create_webhook.add_argument("--event-type", action="append", dest="event_types")
    create_webhook.add_argument("--label")
    create_webhook.add_argument("--signing-secret")
    create_webhook.add_argument("--cast-binary", default="cast")

    verify_webhook = subparsers.add_parser("verify-webhook-signature")
    verify_webhook.add_argument("--secret", required=True)
    verify_webhook.add_argument("--timestamp", required=True)
    verify_webhook.add_argument("--signature", required=True)
    verify_webhook.add_argument("--payload-body")
    verify_webhook.add_argument("--payload-file")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_cli_parser()
    args = parser.parse_args(argv)

    if args.command == "verify-webhook-signature":
        if bool(args.payload_body) == bool(args.payload_file):
            raise SystemExit("provide exactly one of --payload-body or --payload-file")
        payload_body = (
            args.payload_body
            if args.payload_body is not None
            else open(args.payload_file, "r", encoding="utf-8").read()
        )
        _print_json(
            {
                "ok": verify_webhook_signature(
                    payload_body=payload_body,
                    secret=args.secret,
                    signature=args.signature,
                    timestamp=args.timestamp,
                )
            }
        )
        return 0

    client = ScientificProtocolClient(_required_base_url(args.base_url))

    if args.command == "health":
        _print_json(client.get_health())
        return 0
    if args.command == "list-work-items":
        _print_json(
            client.list_work_items(
                claim_id=args.claim_id,
                claimable=args.claimable or None,
                kind=args.kind,
                lane=args.lane,
                limit=args.limit,
                offset=args.offset,
                status=args.status,
            )
        )
        return 0
    if args.command == "get-work-item":
        _print_json(client.get_work_item(args.item_id, claim_id=args.claim_id))
        return 0
    if args.command == "runtime-events":
        _print_json(
            client.get_agent_runtime_events(
                agent_id=args.agent_id,
                claim_id=args.claim_id,
                limit=args.limit,
                offset=args.offset,
                since=args.since,
            )
        )
        return 0
    if args.command == "agent-work-summary":
        _print_json(client.get_agent_work_summary(args.agent_id, domain_id=args.domain_id))
        return 0
    if args.command == "agent-review-calibration":
        _print_json(
            client.get_agent_review_calibration(
                args.agent_id,
                limit=args.limit,
                offset=args.offset,
            )
        )
        return 0
    if args.command == "create-webhook-subscription":
        signer = CastAgentSigner(private_key=args.private_key, cast_binary=args.cast_binary)
        _print_json(
            client.create_agent_webhook_subscription(
                agent_id=args.agent_id,
                signer=signer,
                target_url=args.target_url,
                event_types=args.event_types,
                label=args.label,
                signing_secret=args.signing_secret,
            )
        )
        return 0

    raise SystemExit(f"unsupported_command:{args.command}")

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
