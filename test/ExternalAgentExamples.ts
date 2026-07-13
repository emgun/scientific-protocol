import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixture = JSON.parse(
  await readFile("examples/external-agent/fixtures/gateway-responses.json", "utf8"),
) as Record<string, unknown>;

async function withFixtureGateway<T>(run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture").pathname;
    const payload =
      pathname === "/health"
        ? fixture.health
        : pathname === "/claims"
          ? fixture.claims
          : pathname === "/work-items"
            ? fixture.workItems
            : null;
    response.writeHead(payload ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(payload ?? { error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("external agent examples", () => {
  for (const [runtime, executable, script] of [
    ["TypeScript", process.execPath, "examples/external-agent/typescript/read-claim-work.mjs"],
    ["Python", "python3", "examples/external-agent/python/read_claim_work.py"],
  ] as const) {
    it(`${runtime} reads public gateway state without credentials`, async () => {
      await withFixtureGateway(async (baseUrl) => {
        const { stdout } = await exec(executable, [script], {
          env: { PATH: process.env.PATH, SP_GATEWAY_URL: baseUrl },
        });
        const output = JSON.parse(stdout) as {
          claimIds: string[];
          claimableWorkIds: string[];
          healthy: boolean;
        };
        assert.equal(output.healthy, true);
        assert.deepEqual(output.claimIds, ["7"]);
        assert.deepEqual(output.claimableWorkIds, ["review:7:1"]);
      });
    });
  }
});
