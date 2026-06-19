import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import { validateRuntimeEnvironment } from "../src/shared/env.js";

describe("RuntimeEnvironment", () => {
  it("accepts a production-safe remote runtime without demo admin config", () => {
    const result = validateRuntimeEnvironment({
      SP_DATABASE_URL: "postgresql://postgres:secret@db.example.org:5432/scientific_protocol",
      SP_RPC_URL: "https://base.example.org",
      SP_ARTIFACT_BACKEND: "ipfs",
      SP_ARTIFACT_IPFS_API_URL: "https://ipfs.example.org",
      SP_OPERATOR_PRIVATE_KEY: "0x1234",
      SP_PUBLIC_BASE_URL: "https://protocol.example.org",
      SP_PUBLIC_DOMAIN: "protocol.example.org",
      SP_ENABLE_SANDBOX_ADMIN_ROUTES: "false",
    });

    expect(result.rpcUrl).to.equal("https://base.example.org");
  });

  it("rejects invalid sandbox toggle values", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@db.example.org:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_API_URL: "https://ipfs.example.org",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
        SP_ENABLE_SANDBOX_ADMIN_ROUTES: "sometimes",
      }),
    ).to.throw("SP_ENABLE_SANDBOX_ADMIN_ROUTES must be true or false");
  });

  it("rejects duplicate replication submitter allowlist addresses", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "http://127.0.0.1:8545",
        SP_ARTIFACT_BACKEND: "filesystem",
        SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES:
          "0x0000000000000000000000000000000000000003,0x0000000000000000000000000000000000000003",
      }),
    ).to.throw("SP_REPLICATION_SUBMITTER_AUTHORIZED_ADDRESSES[1] duplicates an earlier address");
  });

  it("requires SP_DEMO_ADMIN_TOKEN when sandbox admin routes are enabled on a remote runtime", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@db.example.org:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_API_URL: "https://ipfs.example.org",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
        SP_PUBLIC_BASE_URL: "https://protocol.example.org",
        SP_PUBLIC_DOMAIN: "protocol.example.org",
        SP_ENABLE_SANDBOX_ADMIN_ROUTES: "true",
      }),
    ).to.throw(
      "SP_DEMO_ADMIN_TOKEN is required when SP_ENABLE_SANDBOX_ADMIN_ROUTES=true on a remote runtime",
    );
  });

  it("accepts a remote staging environment with public-host settings", () => {
    const result = validateRuntimeEnvironment({
      SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      SP_RPC_URL: "https://base.example.org",
      SP_ARTIFACT_BACKEND: "ipfs",
      SP_ARTIFACT_IPFS_API_URL: "http://127.0.0.1:5001",
      SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
      SP_OPERATOR_PRIVATE_KEY: "0x1234",
      SP_PUBLIC_BASE_URL: "https://demo.example.org",
      SP_PUBLIC_DOMAIN: "demo.example.org",
      SP_PUBLIC_RATE_LIMIT_WINDOW_MS: "60000",
      SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS: "20",
      SP_ADMIN_RATE_LIMIT_WINDOW_MS: "60000",
      SP_ADMIN_RATE_LIMIT_MAX_REQUESTS: "10",
      SP_TRUST_PROXY: "true",
    });

    expect(result).to.deep.equal({
      artifactBackend: "ipfs",
      databaseUrl: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      rpcUrl: "https://base.example.org",
    });
  });

  it("rejects a public domain configured as a URL", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "filesystem",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
        SP_PUBLIC_DOMAIN: "https://demo.example.org",
      }),
    ).to.throw("SP_PUBLIC_DOMAIN must be a bare hostname, not a URL");
  });

  it("rejects non-http public base URLs during runtime validation", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "http://127.0.0.1:8545",
        SP_ARTIFACT_BACKEND: "filesystem",
        SP_PUBLIC_BASE_URL: "file:///tmp/protocol",
      }),
    ).to.throw("SP_PUBLIC_BASE_URL must use http or https");
  });

  it("rejects invalid public rate-limit values", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "filesystem",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
        SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS: "-1",
      }),
    ).to.throw("SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS must be a non-negative integer");
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "filesystem",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
        SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS: "1e2",
      }),
    ).to.throw("SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS must be a non-negative integer");
  });

  it("rejects invalid database pool values", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_POOL_MAX: "0",
      }),
    ).to.throw("SP_DATABASE_POOL_MAX must be an integer greater than or equal to 1");
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS: "-1",
      }),
    ).to.throw("SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS must be a non-negative integer");
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS: "1e3",
      }),
    ).to.throw("SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS must be a non-negative integer");
  });

  it("rejects invalid proxy trust settings", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "filesystem",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
        SP_TRUST_PROXY: "sometimes",
      }),
    ).to.throw("SP_TRUST_PROXY must be true or false");
  });

  it("requires a bucket when the gcs artifact backend is selected", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "gcs",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_GCS_BUCKET is required when SP_ARTIFACT_BACKEND=gcs");
  });

  it("rejects unsupported artifact backend values", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "disk",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_BACKEND must be one of: filesystem, http, ipfs, s3, gcs");
  });

  it("requires an IPFS API URL when the ipfs artifact backend is selected", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_IPFS_API_URL must be a valid URL");
  });

  it("accepts the pinata preset for the ipfs artifact backend", () => {
    const result = validateRuntimeEnvironment({
      SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      SP_RPC_URL: "https://base.example.org",
      SP_ARTIFACT_BACKEND: "ipfs",
      SP_ARTIFACT_IPFS_PROVIDER: "pinata",
      SP_ARTIFACT_PINATA_JWT: "pinata-jwt",
      SP_ARTIFACT_PINATA_GATEWAY_URL: "https://science.mypinata.cloud",
      SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
      SP_OPERATOR_PRIVATE_KEY: "0x1234",
    });

    expect(result).to.deep.equal({
      artifactBackend: "ipfs",
      databaseUrl: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      rpcUrl: "https://base.example.org",
    });
  });

  it("requires a pinata jwt when the pinata ipfs provider is selected", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_PROVIDER: "pinata",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_PINATA_JWT is required when SP_ARTIFACT_IPFS_PROVIDER=pinata");
  });

  it("rejects unsupported IPFS provider and Pinata network values", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_PROVIDER: "gateway",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_IPFS_PROVIDER must be one of: kubo, pinata");
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_PROVIDER: "pinata",
        SP_ARTIFACT_PINATA_JWT: "pinata-jwt",
        SP_ARTIFACT_PINATA_NETWORK: "testnet",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_PINATA_NETWORK must be one of: public, private");
  });

  it("requires IPFS auth header settings to be paired", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_API_URL: "http://127.0.0.1:5001",
        SP_ARTIFACT_IPFS_AUTH_HEADER_NAME: "Authorization",
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw(
      "SP_ARTIFACT_IPFS_AUTH_HEADER_NAME and SP_ARTIFACT_IPFS_AUTH_HEADER_VALUE must be set together",
    );
  });

  it("accepts configured ipfs replica targets", () => {
    const result = validateRuntimeEnvironment({
      SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      SP_RPC_URL: "https://base.example.org",
      SP_ARTIFACT_BACKEND: "ipfs",
      SP_ARTIFACT_IPFS_API_URL: "http://127.0.0.1:5001",
      SP_ARTIFACT_IPFS_REPLICA_TARGETS: JSON.stringify([
        {
          apiUrl: "http://127.0.0.1:5002",
          replicaKey: "secondary-kubo",
        },
        {
          pinataJwt: "pinata-jwt",
          provider: "pinata",
          replicaKey: "pinata-public",
        },
      ]),
      SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
      SP_OPERATOR_PRIVATE_KEY: "0x1234",
    });

    expect(result.artifactBackend).to.equal("ipfs");
  });

  it("rejects invalid ipfs replica target configuration", () => {
    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_API_URL: "http://127.0.0.1:5001",
        SP_ARTIFACT_IPFS_REPLICA_TARGETS: JSON.stringify([
          {
            apiUrl: "http://127.0.0.1:5002",
            provider: "gateway",
            replicaKey: "secondary-kubo",
          },
        ]),
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_IPFS_REPLICA_TARGETS[0].provider must be one of: kubo, pinata");

    expect(() =>
      validateRuntimeEnvironment({
        SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_API_URL: "http://127.0.0.1:5001",
        SP_ARTIFACT_IPFS_REPLICA_TARGETS: JSON.stringify([
          {
            replicaKey: "pinata-public",
            provider: "pinata",
          },
        ]),
        SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
        SP_OPERATOR_PRIVATE_KEY: "0x1234",
      }),
    ).to.throw("SP_ARTIFACT_IPFS_REPLICA_TARGETS[0].pinataJwt is required for pinata targets");
  });

  it("accepts a sandbox staging environment that uses the hosted Hardhat RPC defaults", () => {
    const result = validateRuntimeEnvironment({
      SP_DATABASE_URL: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      SP_RPC_URL: "http://hardhat:8545",
      SP_ARTIFACT_BACKEND: "filesystem",
      SP_DEMO_ADMIN_TOKEN: "demo-admin-token",
      SP_PUBLIC_RATE_LIMIT_WINDOW_MS: "60000",
      SP_PUBLIC_RATE_LIMIT_MAX_REQUESTS: "20",
      SP_ADMIN_RATE_LIMIT_WINDOW_MS: "60000",
      SP_ADMIN_RATE_LIMIT_MAX_REQUESTS: "10",
    });

    expect(result).to.deep.equal({
      artifactBackend: "filesystem",
      databaseUrl: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
      rpcUrl: "http://hardhat:8545",
    });
  });

  it("accepts file-backed secret values for remote environments", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sp-env-"));
    const databaseUrlPath = path.join(tempDir, "database-url.txt");
    const pinataJwtPath = path.join(tempDir, "pinata-jwt.txt");
    const demoTokenPath = path.join(tempDir, "demo-admin-token.txt");
    const operatorKeyPath = path.join(tempDir, "operator.key");

    try {
      writeFileSync(
        databaseUrlPath,
        "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol\n",
        "utf8",
      );
      writeFileSync(pinataJwtPath, "pinata-jwt\n", "utf8");
      writeFileSync(demoTokenPath, "demo-admin-token\n", "utf8");
      writeFileSync(operatorKeyPath, "0x1234\n", "utf8");

      const result = validateRuntimeEnvironment({
        SP_DATABASE_URL_FILE: databaseUrlPath,
        SP_RPC_URL: "https://base.example.org",
        SP_ARTIFACT_BACKEND: "ipfs",
        SP_ARTIFACT_IPFS_PROVIDER: "pinata",
        SP_ARTIFACT_PINATA_JWT_FILE: pinataJwtPath,
        SP_DEMO_ADMIN_TOKEN_FILE: demoTokenPath,
        SP_OPERATOR_PRIVATE_KEY_FILE: operatorKeyPath,
      });

      expect(result).to.deep.equal({
        artifactBackend: "ipfs",
        databaseUrl: "postgresql://postgres:secret@127.0.0.1:5432/scientific_protocol",
        rpcUrl: "https://base.example.org",
      });
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
