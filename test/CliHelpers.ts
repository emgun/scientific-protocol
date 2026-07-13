import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { expect } from "chai";
import { keccak256, toUtf8Bytes } from "ethers";
import {
  isCliEntrypoint,
  isMainModule,
  parseCliArgs,
  parseEnumValue,
  parseHttpUrlValue,
  parseIntegerValue,
  parseJsonText,
  parseUrlValue,
  readBooleanEnv,
  readCsvEnv,
  readEnumCsvEnv,
  readEnumEnv,
  readHttpUrlEnv,
  readJsonFileSync,
  readOptionalTrimmedEnv,
  readPositiveIntegerEnv,
  readUrlEnv,
  reportCliLoopError,
  runJsonCliCommand,
  runJsonCliLoop,
} from "../src/shared/cli.js";
import { keccakText } from "../src/shared/hash.js";
import { hasSecretRef, readEnvValue } from "../src/shared/secrets.js";

describe("src/shared/cli.ts", () => {
  it("reads optional trimmed environment values", () => {
    expect(readOptionalTrimmedEnv({ SAMPLE: "  value  " }, "SAMPLE")).to.equal("value");
    expect(readOptionalTrimmedEnv({ SAMPLE: "   " }, "SAMPLE")).to.equal(undefined);
    expect(readOptionalTrimmedEnv({}, "SAMPLE")).to.equal(undefined);
  });

  it("reads direct env values before file-backed env values", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sp-secret-"));
    const secretPath = path.join(tempDir, "secret");
    try {
      writeFileSync(secretPath, "from-file\n", "utf8");

      expect(
        readEnvValue(
          {
            SAMPLE: " from-env ",
            SAMPLE_FILE: secretPath,
          },
          "SAMPLE",
        ),
      ).to.equal("from-env");
      expect(readEnvValue({ SAMPLE_FILE: secretPath }, "SAMPLE")).to.equal("from-file");
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("does not map unrelated environment keys to canonical SP keys", () => {
    expect(
      readEnvValue({ PREDECESSOR_API_BASE_URL: " https://legacy.example.org " }, "SP_API_BASE_URL"),
    ).to.equal(undefined);
    expect(
      readCsvEnv(
        { PREDECESSOR_WORK_AGENT_KINDS: "review_task,replication_job" },
        "SP_WORK_AGENT_KINDS",
      ),
    ).to.deep.equal([]);
    expect(
      hasSecretRef({ PREDECESSOR_RPC_URL_SECRET_REF: "legacy-rpc:latest" }, "SP_RPC_URL"),
    ).to.equal(false);
  });

  it("reports file-backed env read failures with the env key", () => {
    expect(() => readEnvValue({ SAMPLE_FILE: "/tmp/sp-missing-secret" }, "SAMPLE")).to.throw(
      "failed to read SAMPLE_FILE",
    );
  });

  it("hashes UTF-8 text with keccak256", () => {
    expect(keccakText("claim metadata")).to.equal(keccak256(toUtf8Bytes("claim metadata")));
  });

  it("parses comma-separated environment lists", () => {
    expect(readCsvEnv({ VALUES: " alpha, beta ,,gamma " }, "VALUES")).to.deep.equal([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("reads strict boolean environment values", () => {
    expect(readBooleanEnv({ ENABLED: "true" }, "ENABLED", false)).to.equal(true);
    expect(readBooleanEnv({ ENABLED: "false" }, "ENABLED", true)).to.equal(false);
    expect(readBooleanEnv({}, "ENABLED", true)).to.equal(true);
    expect(() => readBooleanEnv({ ENABLED: "yes" }, "ENABLED", false)).to.throw(
      "ENABLED must be true or false",
    );
  });

  it("accepts only declared enum values", () => {
    expect(readEnumEnv({ MODE: "repair" }, "MODE", ["audit", "repair"] as const)).to.equal(
      "repair",
    );
    expect(readEnumEnv({}, "MODE", ["audit", "repair"] as const)).to.equal(undefined);
    expect(() => readEnumEnv({ MODE: "unknown" }, "MODE", ["audit", "repair"] as const)).to.throw(
      "MODE must be one of: audit, repair",
    );
    expect(parseEnumValue(" audit ", "MODE", ["audit", "repair"] as const)).to.equal("audit");
  });

  it("accepts only declared comma-separated enum values", () => {
    expect(
      readEnumCsvEnv({ KINDS: "artifact_maintenance,review_task" }, "KINDS", [
        "artifact_maintenance",
        "replication_job",
        "review_task",
      ] as const),
    ).to.deep.equal(["artifact_maintenance", "review_task"]);
    expect(() =>
      readEnumCsvEnv({ KINDS: "artifact_maintenance,unknown,review_task" }, "KINDS", [
        "artifact_maintenance",
        "replication_job",
        "review_task",
      ] as const),
    ).to.throw("KINDS must be one of: artifact_maintenance, replication_job, review_task");
  });

  it("parses flag-style CLI arguments", () => {
    expect(
      parseCliArgs([
        "--claim-id",
        "1",
        "ignored",
        "--dry-run",
        "--label",
        "epoch-1",
        "--amount-eth=0.05",
      ]),
    ).to.deep.equal({
      "amount-eth": "0.05",
      "claim-id": "1",
      "dry-run": "true",
      label: "epoch-1",
    });
  });

  it("reports the file path when JSON files are malformed", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sp-cli-"));
    const malformedPath = path.join(tempDir, "bad.json");
    try {
      writeFileSync(malformedPath, "{", "utf8");
      expect(() => readJsonFileSync(malformedPath)).to.throw(
        `${malformedPath} must contain valid JSON`,
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("parses URL values with clear env-key errors", () => {
    expect(parseUrlValue(" https://api.example.org/v1 ", "SP_API_BASE_URL")).to.equal(
      "https://api.example.org/v1",
    );
    expect(() => parseUrlValue("not a url", "SP_API_BASE_URL")).to.throw(
      "SP_API_BASE_URL must be a valid URL",
    );
    expect(parseHttpUrlValue(" http://127.0.0.1:3000 ", "SP_API_BASE_URL")).to.equal(
      "http://127.0.0.1:3000",
    );
    expect(() => parseHttpUrlValue("ftp://example.org", "SP_API_BASE_URL")).to.throw(
      "SP_API_BASE_URL must use http or https",
    );
  });

  it("reads URL env values from direct and file-backed configuration", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "sp-url-env-"));
    const urlPath = path.join(tempDir, "url");
    try {
      writeFileSync(urlPath, " https://api-file.example.org \n", "utf8");

      expect(readUrlEnv({}, "SP_API_BASE_URL", "http://127.0.0.1:3000")).to.equal(
        "http://127.0.0.1:3000",
      );
      expect(() => readUrlEnv({}, "SP_API_BASE_URL", "fallback")).to.throw(
        "SP_API_BASE_URL must be a valid URL",
      );
      expect(readUrlEnv({ SP_API_BASE_URL_FILE: urlPath }, "SP_API_BASE_URL", "fallback")).to.equal(
        "https://api-file.example.org",
      );
      expect(() =>
        readUrlEnv({ SP_API_BASE_URL: "api.example.org" }, "SP_API_BASE_URL", "fallback"),
      ).to.throw("SP_API_BASE_URL must be a valid URL");
      expect(
        readHttpUrlEnv(
          { SP_API_BASE_URL: "https://api.example.org" },
          "SP_API_BASE_URL",
          "fallback",
        ),
      ).to.equal("https://api.example.org");
      expect(() =>
        readHttpUrlEnv({ SP_API_BASE_URL: "file:///tmp/api" }, "SP_API_BASE_URL", "fallback"),
      ).to.throw("SP_API_BASE_URL must use http or https");
      expect(() => readHttpUrlEnv({}, "SP_API_BASE_URL", "file:///tmp/api")).to.throw(
        "SP_API_BASE_URL must use http or https",
      );
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("reports the input label when JSON text is malformed", () => {
    expect(() => parseJsonText("{", "https://example.org/health")).to.throw(
      "https://example.org/health must contain valid JSON",
    );
  });

  it("reads bounded positive integer environment values", () => {
    expect(readPositiveIntegerEnv({ LIMIT: "12" }, "LIMIT", 5)).to.equal(12);
    expect(readPositiveIntegerEnv({ LIMIT: "012" }, "LIMIT", 5)).to.equal(12);
    expect(readPositiveIntegerEnv({}, "LIMIT", 5)).to.equal(5);
    expect(readPositiveIntegerEnv({ LIMIT: "500" }, "LIMIT", 5, { max: 200 })).to.equal(200);
    expect(() => readPositiveIntegerEnv({ LIMIT: "0" }, "LIMIT", 5)).to.throw(
      "LIMIT must be an integer greater than or equal to 1",
    );
    expect(() => readPositiveIntegerEnv({ LIMIT: "NaN" }, "LIMIT", 5)).to.throw(
      "LIMIT must be an integer greater than or equal to 1",
    );
    expect(() => readPositiveIntegerEnv({ LIMIT: "1e2" }, "LIMIT", 5)).to.throw(
      "LIMIT must be an integer greater than or equal to 1",
    );
  });

  it("parses bounded integer values with explicit names", () => {
    expect(parseIntegerValue(" 12 ", "limit")).to.equal(12);
    expect(parseIntegerValue("0012", "limit")).to.equal(12);
    expect(parseIntegerValue("50", "bps", { max: 10 })).to.equal(10);
    expect(parseIntegerValue("0", "threshold", { min: 0 })).to.equal(0);
    expect(() => parseIntegerValue("", "threshold", { min: 0 })).to.throw(
      "threshold must be an integer greater than or equal to 0",
    );
    expect(() => parseIntegerValue("1.5", "limit")).to.throw(
      "limit must be an integer greater than or equal to 1",
    );
    expect(() => parseIntegerValue("9007199254740992", "limit")).to.throw(
      "limit must be an integer greater than or equal to 1",
    );
  });

  it("recognizes CLI entrypoint paths beyond argv[1]", () => {
    const moduleUrl = `file://${process.cwd()}/script/deploy-protocol.ts`;
    expect(
      isCliEntrypoint(moduleUrl, [
        "node",
        "node_modules/.bin/hardhat",
        "run",
        "--network",
        "localhost",
        "script/deploy-protocol.ts",
      ]),
    ).to.equal(true);
  });

  it("recognizes an installed package bin symlink as the main module", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "scientific-protocol-bin-"));
    const modulePath = path.join(tempRoot, "cli.js");
    const binPath = path.join(tempRoot, "scientific-protocol-service");
    try {
      writeFileSync(modulePath, "#!/usr/bin/env node\n");
      symlinkSync(modulePath, binPath);
      expect(isMainModule(pathToFileURL(modulePath).href, ["node", binPath])).to.equal(true);
    } finally {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });

  it("reports loop errors without throwing a stack object", () => {
    const originalExitCode = process.exitCode;
    const originalConsoleError = console.error;
    const messages: unknown[] = [];

    try {
      process.exitCode = undefined;
      console.error = (...args: unknown[]) => {
        messages.push(...args);
      };

      reportCliLoopError(new Error("worker failed"));

      expect(messages).to.deep.equal(["worker failed"]);
      expect(process.exitCode).to.equal(1);
    } finally {
      process.exitCode = originalExitCode;
      console.error = originalConsoleError;
    }
  });

  it("does not overlap recurring JSON loop runs", async () => {
    const originalConsoleLog = console.log;
    const originalSetInterval = globalThis.setInterval;
    const logs: unknown[] = [];
    let intervalCallback: (() => void) | null = null;
    let runCount = 0;
    let releaseSecondRun: (() => void) | null = null;

    try {
      console.log = (...args: unknown[]) => {
        logs.push(...args);
      };
      globalThis.setInterval = ((callback: () => void) => {
        intervalCallback = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval;

      await runJsonCliLoop({
        intervalMs: 10,
        once: false,
        async runOnce() {
          runCount += 1;
          if (runCount === 2) {
            await new Promise<void>((resolve) => {
              releaseSecondRun = resolve;
            });
          }
          return { runCount };
        },
      });

      expect(intervalCallback).to.not.equal(null);
      intervalCallback?.();
      intervalCallback?.();

      expect(runCount).to.equal(2);
      releaseSecondRun?.();
      await new Promise((resolve) => setImmediate(resolve));

      expect(logs).to.deep.equal([
        JSON.stringify({ runCount: 1 }, null, 2),
        JSON.stringify({ runCount: 2 }, null, 2),
      ]);
    } finally {
      console.log = originalConsoleLog;
      globalThis.setInterval = originalSetInterval;
    }
  });

  it("reports JSON command errors without throwing a stack object", async () => {
    const originalExitCode = process.exitCode;
    const originalConsoleError = console.error;
    const messages: unknown[] = [];

    try {
      process.exitCode = undefined;
      console.error = (...args: unknown[]) => {
        messages.push(...args);
      };

      await runJsonCliCommand(async () => {
        throw new Error("command failed");
      });

      expect(messages).to.deep.equal(["command failed"]);
      expect(process.exitCode).to.equal(1);
    } finally {
      process.exitCode = originalExitCode;
      console.error = originalConsoleError;
    }
  });
});
