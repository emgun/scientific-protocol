import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import type { ArtifactDraftInput, ArtifactIngestionResult } from "../src/artifacts/ingestion.js";
import { upsertPersistedArtifact } from "../src/coordinator/store.js";
import {
  canonicalizeSourceLocator,
  decideSourceAutoPublication,
} from "../src/sources/canonicalize.js";
import { sourcePublicationDomainId } from "../src/sources/publication.js";
import { ingestSource } from "../src/sources/service.js";
import {
  prepareSourceStore,
  readSourceSubmissionRecordsPage,
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

  it("serializes concurrent duplicate submissions under a source lock", async () => {
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
      while (ingestCalls === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(ingestCalls).to.equal(1);

      releaseFirstIngest?.();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      expect(ingestCalls).to.equal(1);
      expect(taskCalls).to.equal(1);
      expect(first.source.sourceId).to.equal(second.source.sourceId);
      expect(first.submissionOutcome).to.equal("created");
      expect(second.submissionOutcome).to.equal("duplicate");

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
