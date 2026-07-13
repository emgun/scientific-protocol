import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getBytes, Wallet } from "ethers";
import { authenticateSignedPublicWriteRequestBody } from "../src/api/auth.js";
import type { ApiDependencies } from "../src/api/dependencies.js";
import {
  hashPublicWriteEnvelope,
  type PublicWriteEnvelope,
  type PublicWriteRequestView,
} from "../src/shared/public-write-requests.js";

async function signed(envelope: PublicWriteEnvelope, wallet: Wallet) {
  return {
    envelope,
    signature: await wallet.signMessage(getBytes(hashPublicWriteEnvelope(envelope))),
  };
}

describe("public write idempotency", () => {
  it("resumes an old exact signed request but rejects a new old request", async () => {
    const wallet = Wallet.createRandom();
    const envelope: PublicWriteEnvelope = {
      actionType: "claim_create",
      actorAddress: wallet.address,
      chainId: 31337,
      issuedAt: "2025-01-01T00:00:00.000Z",
      payload: {
        artifactSha256: `0x${"ab".repeat(32)}`,
        artifactUri: "ipfs://bafy",
        statement: "x",
      },
      requestNonce: "old-exact",
      scopeKey: `submit:${wallet.address.toLowerCase()}`,
    };
    const body = await signed(envelope, wallet);
    const requestHash = hashPublicWriteEnvelope(envelope);
    const recorded: PublicWriteRequestView = {
      actionType: envelope.actionType,
      actorAddress: envelope.actorAddress,
      chainId: envelope.chainId,
      createdAt: envelope.issuedAt,
      outcomeDetail: "reconciliation_required",
      payload: envelope.payload,
      requestHash,
      requestId: "77",
      requestNonce: envelope.requestNonce,
      scopeKey: envelope.scopeKey,
      signature: body.signature,
      status: "rejected",
      updatedAt: envelope.issuedAt,
    };
    const dependencies = {
      readPublicWriteRequestByHash: async () => recorded,
      insertPublicWriteRequest: async () => {
        throw new Error("must not insert exact replay");
      },
    } as unknown as ApiDependencies;
    const resumed = await authenticateSignedPublicWriteRequestBody(
      dependencies,
      {} as never,
      body,
      { actionType: "claim_create", allowRecordedReplay: true, chainId: 31337 },
    );
    assert.equal(resumed.acceptedRequestId, "77");

    await assert.rejects(
      authenticateSignedPublicWriteRequestBody(
        {
          ...dependencies,
          readPublicWriteRequestByHash: async () => undefined,
        },
        {} as never,
        body,
        { actionType: "claim_create", allowRecordedReplay: true, chainId: 31337 },
      ),
      /public_write_request_expired/,
    );
  });

  it("does not replay accepted requests for actions without an idempotent saga", async () => {
    const wallet = Wallet.createRandom();
    const envelope: PublicWriteEnvelope = {
      actionType: "source_confirm",
      actorAddress: wallet.address,
      chainId: 31337,
      issuedAt: new Date().toISOString(),
      payload: { sourceId: "source-1" },
      requestNonce: "already-accepted",
      scopeKey: "source:source-1",
    };
    const body = await signed(envelope, wallet);
    const collision = Object.assign(new Error("unique actor nonce"), { code: "23505" });
    const dependencies = {
      readPublicWriteRequestByHash: async () => ({ requestId: "77" }),
      insertPublicWriteRequest: async () => {
        throw collision;
      },
    } as unknown as ApiDependencies;

    await assert.rejects(
      authenticateSignedPublicWriteRequestBody(dependencies, {} as never, body, {
        actionType: "source_confirm",
        chainId: 31337,
      }),
      /public_write_request_duplicate/,
    );
  });

  it("rejects a different payload that collides on actor and nonce", async () => {
    const wallet = Wallet.createRandom();
    const envelope: PublicWriteEnvelope = {
      actionType: "claim_create",
      actorAddress: wallet.address,
      chainId: 31337,
      issuedAt: new Date().toISOString(),
      payload: {
        artifactSha256: `0x${"cd".repeat(32)}`,
        artifactUri: "ipfs://different",
        statement: "different",
      },
      requestNonce: "same-nonce",
      scopeKey: `submit:${wallet.address.toLowerCase()}`,
    };
    const collision = Object.assign(new Error("unique actor nonce"), { code: "23505" });
    const dependencies = {
      readPublicWriteRequestByHash: async () => undefined,
      insertPublicWriteRequest: async () => {
        throw collision;
      },
    } as unknown as ApiDependencies;
    await assert.rejects(
      authenticateSignedPublicWriteRequestBody(
        dependencies,
        {} as never,
        await signed(envelope, wallet),
        { actionType: "claim_create", chainId: 31337 },
      ),
      /public_write_request_duplicate/,
    );
  });
});
