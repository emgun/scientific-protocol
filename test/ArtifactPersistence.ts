import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { expect } from "chai";
import {
  defaultArtifactStoragePolicy,
  resolveArtifactStoragePolicyInput,
} from "../src/shared/artifact-storage-policy.js";
import {
  auditPersistedArtifactReplicas,
  createInlineJsonArtifact,
  openPersistedArtifactReadStream,
  persistArtifactReplicaToTarget,
  persistBinaryArtifact,
  persistFileArtifact,
  persistJsonArtifact,
  readPersistedArtifactBytes,
  readVerifiedJsonArtifact,
  resolveArtifactPersistenceOptions,
  sha256Hex,
  verifyPersistedArtifact,
} from "../src/shared/persisted-artifacts.js";

describe("ArtifactPersistence", () => {
  it("creates self-contained verifiable JSON artifacts", async () => {
    const artifact = createInlineJsonArtifact("agent-review-result", {
      summary: "Independent review result",
      verdict: "pass",
    });

    expect(artifact.storagePath).to.match(/^data:application\/json;base64,/);
    expect(await verifyPersistedArtifact(artifact)).to.equal(true);
    expect(await readVerifiedJsonArtifact(artifact)).to.deep.equal({
      summary: "Independent review result",
      verdict: "pass",
    });
  });

  it("defines scaled storage defaults by artifact durability class", () => {
    expect(defaultArtifactStoragePolicy("A")).to.deep.equal({
      durabilityClass: "A",
      repairPriority: 100,
      requiredIndependentRetrievalPaths: 2,
      requiredReplicaCount: 2,
      requiresFilecoinOrEquivalent: true,
    });

    expect(defaultArtifactStoragePolicy("D")).to.deep.equal({
      durabilityClass: "D",
      repairPriority: 10,
      requiredIndependentRetrievalPaths: 0,
      requiredReplicaCount: 0,
      requiresFilecoinOrEquivalent: false,
    });
  });

  it("resolves artifact storage policy overrides without losing class defaults", () => {
    expect(
      resolveArtifactStoragePolicyInput({
        bundleCid: "bafyjournalbundle",
        bundleMemberPath: "1665/001/paper.djvu",
        durabilityClass: "B",
        metadata: { jurisdiction: "US" },
        requiredIndependentRetrievalPaths: 2,
      }),
    ).to.deep.equal({
      bundleCid: "bafyjournalbundle",
      bundleMemberPath: "1665/001/paper.djvu",
      durabilityClass: "B",
      metadata: { jurisdiction: "US" },
      repairPriority: 50,
      requiredIndependentRetrievalPaths: 2,
      requiredReplicaCount: 1,
      requiresFilecoinOrEquivalent: true,
      retentionUntil: null,
    });
  });

  it("resolves artifact backend configuration from an explicit env source", () => {
    const resolved = resolveArtifactPersistenceOptions({
      env: {
        SP_ARTIFACT_BACKEND: "s3",
        SP_ARTIFACT_S3_BUCKET: "science-artifacts",
        SP_ARTIFACT_S3_ENDPOINT: "https://s3.example.org",
        SP_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
        SP_ARTIFACT_S3_PREFIX: "claims",
        SP_ARTIFACT_S3_REGION: "us-west-2",
      },
      s3Client: {
        async send(): Promise<unknown> {
          return {};
        },
      },
    });

    expect(resolved.backend).to.equal("s3");
    expect(resolved.s3Bucket).to.equal("science-artifacts");
    expect(resolved.s3Endpoint).to.equal("https://s3.example.org");
    expect(resolved.s3ForcePathStyle).to.equal(true);
    expect(resolved.s3Prefix).to.equal("claims");
    expect(resolved.s3Region).to.equal("us-west-2");
    expect("env" in resolved).to.equal(false);
  });

  it("rejects invalid artifact boolean environment values", () => {
    expect(() =>
      resolveArtifactPersistenceOptions({
        env: {
          SP_ARTIFACT_IPFS_PIN: "yes",
        },
      }),
    ).to.throw("SP_ARTIFACT_IPFS_PIN must be true or false");
    expect(() =>
      resolveArtifactPersistenceOptions({
        env: {
          SP_ARTIFACT_S3_FORCE_PATH_STYLE: "yes",
        },
      }),
    ).to.throw("SP_ARTIFACT_S3_FORCE_PATH_STYLE must be true or false");
  });

  it("rejects invalid artifact IPFS enum environment values", () => {
    expect(() =>
      resolveArtifactPersistenceOptions({
        env: {
          SP_ARTIFACT_BACKEND: "disk",
        },
      }),
    ).to.throw("SP_ARTIFACT_BACKEND must be one of: filesystem, http, s3, gcs, ipfs");
    expect(() =>
      resolveArtifactPersistenceOptions({
        env: {
          SP_ARTIFACT_IPFS_PROVIDER: "gateway",
        },
      }),
    ).to.throw("SP_ARTIFACT_IPFS_PROVIDER must be one of: kubo, pinata");
    expect(() =>
      resolveArtifactPersistenceOptions({
        env: {
          SP_ARTIFACT_PINATA_NETWORK: "testnet",
        },
      }),
    ).to.throw("SP_ARTIFACT_PINATA_NETWORK must be one of: public, private");
  });

  it("persists and verifies artifacts on the filesystem backend", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-"));
    try {
      const payload = { hello: "world", count: 2 };
      const artifact = await persistJsonArtifact("test-payload", payload, {
        backend: "filesystem",
        filesystemRoot: tempRoot,
      });

      expect(artifact.storagePath.startsWith(tempRoot)).to.equal(true);
      expect(await verifyPersistedArtifact(artifact)).to.equal(true);
      expect(await readVerifiedJsonArtifact<typeof payload>(artifact)).to.deep.equal(payload);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists artifacts to the filecoin backend with padding and provider metadata", async () => {
    const uploads: Array<{ byteLength: number; contentType: string; filename: string }> = [];
    const artifact = await persistJsonArtifact(
      "test-filecoin",
      { tiny: true },
      {
        backend: "filecoin",
        filecoinClient: {
          async uploadObject(input) {
            uploads.push({
              byteLength: input.bytes.byteLength,
              contentType: input.contentType,
              filename: input.filename,
            });
            return {
              dataSetId: "77",
              pieceCid: "bafkzcibtestpiece",
              providerId: "4",
              retrievalUrl: "https://provider.example/piece/bafkzcibtestpiece",
            };
          },
        },
      },
    );

    expect(uploads).to.have.length(1);
    // Sub-minimum payloads are padded up to the provider floor.
    expect(uploads[0]?.byteLength).to.equal(127);
    expect(artifact.byteLength).to.equal(127);
    expect(artifact.storagePath).to.equal("https://provider.example/piece/bafkzcibtestpiece");
    const replica = artifact.replicas?.find((entry) => entry.isPrimary);
    expect(replica?.providerMetadata?.provider).to.equal("filecoin-onchain-cloud");
    expect(replica?.providerMetadata?.objectId).to.equal("bafkzcibtestpiece");
  });

  it("persists and verifies binary artifacts on the filesystem backend", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-binary-"));
    try {
      const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x01, 0x02, 0xff]);
      const artifact = await persistBinaryArtifact(
        "paper-source",
        bytes,
        {
          contentType: "application/pdf",
          extension: "pdf",
        },
        {
          backend: "filesystem",
          filesystemRoot: tempRoot,
        },
      );

      expect(artifact.storagePath.endsWith(".pdf")).to.equal(true);
      expect(await verifyPersistedArtifact(artifact)).to.equal(true);
      expect(Buffer.compare(await readPersistedArtifactBytes(artifact), bytes)).to.equal(0);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("reports artifact paths for invalid verified JSON artifacts", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-invalid-json-"));
    try {
      const bytes = Buffer.from("{", "utf8");
      const artifact = await persistBinaryArtifact(
        "invalid-json",
        bytes,
        {
          contentType: "application/json",
          extension: "json",
        },
        {
          backend: "filesystem",
          filesystemRoot: tempRoot,
        },
      );

      await assert.rejects(async () => readVerifiedJsonArtifact<unknown>(artifact), {
        message: new RegExp(`^artifact JSON parse failed for ${artifact.storagePath}:`),
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("persists artifacts from a staged file without buffering the ingest path", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-file-source-"));
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-file-staging-"));
    const sourcePath = path.join(sourceRoot, "snapshot.tar.gz");
    const bytes = Buffer.from("staged repository archive bytes", "utf8");

    try {
      await writeFile(sourcePath, bytes);
      const artifact = await persistFileArtifact(
        "repository-snapshot",
        sourcePath,
        {
          contentType: "application/gzip",
          extension: "tar.gz",
        },
        {
          backend: "filesystem",
          filesystemRoot: artifactRoot,
        },
      );

      expect(artifact.storagePath.endsWith(".tar.gz")).to.equal(true);
      expect(await verifyPersistedArtifact(artifact)).to.equal(true);
      expect(Buffer.compare(await readPersistedArtifactBytes(artifact), bytes)).to.equal(0);
    } finally {
      await rm(artifactRoot, { force: true, recursive: true });
      await rm(sourceRoot, { force: true, recursive: true });
    }
  });

  it("persists and verifies artifacts through the http backend", async () => {
    const objects = new Map<string, Buffer>();
    const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        objects.set(requestUrl.pathname, Buffer.concat(chunks));
        response.writeHead(200);
        response.end("ok");
        return;
      }

      if (request.method === "GET") {
        const body = objects.get(requestUrl.pathname);
        if (!body) {
          response.writeHead(404);
          response.end("missing");
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
      }

      response.writeHead(405);
      response.end("method_not_allowed");
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const payload = { source: "http-backend", items: ["a", "b"] };
      const artifact = await persistJsonArtifact("remote-payload", payload, {
        backend: "http",
        httpBaseUrl: baseUrl,
      });

      expect(artifact.storagePath.startsWith(baseUrl)).to.equal(true);
      expect(objects.size).to.equal(1);
      expect(await verifyPersistedArtifact(artifact)).to.equal(true);
      expect(await readVerifiedJsonArtifact<typeof payload>(artifact)).to.deep.equal(payload);
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
    }
  });

  it("persists and verifies artifacts through the ipfs backend", async () => {
    const objects = new Map<string, Buffer>();
    let nextCid = "bafytestcid123";
    const fakeClient = {
      async addObject(input: { body: Uint8Array; filename: string }): Promise<{ cid: string }> {
        const cid = nextCid;
        nextCid = "bafytestcid124";
        objects.set(cid, Buffer.from(input.body));
        expect(input.filename.endsWith(".json")).to.equal(true);
        return { cid };
      },
      async readObject(input: { cid: string }): Promise<Buffer> {
        return objects.get(input.cid) ?? Buffer.alloc(0);
      },
    };

    const payload = { backend: "ipfs", immutable: true };
    const artifact = await persistJsonArtifact("ipfs-payload", payload, {
      backend: "ipfs",
      ipfsApiUrl: "http://127.0.0.1:5001",
      ipfsClient: fakeClient,
      ipfsPin: true,
    });

    expect(artifact.storagePath).to.equal("ipfs://bafytestcid123");
    expect(objects.size).to.equal(1);
    expect(
      await verifyPersistedArtifact(artifact, {
        backend: "ipfs",
        ipfsApiUrl: "http://127.0.0.1:5001",
        ipfsClient: fakeClient,
      }),
    ).to.equal(true);
    expect(
      await readVerifiedJsonArtifact<typeof payload>(artifact, {
        backend: "ipfs",
        ipfsApiUrl: "http://127.0.0.1:5001",
        ipfsClient: fakeClient,
      }),
    ).to.deep.equal(payload);
  });

  it("persists and verifies artifacts through the pinata ipfs preset", async () => {
    const uploadedBodies = new Map<string, Buffer>();
    const payload = { persisted: true };
    const expectedBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && requestUrl.pathname === "/v3/files") {
        expect(request.headers.authorization).to.equal("Bearer pinata-jwt");
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        expect(body.includes(Buffer.from("form-data"))).to.equal(true);
        const cid = "bafypinatatestcid";
        uploadedBodies.set(cid, expectedBytes);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: {
              cid,
              filecoin: {
                deals: [
                  {
                    dealId: "deal-1001",
                    miner: "f01234",
                    pieceCid: "baga6ea4seaq",
                    status: "active",
                  },
                ],
                network: "public",
                status: "active",
              },
              id: "pinata-file-1",
              status: "pinned",
            },
          }),
        );
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/ipfs/bafypinatatestcid") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(uploadedBodies.get("bafypinatatestcid") ?? Buffer.alloc(0));
        return;
      }

      response.writeHead(404);
      response.end("missing");
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.once("error", reject);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to start pinata test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const artifact = await persistJsonArtifact("pinata-payload", payload, {
        backend: "ipfs",
        ipfsProvider: "pinata",
        pinataApiUrl: baseUrl,
        pinataGatewayUrl: `${baseUrl}/ipfs`,
        pinataJwt: "pinata-jwt",
      });

      expect(artifact.storagePath).to.equal("ipfs://bafypinatatestcid");
      expect(artifact.replicas?.[0]?.providerMetadata?.objectId).to.equal("pinata-file-1");
      expect(artifact.replicas?.[0]?.providerMetadata?.filecoin?.dealCount).to.equal(1);
      expect(
        await verifyPersistedArtifact(artifact, {
          backend: "ipfs",
          ipfsProvider: "pinata",
          pinataApiUrl: baseUrl,
          pinataGatewayUrl: `${baseUrl}/ipfs`,
          pinataJwt: "pinata-jwt",
        }),
      ).to.equal(true);
      expect(
        await readVerifiedJsonArtifact<typeof payload>(artifact, {
          backend: "ipfs",
          ipfsProvider: "pinata",
          pinataApiUrl: baseUrl,
          pinataGatewayUrl: `${baseUrl}/ipfs`,
          pinataJwt: "pinata-jwt",
        }),
      ).to.deep.equal(payload);
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
    }
  });

  it("streams persisted artifact content without buffering filesystem reads", async () => {
    const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifact-stream-"));
    try {
      const bytes = Buffer.from("stream me without loading everything twice", "utf8");
      const artifact = await persistBinaryArtifact(
        "streamed-payload",
        bytes,
        {
          contentType: "text/plain; charset=utf-8",
          extension: "txt",
        },
        {
          backend: "filesystem",
          filesystemRoot: artifactRoot,
        },
      );

      const opened = await openPersistedArtifactReadStream(artifact);
      const chunks: Buffer[] = [];
      for await (const chunk of opened.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).equals(bytes)).to.equal(true);
    } finally {
      await rm(artifactRoot, { force: true, recursive: true });
    }
  });

  it("persists and verifies artifacts through the s3 backend", async () => {
    const objects = new Map<string, Buffer>();
    const fakeClient = {
      async send(command: GetObjectCommand | PutObjectCommand): Promise<unknown> {
        if (command instanceof PutObjectCommand) {
          const input = command.input;
          const key = `${input.Bucket}/${input.Key}`;
          const body =
            typeof input.Body === "string"
              ? Buffer.from(input.Body, "utf8")
              : Buffer.from((input.Body as Uint8Array | undefined) ?? new Uint8Array());
          objects.set(key, body);
          return { ETag: "etag" };
        }
        if (command instanceof GetObjectCommand) {
          const input = command.input;
          const key = `${input.Bucket}/${input.Key}`;
          const body = objects.get(key);
          return {
            Body: {
              transformToByteArray: async () => new Uint8Array(body ?? new Uint8Array()),
            },
          };
        }
        throw new Error("unsupported command");
      },
    };

    const payload = { backend: "s3", nested: { enabled: true } };
    const artifact = await persistJsonArtifact("s3-payload", payload, {
      backend: "s3",
      s3Bucket: "test-bucket",
      s3Client: fakeClient,
      s3Prefix: "science/dev",
      s3Region: "us-east-1",
    });

    expect(artifact.storagePath.startsWith("s3://test-bucket/science/dev/")).to.equal(true);
    expect(objects.size).to.equal(1);
    expect(
      await verifyPersistedArtifact(artifact, {
        backend: "s3",
        s3Bucket: "test-bucket",
        s3Client: fakeClient,
        s3Region: "us-east-1",
      }),
    ).to.equal(true);
    expect(
      await readVerifiedJsonArtifact<typeof payload>(artifact, {
        backend: "s3",
        s3Bucket: "test-bucket",
        s3Client: fakeClient,
        s3Region: "us-east-1",
      }),
    ).to.deep.equal(payload);
  });

  it("persists and verifies artifacts through the gcs backend", async () => {
    const objects = new Map<string, Buffer>();
    const fakeClient = {
      async saveObject(input: {
        body: string | Uint8Array;
        bucket: string;
        key: string;
      }): Promise<void> {
        objects.set(
          `${input.bucket}/${input.key}`,
          typeof input.body === "string"
            ? Buffer.from(input.body, "utf8")
            : Buffer.from(input.body),
        );
      },
      async readObject(input: { bucket: string; key: string }): Promise<Buffer> {
        return objects.get(`${input.bucket}/${input.key}`) ?? Buffer.alloc(0);
      },
      async objectExists(input: { bucket: string; key: string }): Promise<boolean> {
        return objects.has(`${input.bucket}/${input.key}`);
      },
    };

    const payload = { backend: "gcs", items: [1, 2, 3] };
    const artifact = await persistJsonArtifact("gcs-payload", payload, {
      backend: "gcs",
      gcsBucket: "test-gcs-bucket",
      gcsClient: fakeClient,
      gcsPrefix: "science/staging",
    });

    expect(artifact.storagePath.startsWith("gs://test-gcs-bucket/science/staging/")).to.equal(true);
    expect(objects.size).to.equal(1);
    expect(
      await verifyPersistedArtifact(artifact, {
        backend: "gcs",
        gcsBucket: "test-gcs-bucket",
        gcsClient: fakeClient,
      }),
    ).to.equal(true);
    expect(
      await readVerifiedJsonArtifact<typeof payload>(artifact, {
        backend: "gcs",
        gcsBucket: "test-gcs-bucket",
        gcsClient: fakeClient,
      }),
    ).to.deep.equal(payload);
  });

  it("captures replica locations and replication failures for configured ipfs targets", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-replicas-"));
    const payload = { durable: true };
    const expectedBytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");

    try {
      const artifact = await persistJsonArtifact("replicated-payload", payload, {
        backend: "filesystem",
        filesystemRoot: tempRoot,
        ipfsReplicaTargets: [
          {
            apiUrl: "http://127.0.0.1:5001",
            ipfsClient: {
              async addObject(): Promise<{ cid: string }> {
                return { cid: "bafyreplicaone" };
              },
              async readObject(): Promise<Buffer> {
                return expectedBytes;
              },
            },
            replicaKey: "pinning-a",
          },
          {
            apiUrl: "http://127.0.0.1:5001",
            ipfsClient: {
              async addObject(): Promise<{ cid: string }> {
                throw new Error("pin target unavailable");
              },
              async readObject(): Promise<Buffer> {
                return Buffer.alloc(0);
              },
            },
            replicaKey: "pinning-b",
          },
        ],
      });

      expect(artifact.replicas).to.have.length(2);
      expect(artifact.replicas?.[0].replicaKey).to.equal("primary");
      expect(artifact.replicas?.[1].locator).to.equal("ipfs://bafyreplicaone");
      expect(artifact.audits?.map((audit) => audit.status)).to.deep.equal([
        "replicated",
        "replicated",
        "replication_failed",
      ]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("audits primary and replicated artifact locations against the stored hash", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifacts-audit-"));
    const bytes = Buffer.from("durable science artifact", "utf8");

    try {
      const artifact = await persistBinaryArtifact(
        "durable-payload",
        bytes,
        {
          contentType: "text/plain; charset=utf-8",
          extension: "txt",
        },
        {
          backend: "filesystem",
          filesystemRoot: tempRoot,
          ipfsReplicaTargets: [
            {
              apiUrl: "http://127.0.0.1:5001",
              ipfsClient: {
                async addObject(): Promise<{ cid: string }> {
                  return { cid: "bafyauditreplica" };
                },
                async readObject(): Promise<Buffer> {
                  return bytes;
                },
              },
              replicaKey: "pinning-a",
            },
          ],
        },
      );

      const audits = await auditPersistedArtifactReplicas(artifact, {
        backend: "filesystem",
        filesystemRoot: tempRoot,
        ipfsReplicaTargets: [
          {
            apiUrl: "http://127.0.0.1:5001",
            ipfsClient: {
              async addObject(): Promise<{ cid: string }> {
                return { cid: "unused" };
              },
              async readObject(): Promise<Buffer> {
                return bytes;
              },
            },
            replicaKey: "pinning-a",
          },
        ],
      });

      expect(audits).to.have.length(2);
      expect(audits.every((audit) => audit.status === "verified")).to.equal(true);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("repairs a replica target from healthy artifact bytes", async () => {
    const uploadedBodies = new Map<string, Buffer>();
    const bytes = Buffer.from("repairable science artifact", "utf8");
    const artifact = {
      contentType: "text/plain; charset=utf-8",
      sha256: `0x${sha256Hex(bytes)}`,
      storagePath: "/tmp/repairable.txt",
    };

    const repaired = await persistArtifactReplicaToTarget(artifact, bytes, {
      apiUrl: "http://127.0.0.1:5001",
      ipfsClient: {
        async addObject(input: { body: Uint8Array; filename: string }): Promise<{ cid: string }> {
          uploadedBodies.set(input.filename, Buffer.from(input.body));
          return { cid: "bafyrepairtarget" };
        },
        async readObject(): Promise<Buffer> {
          return bytes;
        },
      },
      replicaKey: "pinning-repair",
    });

    expect(repaired.replica.locator).to.equal("ipfs://bafyrepairtarget");
    expect(repaired.replica.replicaKey).to.equal("pinning-repair");
    expect(repaired.audit.status).to.equal("replicated");
    const uploaded = Array.from(uploadedBodies.values());
    expect(uploaded).to.have.length(1);
    expect(Buffer.compare(uploaded[0] ?? Buffer.alloc(0), bytes)).to.equal(0);
  });
});
