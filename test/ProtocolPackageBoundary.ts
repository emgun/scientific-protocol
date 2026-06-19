import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";

const operatedServicePackages = [
  "@aws-sdk/client-s3",
  "@filoz/synapse-sdk",
  "@google-cloud/storage",
  "@openzeppelin/contracts",
  "pdf-parse",
  "pg",
  "viem",
];

const operatedServiceFilePrefixes = [
  "src/agents/",
  "src/api/",
  "src/artifacts/",
  "src/checkpoints/",
  "src/coordinator/",
  "src/demo/",
  "src/governance/",
  "src/indexer/",
  "src/reputation/",
  "src/resolver/",
  "src/review/",
  "src/sources/",
  "src/submission/",
  "src/work/",
  "src/workers/",
];

type PackageJson = {
  dependencies?: Record<string, string>;
  exports?: Record<string, string>;
  files?: string[];
};

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync("package.json", "utf8")) as PackageJson;
}

function toSourcePath(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const resolved = path.normalize(path.join(path.dirname(fromFile), specifier));
  const candidate = resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : resolved;
  return existsSync(candidate) ? candidate : null;
}

function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importPattern = /^\s*import\s+(?!type\b)(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];/gm;
  const exportPattern = /^\s*export\s+(?!type\b)(?:[\s\S]*?)\s+from\s+["']([^"']+)["'];/gm;
  for (const pattern of [importPattern, exportPattern]) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

function collectRuntimeClosure(entrypoints: string[]): Set<string> {
  const visited = new Set<string>();
  const pending = entrypoints.map((entrypoint) => entrypoint.replace(/^\.\//u, ""));
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const source = readFileSync(current, "utf8");
    for (const specifier of runtimeSpecifiers(source)) {
      const resolved = toSourcePath(specifier, current);
      if (resolved && !visited.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return visited;
}

describe("protocol package boundary", () => {
  it("keeps operated-service packages out of production dependencies", () => {
    const packageJson = loadPackageJson();

    expect(packageJson.dependencies).to.deep.equal({
      ethers: "^6.13.2",
    });
    for (const packageName of operatedServicePackages) {
      expect(packageJson.dependencies ?? {}).not.to.have.property(packageName);
    }
  });

  it("publishes only protocol package files, not operated-service source trees", () => {
    const packageJson = loadPackageJson();
    const files = packageJson.files ?? [];

    expect(files).to.include.members(["README.md", "schemas", "src/generated", "src/sdk"]);
    for (const prefix of operatedServiceFilePrefixes) {
      expect(files, prefix).not.to.include(prefix.slice(0, -1));
    }
  });

  it("keeps exported runtime entrypoints independent of operated-service packages", () => {
    const packageJson = loadPackageJson();
    const entrypoints = Object.values(packageJson.exports ?? {}).filter((entrypoint) =>
      entrypoint.startsWith("./src/"),
    );
    const closure = collectRuntimeClosure(entrypoints);
    const importedPackages = new Set<string>();

    for (const filePath of closure) {
      for (const specifier of runtimeSpecifiers(readFileSync(filePath, "utf8"))) {
        if (!specifier.startsWith(".")) {
          importedPackages.add(specifier);
        }
      }
    }

    for (const packageName of operatedServicePackages) {
      expect([...importedPackages], packageName).not.to.include(packageName);
    }
  });
});
