import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { expect } from "chai";
import {
  ingestArtifactSource,
  UnsupportedArtifactContentError,
} from "../src/artifacts/ingestion.js";
import {
  readVerifiedJsonArtifact,
  verifyPersistedArtifact,
} from "../src/shared/persisted-artifacts.js";

const execFile = promisify(execFileCallback);

describe("ArtifactIngestion", () => {
  it("rejects unsupported binary manuscripts instead of persisting decoded garbage", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-ingest-binary-"));
    const sourcePath = path.join(artifactRoot, "paper.djvu");
    await writeFile(
      sourcePath,
      Buffer.concat([
        Buffer.from("AT&TFORM\u0000\u0000\u0000\u0018DJVMDIRM", "binary"),
        Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
      ]),
    );

    try {
      await assert.rejects(
        ingestArtifactSource(
          { sourceType: "url", sourceUrl: sourcePath },
          { backend: "filesystem", filesystemRoot: artifactRoot },
        ),
        UnsupportedArtifactContentError,
      );
    } finally {
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("validates numeric draft inputs before fetching artifacts", async () => {
    await assert.rejects(
      ingestArtifactSource({
        artifactType: 0,
        sourceType: "url",
        sourceUrl: "http://127.0.0.1:1/unreachable.txt",
      }),
      /artifactType must be an integer greater than or equal to 1/,
    );

    await assert.rejects(
      ingestArtifactSource({
        domainId: Number.NaN,
        sourceType: "url",
        sourceUrl: "http://127.0.0.1:1/unreachable.txt",
      }),
      /domainId must be an integer greater than or equal to 0/,
    );
  });

  it("snapshots a manuscript URL into artifact storage and extracts a draft preview", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-ingest-url-"));
    const manuscriptText = [
      "Reproducible benchmark reruns preserve the reported model ordering",
      "",
      "Abstract",
      "We demonstrate that the published benchmark bundle preserves the reported model ordering when rerun in the declared container image.",
      "The paper reports an objective rerun target that can be checked against a released manifest.",
    ].join("\n");

    const server = http.createServer(
      async (_request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        response.end(manuscriptText);
      },
    );

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start manuscript source server");
    }

    try {
      const result = await ingestArtifactSource(
        {
          sourceType: "url",
          sourceUrl: `http://127.0.0.1:${address.port}/paper.txt`,
        },
        {
          backend: "filesystem",
          filesystemRoot: artifactRoot,
        },
      );

      expect(result.artifactType).to.equal(5);
      expect(result.preview.title).to.contain("Reproducible benchmark reruns");
      expect(result.preview.statement).to.contain("preserves the reported model ordering");
      expect(result.snapshotArtifact.storagePath.startsWith(artifactRoot)).to.equal(true);
      expect(await verifyPersistedArtifact(result.snapshotArtifact)).to.equal(true);
      expect(await verifyPersistedArtifact(result.extractionArtifact)).to.equal(true);

      const extraction = await readVerifiedJsonArtifact<{
        preview: { title: string; statement: string };
        sourceType: string;
      }>(result.extractionArtifact);
      expect(extraction.preview.title).to.equal(result.preview.title);
      expect(extraction.sourceType).to.equal("url");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("snapshots a repository at a pinned commit and extracts a draft preview from the readme", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-ingest-repo-"));
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "sp-ingest-repo-source-"));
    const repoPath = path.join(repoRoot, "demo-repo");

    await mkdir(repoPath, { recursive: true });
    await execFile("git", ["init"], { cwd: repoPath });
    await execFile("git", ["config", "user.email", "scientific-protocol@example.com"], {
      cwd: repoPath,
    });
    await execFile("git", ["config", "user.name", "Scientific Protocol"], { cwd: repoPath });
    await writeFile(
      path.join(repoPath, "README.md"),
      [
        "# Benchmark rerun package",
        "",
        "This repository demonstrates that the published benchmark bundle preserves the reported model ranking when rerun from source.",
        "It also records the manifest expected by an external replication worker.",
      ].join("\n"),
      "utf8",
    );
    await execFile("git", ["add", "README.md"], { cwd: repoPath });
    await execFile("git", ["commit", "-m", "Initial snapshot"], { cwd: repoPath });

    try {
      const result = await ingestArtifactSource(
        {
          repositoryUrl: repoPath,
          sourceType: "repository",
        },
        {
          backend: "filesystem",
          filesystemRoot: artifactRoot,
        },
      );

      expect(result.artifactType).to.equal(1);
      expect(result.sourceVersion.commitHash).to.match(/^[0-9a-f]{40}$/);
      expect(result.preview.title).to.equal("demo-repo");
      expect(result.preview.statement).to.contain("preserves the reported model ranking");
      expect(result.snapshotArtifact.storagePath.endsWith(".tar.gz")).to.equal(true);
      expect(await verifyPersistedArtifact(result.snapshotArtifact)).to.equal(true);
      expect(await verifyPersistedArtifact(result.extractionArtifact)).to.equal(true);
    } finally {
      await rm(repoRoot, { force: true, recursive: true });
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("ingests a manuscript directly from an ipfs uri", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-ingest-ipfs-"));
    const manuscriptText = [
      "Containerized reruns preserve the paper's headline benchmark result",
      "",
      "Abstract",
      "We show that the archived benchmark package preserves the paper's headline benchmark result when rerun from the pinned container digest.",
    ].join("\n");

    const result = await ingestArtifactSource(
      {
        sourceType: "url",
        sourceUrl: "ipfs://bafyingestpapercid/paper.md",
      },
      {
        backend: "filesystem",
        filesystemRoot: artifactRoot,
        ipfsClient: {
          async addObject(): Promise<{ cid: string }> {
            throw new Error("unexpected ipfs write");
          },
          async readObject(): Promise<Buffer> {
            return Buffer.from(manuscriptText, "utf8");
          },
        },
      },
    );

    try {
      expect(result.sourceLocator).to.equal("ipfs://bafyingestpapercid/paper.md");
      expect(result.sourceVersion.cid).to.equal("bafyingestpapercid");
      expect(result.preview.statement).to.contain(
        "preserves the paper's headline benchmark result",
      );
      expect(await verifyPersistedArtifact(result.snapshotArtifact)).to.equal(true);
      expect(await verifyPersistedArtifact(result.extractionArtifact)).to.equal(true);
    } finally {
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });
});
