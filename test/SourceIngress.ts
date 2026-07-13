import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import { consumeConfiguredRateLimit } from "../src/api/rate-limit.js";
import type { ArtifactDraftInput, ArtifactIngestionResult } from "../src/artifacts/ingestion.js";
import { upsertPersistedArtifact } from "../src/coordinator/store.js";
import { migrateReadModelDb } from "../src/indexer/store.js";
import {
  assertPublicWriteRequestExecution,
  insertPublicWriteRequest,
  markPublicWriteRequestAccepted,
  markPublicWriteRequestPending,
  markPublicWriteRequestRejected,
  readPublicWriteRequest,
  releasePublicWriteRequestExecution,
  renewPublicWriteRequestExecution,
  reservePublicWriteRequestExecution,
} from "../src/shared/public-write-requests.js";
import {
  attemptSourceAutoPublication,
  type SourceAutoPublicationDependencies,
} from "../src/sources/auto-publish.js";
import {
  canonicalizeSourceLocator,
  decideSourceAutoPublication,
} from "../src/sources/canonicalize.js";
import {
  confirmSourcePublication,
  type ManualSourcePublicationDependencies,
} from "../src/sources/manual-publication.js";
import { sourcePublicationDomainId } from "../src/sources/publication.js";
import { ingestSource } from "../src/sources/service.js";
import {
  insertSourceExtractionCandidate,
  prepareSourceStore,
  readSourceIngestionAttempt,
  readSourcePublicationAttempt,
  readSourceSubmissionRecordsPage,
  reserveSourceIngestionAttempt,
  upsertSourceRecord,
} from "../src/sources/store.js";
import type { SourceExtractionCandidate } from "../src/sources/types.js";
import { probeDatabase } from "./helpers/database-availability.js";

const database = await probeDatabase();

function makeStubIngestionResult(sourceLocator: string): ArtifactIngestionResult {
  const digest = (suffix: string) =>
    createHash("sha256").update(`${sourceLocator}:${suffix}`).digest("hex");
  return {
    artifactType: 5,
    extractionArtifact: {
      artifactKey: "artifact-extraction-stub",
      byteLength: 1,
      contentType: "application/json",
      kind: "claim-draft-extraction",
      sha256: digest("extraction"),
      storagePath: "artifact-extraction-stub.json",
    },
    preview: {
      candidateStatements: [],
      extractedTextPreview: "",
      metadata: "{}",
      methodology: "stub",
      predictionHooks: "stub",
      scope: "stub",
      sourceDescriptor: sourceLocator,
      statement: "stub",
      summary: "stub",
      title: "stub",
    },
    snapshotArtifact: {
      artifactKey: "artifact-snapshot-stub",
      byteLength: 1,
      contentType: "text/plain; charset=utf-8",
      kind: "artifact-source-snapshot",
      sha256: digest("snapshot"),
      storagePath: "artifact-snapshot-stub.txt",
    },
    sourceLocator,
    sourceType: "url",
    sourceVersion: {
      cid: null,
      commitHash: null,
      contentType: "text/plain; charset=utf-8",
      extension: "txt",
      finalUrl: null,
      ref: null,
    },
  };
}

describe("source ingress", { skip: database.skipReason }, () => {
  it("resumes manual confirmation from the durable claim-ready checkpoint", async () => {
    const pool = await prepareSourceStore();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-manual-publication-"));
    const actor = `0x${"33".repeat(20)}`;
    const source = await upsertSourceRecord(pool, {
      canonicalSourceKey: `test:manual-publication:${Date.now()}`,
      discoveryMode: "user_submitted",
      sourceMetadata: { locator: "ipfs://manual-publication-test", title: "Manual test" },
      sourceType: "url",
      status: "ready_for_publication",
      submittedByActor: actor,
    });
    const candidate = await insertSourceExtractionCandidate(pool, {
      anchors: [{ label: "result", text: "The manual result is reproducible." }],
      candidateId: "unused",
      claimType: "computational",
      confidenceBps: 8_500,
      createdAt: "2026-07-10T00:00:00.000Z",
      methodology: "Manual review",
      reviewerAgentId: "1",
      scope: "Published benchmark",
      sourceId: source.sourceId,
      statement: "The manual result is reproducible.",
      submissionId: `manual-publication-${Date.now()}`,
      taskId: "manual-publication-task",
    });
    const env = {
      ...process.env,
      SP_ARTIFACT_BACKEND: "filesystem",
      SP_ARTIFACT_FILESYSTEM_ROOT: artifactRoot,
    };
    const testClaimId = String(9_100_000_000_000 + Date.now());
    let createCalls = 0;
    const createClaim: NonNullable<ManualSourcePublicationDependencies["createClaim"]> = async (
      _input,
      author,
      _connection,
      options,
    ) => {
      createCalls += 1;
      const result = {
        artifactId: "1",
        author,
        claimId: testClaimId,
        job: null,
        submittedBy: author,
        txHashes: {
          addArtifact: "0xmanualartifact",
          createClaim: "0xmanualcreate",
          publishClaim: "0xmanualpublish",
        },
      };
      await options.onClaimReady?.({
        artifactId: result.artifactId,
        claimId: result.claimId,
        txHashes: result.txHashes,
      });
      return result;
    };
    let syncCalls = 0;
    const syncClaimReadModel = async () => {
      syncCalls += 1;
      if (syncCalls === 1) throw new Error("simulated manual indexer outage");
    };
    const input = {
      actorAddress: actor,
      candidateId: candidate.candidateId,
      sourceId: source.sourceId,
    };

    try {
      await assert.rejects(
        confirmSourcePublication(pool, input, env, {
          createClaim,
          publishClaim: async (claimId) => ({
            claimId,
            publicationStatus: "published",
            publishClaimTxHash: "0xmanualpublishresume",
          }),
          syncClaimReadModel,
        }),
        /simulated manual indexer outage/,
      );
      await pool.query(
        `
          INSERT INTO claims (
            claim_id, author, domain_id, metadata_hash, resolution_module,
            status, revision_of_claim_id, created_at_block
          ) VALUES ($1, $2, 1, '0xmetadata', '0x0000000000000000000000000000000000000000', 1, NULL, 1)
        `,
        [testClaimId, actor],
      );

      const resumed = await confirmSourcePublication(pool, input, env, {
        createClaim,
        publishClaim: async (claimId) => ({
          claimId,
          publicationStatus: "published",
          publishClaimTxHash: "0xmanualpublishresume",
        }),
        syncClaimReadModel,
      });
      expect(resumed.publishedClaimId).to.equal(testClaimId);
      expect(resumed.source.status).to.equal("published");
      expect(createCalls).to.equal(1);
    } finally {
      await pool.query("DELETE FROM claims WHERE claim_id = $1", [testClaimId]);
      await pool.end();
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("keeps auto-publication paused when a claim-ready draft needs an author signature", async () => {
    const pool = await prepareSourceStore();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-source-publication-"));
    const source = await upsertSourceRecord(pool, {
      canonicalSourceKey: `test:publication:${Date.now()}`,
      discoveryMode: "agent_discovered",
      sourceMetadata: { locator: "ipfs://publication-test", title: "Publication test" },
      sourceType: "url",
      status: "ready_for_publication",
    });
    const candidateBase = {
      anchors: [{ label: "result", text: "The measured result is reproducible." }],
      candidateId: "unused",
      claimType: "computational",
      confidenceBps: 9_000,
      createdAt: "2026-07-10T00:00:00.000Z",
      methodology: "Independent extraction",
      scope: "Published benchmark",
      statement: "The measured result is reproducible.",
      taskId: "publication-task",
    };
    await insertSourceExtractionCandidate(pool, {
      ...candidateBase,
      reviewerAgentId: "1",
      sourceId: source.sourceId,
      submissionId: `publication-a-${Date.now()}`,
    });
    await insertSourceExtractionCandidate(pool, {
      ...candidateBase,
      reviewerAgentId: "2",
      sourceId: source.sourceId,
      submissionId: `publication-b-${Date.now()}`,
    });

    const env = {
      ...process.env,
      SP_ARTIFACT_BACKEND: "filesystem",
      SP_ARTIFACT_FILESYSTEM_ROOT: artifactRoot,
      SP_CLAIM_SUBMITTER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    };
    const testClaimId = String(9_000_000_000_000 + Date.now());
    let createCalls = 0;
    const createClaim: NonNullable<SourceAutoPublicationDependencies["createClaim"]> = async (
      _input,
      author,
      _connection,
      options,
    ) => {
      createCalls += 1;
      const result = {
        artifactId: "1",
        author,
        claimId: testClaimId,
        job: null,
        submittedBy: author,
        txHashes: {
          addArtifact: "0xartifact",
          createClaim: "0xcreate",
          publishClaim: "0xpublish",
        },
      };
      await options.onClaimReady?.({
        artifactId: result.artifactId,
        claimId: result.claimId,
        txHashes: result.txHashes,
      });
      return result;
    };
    let syncCalls = 0;
    const syncClaimReadModel = async () => {
      syncCalls += 1;
      if (syncCalls === 1) {
        throw new Error("simulated indexer outage");
      }
    };

    try {
      await assert.rejects(
        attemptSourceAutoPublication(pool, source.sourceId, env, {
          createClaim,
          syncClaimReadModel,
        }),
        /simulated indexer outage/,
      );
      expect(createCalls).to.equal(1);
      expect((await readSourcePublicationAttempt(pool, source.sourceId))?.status).to.equal(
        "claim_ready",
      );

      await pool.query(
        `
          INSERT INTO claims (
            claim_id, author, domain_id, metadata_hash, resolution_module,
            status, revision_of_claim_id, created_at_block
          ) VALUES ($1, $2, 1, '0xmetadata', '0x0000000000000000000000000000000000000000', 1, NULL, 1)
          ON CONFLICT (claim_id) DO NOTHING
        `,
        [testClaimId, `0x${"22".repeat(20)}`],
      );

      const resumed = await attemptSourceAutoPublication(pool, source.sourceId, env, {
        createClaim,
        syncClaimReadModel,
      });
      expect(resumed.publishedClaimId).to.equal(null);
      expect(resumed.reason).to.equal("awaiting_author_bond");
      expect(resumed.source?.status).to.equal("ready_for_publication");
      expect(createCalls).to.equal(1);
      expect((await readSourcePublicationAttempt(pool, source.sourceId))?.status).to.equal(
        "claim_ready",
      );
    } finally {
      await pool.query("DELETE FROM claims WHERE claim_id = $1", [testClaimId]);
      await pool.end();
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("parses source publication domain ids explicitly", () => {
    expect(sourcePublicationDomainId({})).to.equal(1);
    expect(sourcePublicationDomainId({ domainId: "   " })).to.equal(1);
    expect(sourcePublicationDomainId({ domainId: 0 })).to.equal(0);
    expect(sourcePublicationDomainId({ domainId: "4" })).to.equal(4);
    expect(() => sourcePublicationDomainId({ domainId: "wetlab" })).to.throw(
      "sourceMetadata.domainId must be a non-negative integer",
    );
  });

  it("canonicalizes arXiv, DOI, GitHub, and generic URL variants into stable keys", () => {
    expect(
      canonicalizeSourceLocator({
        locator: "https://arxiv.org/pdf/2405.15793v2.pdf",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:2405.15793v2",
      normalizedLocator: "https://arxiv.org/abs/2405.15793v2",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://arxiv.org/abs/hep-th/9901001",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:hep-th/9901001",
      normalizedLocator: "https://arxiv.org/abs/hep-th/9901001",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://arxiv.org/abs/2405%zz15793",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://arxiv.org/abs/2405%zz15793",
      normalizedLocator: "https://arxiv.org/abs/2405%zz15793",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://example.org/proxy/arxiv.org/abs/hep-th/9901001",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://example.org/proxy/arxiv.org/abs/hep-th/9901001",
      normalizedLocator: "https://example.org/proxy/arxiv.org/abs/hep-th/9901001",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "doi:10.48550/ARXIV.2405.15793",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "doi:10.48550/arxiv.2405.15793",
      normalizedLocator: "https://doi.org/10.48550/arxiv.2405.15793",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://doi.org/10.48550/%zz",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://doi.org/10.48550/%zz",
      normalizedLocator: "https://doi.org/10.48550/%zz",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://arxiv.org/abs/math.GT/0309136",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:math.gt/0309136",
      normalizedLocator: "https://arxiv.org/abs/math.GT/0309136",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://arxiv.org/pdf/cs.DL/9901001.pdf",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:cs.dl/9901001",
      normalizedLocator: "https://arxiv.org/abs/cs.DL/9901001",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "arxiv:math.GT/0309136",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:math.gt/0309136",
      normalizedLocator: "https://arxiv.org/abs/math.GT/0309136",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "2405.15793v2",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:2405.15793v2",
      normalizedLocator: "https://arxiv.org/abs/2405.15793v2",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "hep-th/9901001",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:hep-th/9901001",
      normalizedLocator: "https://arxiv.org/abs/hep-th/9901001",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "arxiv:cs.DL/9901001v2",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "arxiv:cs.dl/9901001v2",
      normalizedLocator: "https://arxiv.org/abs/cs.DL/9901001v2",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/blob/main/src/foo.ts",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "github:swe-agent/swe-agent@main",
      normalizedLocator: "https://github.com/swe-agent/swe-agent",
      ref: "main",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://www.github.com/SWE-agent/SWE-agent/blob/main/src/foo.ts",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "github:swe-agent/swe-agent@main",
      normalizedLocator: "https://github.com/swe-agent/swe-agent",
      ref: "main",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/tree/feature/x",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "github:swe-agent/swe-agent@feature/x",
      normalizedLocator: "https://github.com/swe-agent/swe-agent",
      ref: "feature/x",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/tree/ReLease-V1",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "github:swe-agent/swe-agent@ReLease-V1",
      normalizedLocator: "https://github.com/swe-agent/swe-agent",
      ref: "ReLease-V1",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/blob/feature/x/README.md",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "github:swe-agent/swe-agent@feature/x",
      normalizedLocator: "https://github.com/swe-agent/swe-agent",
      ref: "feature/x",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/issues/1",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://github.com/SWE-agent/SWE-agent/issues/1",
      normalizedLocator: "https://github.com/SWE-agent/SWE-agent/issues/1",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/pull/2",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://github.com/SWE-agent/SWE-agent/pull/2",
      normalizedLocator: "https://github.com/SWE-agent/SWE-agent/pull/2",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent/wiki",
        sourceType: "repository",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://github.com/SWE-agent/SWE-agent/wiki",
      normalizedLocator: "https://github.com/SWE-agent/SWE-agent/wiki",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://example.org/paper?id=7&source=feed&utm_source=feed#section-1",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://example.org/paper?id=7",
      normalizedLocator: "https://example.org/paper?id=7",
    });

    expect(
      canonicalizeSourceLocator({
        locator: "https://example.org/paper?id=7&source=docs&utm_source=feed#section-1",
        sourceType: "url",
      }),
    ).to.deep.include({
      canonicalSourceKey: "url:https://example.org/paper?id=7&source=docs",
      normalizedLocator: "https://example.org/paper?id=7&source=docs",
    });
  });

  it("canonicalizes common source locators into stable source keys", () => {
    expect(
      canonicalizeSourceLocator({
        locator: "https://arxiv.org/abs/2405.15793v2",
        sourceType: "url",
      }).canonicalSourceKey,
    ).to.equal("arxiv:2405.15793v2");

    expect(
      canonicalizeSourceLocator({
        locator: "https://github.com/SWE-agent/SWE-agent",
        ref: "main",
        sourceType: "repository",
      }).canonicalSourceKey,
    ).to.equal("github:swe-agent/swe-agent@main");
  });

  it("auto-publishes only when a distinct extraction cluster clears policy", () => {
    const candidates: SourceExtractionCandidate[] = [
      {
        anchors: [{ label: "abstract", text: "shows improved performance" }],
        candidateId: "1",
        claimType: "benchmark",
        confidenceBps: 7_600,
        createdAt: "2026-04-16T12:00:00.000Z",
        methodology: "paper extraction",
        reviewerAgentId: "11",
        scope: "limited to the benchmark claim",
        statement: "The method improves benchmark performance on the stated task.",
        submissionId: "101",
        taskId: "1",
      },
      {
        anchors: [{ label: "abstract", text: "outperforms prior work" }],
        candidateId: "2",
        claimType: "benchmark",
        confidenceBps: 7_400,
        createdAt: "2026-04-16T12:01:00.000Z",
        methodology: "paper extraction",
        reviewerAgentId: "12",
        scope: "limited to the benchmark claim",
        statement: "The method improves benchmark performance on the stated task.",
        submissionId: "102",
        taskId: "1",
      },
      {
        anchors: [{ label: "discussion", text: "notes some limitations" }],
        candidateId: "3",
        claimType: "benchmark",
        confidenceBps: 6_500,
        createdAt: "2026-04-16T12:02:00.000Z",
        methodology: "paper extraction",
        reviewerAgentId: "13",
        scope: "limited to a broader discussion claim",
        statement: "The method has broader applicability beyond the benchmark.",
        submissionId: "103",
        taskId: "1",
      },
    ];

    const decision = decideSourceAutoPublication(candidates);

    expect(decision.shouldPublish).to.equal(true);
    expect(decision.winningCluster?.distinctAgents).to.equal(2);
    expect(decision.winningCluster?.statement).to.equal(
      "The method improves benchmark performance on the stated task.",
    );
  });

  it("blocks publication when the best candidate cluster does not clear confidence or rivalry thresholds", () => {
    const candidates: SourceExtractionCandidate[] = [
      {
        anchors: [{ label: "abstract", text: "shows improved performance" }],
        candidateId: "1",
        claimType: "benchmark",
        confidenceBps: 7_000,
        createdAt: "2026-04-16T12:00:00.000Z",
        methodology: "paper extraction",
        reviewerAgentId: "11",
        scope: "limited to the benchmark claim",
        statement: "Claim A",
        submissionId: "101",
        taskId: "1",
      },
      {
        anchors: [{ label: "abstract", text: "shows similar results" }],
        candidateId: "2",
        claimType: "benchmark",
        confidenceBps: 7_000,
        createdAt: "2026-04-16T12:01:00.000Z",
        methodology: "paper extraction",
        reviewerAgentId: "12",
        scope: "limited to the benchmark claim",
        statement: "Claim B",
        submissionId: "102",
        taskId: "1",
      },
    ];

    const decision = decideSourceAutoPublication(candidates);

    expect(decision.shouldPublish).to.equal(false);
    expect(decision.reason).to.match(/competing|disagreement/i);
  });

  it("records duplicate source submissions without reopening ingestion work", async () => {
    const pool = await prepareSourceStore();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-source-ingress-"));
    const sourcePath = path.join(artifactRoot, "paper.txt");
    await writeFile(
      sourcePath,
      [
        "Duplicate submission test",
        "",
        "Abstract",
        "This local manuscript keeps the test self-contained while exercising the source ingest path.",
      ].join("\n"),
      "utf8",
    );

    let ingestCalls = 0;
    const artifactIngestor = async () => {
      ingestCalls += 1;
      return makeStubIngestionResult(sourcePath);
    };
    const input: ArtifactDraftInput = {
      sourceType: "url",
      sourceUrl: sourcePath,
    };

    try {
      const first = await ingestSource(pool, input, {
        artifactIngestor,
        discoveryMode: "user_submitted",
        submittedByActor: "0x0000000000000000000000000000000000000001",
      });

      const second = await ingestSource(pool, input, {
        artifactIngestor,
        discoveryMode: "user_submitted",
        submittedByActor: "0x0000000000000000000000000000000000000002",
      });

      expect(first.source.sourceId).to.equal(second.source.sourceId);
      expect(first.submissionOutcome).to.equal("created");
      expect(second.submissionOutcome).to.equal("duplicate");
      expect(ingestCalls).to.equal(1);
    } finally {
      await pool.end();
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("leases concurrent submissions so only one performs ingestion", async () => {
    const pool = await prepareSourceStore();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-source-ingress-lock-"));
    const sourcePath = path.join(artifactRoot, "paper.txt");
    await writeFile(
      sourcePath,
      [
        "Concurrent duplicate test",
        "",
        "Abstract",
        "This manuscript exercises concurrent duplicate submissions against the source lock.",
      ].join("\n"),
      "utf8",
    );

    let ingestCalls = 0;
    let taskCalls = 0;
    let releaseFirstIngest: (() => void) | null = null;
    const firstIngestBlocked = new Promise<void>((resolve) => {
      releaseFirstIngest = resolve;
    });
    const artifactIngestor = async () => {
      ingestCalls += 1;
      if (ingestCalls === 1) {
        await firstIngestBlocked;
      }
      return makeStubIngestionResult(sourcePath);
    };
    const openSourceExtractionTasks = async () => {
      taskCalls += 1;
    };
    const input: ArtifactDraftInput = {
      sourceType: "url",
      sourceUrl: sourcePath,
    };

    try {
      const firstPromise = ingestSource(pool, input, {
        artifactIngestor,
        discoveryMode: "user_submitted",
        openSourceExtractionTasks,
        submittedByActor: "0x0000000000000000000000000000000000000001",
      });
      const secondPromise = ingestSource(pool, input, {
        artifactIngestor,
        discoveryMode: "user_submitted",
        openSourceExtractionTasks,
        submittedByActor: "0x0000000000000000000000000000000000000002",
      });

      const deadline = Date.now() + 5_000;
      while (ingestCalls < 1 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(ingestCalls).to.equal(1);

      releaseFirstIngest?.();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(ingestCalls).to.equal(1);
      expect(taskCalls).to.equal(1);
      expect(first.source.sourceId).to.equal(second.source.sourceId);
      expect([first.submissionOutcome, second.submissionOutcome].sort()).to.deep.equal([
        "created",
        "duplicate",
      ]);

      const submissions = await readSourceSubmissionRecordsPage(pool, {
        limit: 10,
        sourceId: first.source.sourceId,
      });
      expect(submissions.items).to.have.length(2);
      expect(submissions.items[0]?.submissionOutcome).to.equal("duplicate");
      expect(submissions.items[1]?.submissionOutcome).to.equal("created");
    } finally {
      releaseFirstIngest?.();
      await pool.end();
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("recovers a source ingestion attempt after an abandoned lease expires", async () => {
    const pool = await prepareSourceStore();
    const sourcePath = `https://example.com/abandoned-source-${randomUUID()}.txt`;
    const canonical = canonicalizeSourceLocator({
      locator: sourcePath,
      ref: null,
      sourceType: "url",
    });
    try {
      const abandoned = await reserveSourceIngestionAttempt(pool, {
        canonicalSourceKey: canonical.canonicalSourceKey,
        leaseMs: 20,
        leaseOwner: "dead-worker",
        normalizedLocator: canonical.normalizedLocator,
        rawLocator: sourcePath,
        sourceType: "url",
      });
      expect(abandoned.acquired).to.equal(true);

      let ingestCalls = 0;
      const result = await ingestSource(
        pool,
        { sourceType: "url", sourceUrl: sourcePath },
        {
          artifactIngestor: async () => {
            ingestCalls += 1;
            return makeStubIngestionResult(sourcePath);
          },
          ingestionLeaseMs: 1_000,
          ingestionWaitMs: 100,
          ingestionWaitPollMs: 5,
          leaseOwner: "recovery-worker",
          openSourceExtractionTasks: async () => {},
        },
      );

      expect(result.submissionOutcome).to.equal("created");
      expect(ingestCalls).to.equal(1);
      const attempt = await readSourceIngestionAttempt(pool, canonical.canonicalSourceKey);
      expect(attempt?.status).to.equal("completed");
      expect(attempt?.attemptCount).to.equal(2);
      expect(attempt?.sourceId).to.equal(result.source.sourceId);
    } finally {
      await pool.end();
    }
  });

  it("serializes migrations and rejects changed applied migration bytes", async () => {
    const pool = await prepareSourceStore();
    const migrationsPath = await mkdtemp(path.join(os.tmpdir(), "sp-migration-checksum-"));
    const migrationFile = path.join(migrationsPath, "999_checksum_probe.sql");
    try {
      await writeFile(
        migrationFile,
        "CREATE TABLE IF NOT EXISTS migration_checksum_probe (id INTEGER PRIMARY KEY);\n",
      );
      await Promise.all([
        migrateReadModelDb(pool, migrationsPath),
        migrateReadModelDb(pool, migrationsPath),
      ]);
      const applied = await pool.query<{ checksum: string | null }>(
        "SELECT checksum FROM schema_migrations WHERE version = '999_checksum_probe.sql'",
      );
      expect(applied.rows[0]?.checksum).to.match(/^[0-9a-f]{64}$/);

      await writeFile(
        migrationFile,
        "CREATE TABLE IF NOT EXISTS migration_checksum_probe (id INTEGER PRIMARY KEY);\n-- changed\n",
      );
      await assert.rejects(
        migrateReadModelDb(pool, migrationsPath),
        /migration checksum mismatch: 999_checksum_probe.sql/,
      );
    } finally {
      await pool.query("DROP TABLE IF EXISTS migration_checksum_probe");
      await pool.query("DELETE FROM schema_migrations WHERE version = '999_checksum_probe.sql'");
      await pool.end();
      await rm(migrationsPath, { force: true, recursive: true });
    }
  });

  it("installs canonical resolution decision and forecast linkage storage", async () => {
    const pool = await prepareSourceStore();
    try {
      const tables = await pool.query<{ tableName: string }>(
        `SELECT table_name AS "tableName" FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'resolution_decisions'`,
      );
      expect(tables.rows.map((row) => row.tableName)).to.deep.equal(["resolution_decisions"]);
      const columns = await pool.query<{ columnName: string }>(
        `SELECT column_name AS "columnName" FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'forecasts'
           AND column_name = 'resolution_decision_id'`,
      );
      expect(columns.rows.map((row) => row.columnName)).to.deep.equal(["resolution_decision_id"]);
    } finally {
      await pool.end();
    }
  });

  it("serializes exact public-write replays with an expiring short DB lease", async () => {
    const pool = await prepareSourceStore();
    try {
      const request = await insertPublicWriteRequest(pool, {
        actionType: "claim_create",
        actorAddress: "0x00000000000000000000000000000000000000aa",
        chainId: 31337,
        payload: { statement: "lease test" },
        requestHash: `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
        requestNonce: randomUUID(),
        scopeKey: "submit:lease-test",
        signature: "0xsigned",
        status: "pending",
      });
      const [first, concurrent] = await Promise.all([
        reservePublicWriteRequestExecution(pool, {
          leaseMs: 100,
          leaseOwner: "worker-a",
          requestId: request.requestId,
        }),
        reservePublicWriteRequestExecution(pool, {
          leaseMs: 100,
          leaseOwner: "worker-b",
          requestId: request.requestId,
        }),
      ]);
      expect([first, concurrent].filter(Boolean)).to.have.length(1);
      const winner = first ? "worker-a" : "worker-b";
      expect(
        await renewPublicWriteRequestExecution(pool, {
          leaseMs: 100,
          leaseOwner: winner,
          requestId: request.requestId,
        }),
      ).to.equal(true);
      await assertPublicWriteRequestExecution(pool, {
        leaseOwner: winner,
        requestId: request.requestId,
      });
      await releasePublicWriteRequestExecution(pool, {
        leaseOwner: winner,
        requestId: request.requestId,
      });
      expect(
        await reservePublicWriteRequestExecution(pool, {
          leaseMs: 5,
          leaseOwner: "crashed-worker",
          requestId: request.requestId,
        }),
      ).to.equal(true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(
        await reservePublicWriteRequestExecution(pool, {
          leaseMs: 100,
          leaseOwner: "recovery-worker",
          requestId: request.requestId,
        }),
      ).to.equal(true);
      await assert.rejects(
        assertPublicWriteRequestExecution(pool, {
          leaseOwner: "crashed-worker",
          requestId: request.requestId,
        }),
        /public_write_request_execution_lease_lost/,
      );
      expect(
        await renewPublicWriteRequestExecution(pool, {
          leaseMs: 100,
          leaseOwner: "crashed-worker",
          requestId: request.requestId,
        }),
      ).to.equal(false);
      await markPublicWriteRequestAccepted(pool, request.requestId, "claim:7:published");
      await markPublicWriteRequestPending(pool, request.requestId, "late_worker_pending");
      await markPublicWriteRequestRejected(pool, request.requestId, "late_worker_rejected");
      const accepted = await readPublicWriteRequest(pool, request.requestId);
      expect(accepted?.status).to.equal("accepted");
      expect(accepted?.outcomeDetail).to.equal("claim:7:published");
    } finally {
      await pool.end();
    }
  });

  it("atomically enforces a write limit across service instances", async () => {
    const pool = await prepareSourceStore();
    const bucketKey = `cross-instance:${randomUUID()}`;
    const response = { setHeader() {} } as unknown as import("node:http").ServerResponse;
    try {
      await pool.query(
        `INSERT INTO api_rate_limit_buckets (bucket_key, request_count, reset_at)
         SELECT 'expired-test-' || value::text, 1, NOW() - INTERVAL '1 second'
         FROM generate_series(1, 3) AS value`,
      );
      const results = await Promise.all([
        consumeConfiguredRateLimit({
          backend: "postgres",
          bucketKey,
          buckets: new Map(),
          pool,
          response,
          rule: { maxRequests: 1, windowMs: 60_000 },
        }),
        consumeConfiguredRateLimit({
          backend: "postgres",
          bucketKey,
          buckets: new Map(),
          pool,
          response,
          rule: { maxRequests: 1, windowMs: 60_000 },
        }),
      ]);
      expect(results.filter((result) => result.allowed)).to.have.length(1);
      expect(results.filter((result) => !result.allowed)).to.have.length(1);
      const expired = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM api_rate_limit_buckets WHERE bucket_key LIKE 'expired-test-%'",
      );
      expect(expired.rows[0]?.count).to.equal("0");
    } finally {
      await pool.query("DELETE FROM api_rate_limit_buckets WHERE bucket_key = $1", [bucketKey]);
      await pool.query("DELETE FROM api_rate_limit_buckets WHERE bucket_key LIKE 'expired-test-%'");
      await pool.end();
    }
  });

  it("rehydrates duplicate submissions for legacy rows without reopening extraction tasks", async () => {
    const pool = await prepareSourceStore();
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-source-ingress-legacy-"));
    const sourcePath = path.join(artifactRoot, "paper.txt");
    const snapshotPath = path.join(artifactRoot, "legacy-snapshot.txt");
    const extractionPath = path.join(artifactRoot, "legacy-extraction.json");
    await writeFile(
      sourcePath,
      [
        "Legacy duplicate replay",
        "",
        "Abstract",
        "This manuscript seeds an older source row that lacks stored artifacts and metadata.",
      ].join("\n"),
      "utf8",
    );
    await writeFile(snapshotPath, "legacy snapshot", "utf8");

    const canonical = canonicalizeSourceLocator({
      locator: sourcePath,
      sourceType: "url",
    });
    const stub = makeStubIngestionResult(sourcePath);
    const snapshotArtifact = await upsertPersistedArtifact(pool, {
      ...stub.snapshotArtifact,
      byteLength: Buffer.byteLength("legacy snapshot"),
      storagePath: snapshotPath,
    });
    const extractionPayload = {
      artifactType: stub.artifactType,
      extractedAt: "2026-04-16T00:00:00.000Z",
      preview: stub.preview,
      sourceLocator: stub.sourceLocator,
      sourceType: stub.sourceType,
      sourceVersion: stub.sourceVersion,
    };
    await writeFile(extractionPath, JSON.stringify(extractionPayload), "utf8");
    const extractionArtifact = await upsertPersistedArtifact(pool, {
      ...stub.extractionArtifact,
      byteLength: Buffer.byteLength(JSON.stringify(extractionPayload)),
      storagePath: extractionPath,
    });
    const legacySource = await upsertSourceRecord(pool, {
      canonicalSourceKey: canonical.canonicalSourceKey,
      discoveryMode: "user_submitted",
      extractionArtifactKey: extractionArtifact.artifactKey,
      snapshotArtifactKey: snapshotArtifact.artifactKey,
      sourceMetadata: {
        locator: sourcePath,
        title: "legacy source",
      },
      sourceType: "url",
      status: "discovered",
      submittedByActor: "0x0000000000000000000000000000000000000001",
    });

    let ingestCalls = 0;
    let taskCalls = 0;
    const artifactIngestor = async () => {
      ingestCalls += 1;
      return makeStubIngestionResult(sourcePath);
    };
    const openSourceExtractionTasks = async () => {
      taskCalls += 1;
    };

    try {
      const result = await ingestSource(
        pool,
        { sourceType: "url", sourceUrl: sourcePath },
        {
          artifactIngestor,
          discoveryMode: "user_submitted",
          openSourceExtractionTasks,
          submittedByActor: "0x0000000000000000000000000000000000000002",
        },
      );

      expect(result.submissionOutcome).to.equal("duplicate");
      expect(result.source.sourceId).to.equal(legacySource.sourceId);
      expect(ingestCalls).to.equal(0);
      expect(taskCalls).to.equal(0);
      expect(result.preview.statement).to.equal(stub.preview.statement);
      expect(result.sourceVersion.extension).to.equal(stub.sourceVersion.extension);
    } finally {
      await pool.end();
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });
});
