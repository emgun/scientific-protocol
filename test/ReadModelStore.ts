import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import {
  DEFAULT_READ_MODEL_PATH,
  getReadModelPath,
  resolveReadModelSyncConfig,
} from "../src/indexer/projector.js";
import {
  createReadModelPool,
  DEFAULT_DATABASE_URL,
  getDatabaseUrl,
  resolveDatabasePoolConfig,
} from "../src/indexer/store.js";
import { resolveEtherInput, resolveNonEmptyStringInput } from "../src/shared/numbers.js";
import { normalizePagination } from "../src/shared/pagination.js";

describe("read model store configuration", () => {
  it("keeps the exported default database url independent of process env", () => {
    expect(DEFAULT_DATABASE_URL).to.equal(
      "postgresql://postgres@127.0.0.1:5432/scientific_protocol",
    );
  });

  it("keeps the exported default read model path independent of process env", () => {
    expect(DEFAULT_READ_MODEL_PATH.endsWith("/ops/read-model.json")).to.equal(true);
  });

  it("resolves read model paths from runtime environment", () => {
    expect(getReadModelPath({ SP_READ_MODEL_PATH: " ops/custom-read-model.json " })).to.equal(
      "ops/custom-read-model.json",
    );
  });

  it("resolves read model paths from file-backed runtime environment", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-read-model-path-"));
    const readModelPathFile = path.join(tempRoot, "read-model-path");
    try {
      await writeFile(readModelPathFile, " ops/read-model.file-backed.json \n", "utf8");

      expect(getReadModelPath({ SP_READ_MODEL_PATH_FILE: readModelPathFile })).to.equal(
        "ops/read-model.file-backed.json",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("resolves database urls from runtime environment", () => {
    expect(
      getDatabaseUrl({ SP_DATABASE_URL: " postgresql://postgres:secret@db.example.org/osp " }),
    ).to.equal("postgresql://postgres:secret@db.example.org/osp");
  });

  it("resolves database urls from file-backed runtime environment", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-database-url-"));
    const databaseUrlPath = path.join(tempRoot, "database-url");
    try {
      await writeFile(
        databaseUrlPath,
        " postgresql://postgres:secret@db-file.example.org/osp \n",
        "utf8",
      );

      expect(getDatabaseUrl({ SP_DATABASE_URL_FILE: databaseUrlPath })).to.equal(
        "postgresql://postgres:secret@db-file.example.org/osp",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("resolves read model sync config from one runtime environment", () => {
    expect(
      resolveReadModelSyncConfig({
        SP_DATABASE_URL: "postgresql://postgres:secret@db.example.org/osp",
        SP_DEPLOYMENT_PATH: "ops/deployments/custom.json",
        SP_READ_MODEL_PATH: "ops/read-model.custom.json",
      }),
    ).to.deep.equal({
      databaseUrl: "postgresql://postgres:secret@db.example.org/osp",
      deploymentPath: "ops/deployments/custom.json",
      outputPath: "ops/read-model.custom.json",
    });
  });

  it("resolves explicit database pool bounds from runtime environment", () => {
    expect(
      resolveDatabasePoolConfig("postgresql://postgres:secret@db.example.org/osp", {
        SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS: " 2500 ",
        SP_DATABASE_POOL_IDLE_TIMEOUT_MS: " 15000 ",
        SP_DATABASE_POOL_MAX: " 7 ",
      }),
    ).to.deep.equal({
      connectionString: "postgresql://postgres:secret@db.example.org/osp",
      connectionTimeoutMillis: 2500,
      idleTimeoutMillis: 15000,
      max: 7,
    });
    expect(() =>
      resolveDatabasePoolConfig("postgresql://postgres:secret@db.example.org/osp", {
        SP_DATABASE_POOL_MAX: "0",
      }),
    ).to.throw("SP_DATABASE_POOL_MAX must be an integer greater than or equal to 1");
  });

  it("creates database pools from explicit runtime environment", async () => {
    const pool = createReadModelPool("postgresql://postgres:secret@db.example.org/osp", {
      SP_DATABASE_POOL_CONNECTION_TIMEOUT_MS: "2500",
      SP_DATABASE_POOL_IDLE_TIMEOUT_MS: "15000",
      SP_DATABASE_POOL_MAX: "7",
    });
    try {
      expect(pool.options).to.include({
        connectionString: "postgresql://postgres:secret@db.example.org/osp",
        connectionTimeoutMillis: 2500,
        idleTimeoutMillis: 15000,
        max: 7,
      });
    } finally {
      await pool.end();
    }
  });

  it("normalizes optional string and ether inputs consistently", () => {
    expect(resolveNonEmptyStringInput("  explicit value  ", "fallback")).to.equal("explicit value");
    expect(resolveNonEmptyStringInput("   ", "fallback")).to.equal("fallback");
    expect(resolveEtherInput(" 0.02 ", "0.01")).to.equal(20_000_000_000_000_000n);
    expect(resolveEtherInput(undefined, "0.01")).to.equal(10_000_000_000_000_000n);
  });

  it("normalizes store pagination consistently", () => {
    expect(normalizePagination({})).to.deep.equal({ limit: 20, offset: 0 });
    expect(normalizePagination({ limit: 500, offset: -5 })).to.deep.equal({
      limit: 100,
      offset: 0,
    });
    expect(normalizePagination({ limit: 2.9, offset: 3.7 })).to.deep.equal({
      limit: 2,
      offset: 3,
    });
  });
});
