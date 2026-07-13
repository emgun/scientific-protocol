import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";

const serviceRuntimePackages = [
  "@aws-sdk/client-s3",
  "@filoz/synapse-sdk",
  "@google-cloud/storage",
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
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  exports?: Record<string, string | { import?: string; types?: string }>;
  files?: string[];
  main?: string;
  types?: string;
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

function runtimeExportEntrypoint(
  entrypoint: string | { import?: string; types?: string },
): string | null {
  return typeof entrypoint === "string" ? entrypoint : (entrypoint.import ?? null);
}

function toSourceEntrypoint(entrypoint: string): string | null {
  if (entrypoint.startsWith("./src/")) {
    return entrypoint;
  }
  if (entrypoint.startsWith("./dist/") && entrypoint.endsWith(".js")) {
    return `./src/${entrypoint.slice("./dist/".length, -".js".length)}.ts`;
  }
  return null;
}

describe("protocol package boundary", () => {
  it("declares service runtime packages as production dependencies", () => {
    const packageJson = loadPackageJson();

    for (const packageName of serviceRuntimePackages) {
      expect(packageJson.dependencies ?? {}).to.have.property(packageName);
    }
  });

  it("publishes compiled protocol and service files without source trees", () => {
    const packageJson = loadPackageJson();
    const files = packageJson.files ?? [];

    expect(packageJson.main).to.equal("./dist/sdk/index.js");
    expect(packageJson.types).to.equal("./dist/sdk/index.d.ts");
    expect(files).to.include.members(["README.md", "schemas", "dist", "ops/migrations"]);
    expect(packageJson.bin).to.deep.equal({
      "scientific-protocol-service": "./dist/service/cli.js",
    });
    expect(files.some((file) => file === "src" || file.startsWith("src/"))).to.equal(false);
    for (const prefix of operatedServiceFilePrefixes) {
      expect(files, prefix).not.to.include(prefix.slice(0, -1));
    }
  });

  it("packages every repository-relative document linked from the installed README", () => {
    const packageJson = loadPackageJson();
    const files = packageJson.files ?? [];
    const readme = readFileSync("README.md", "utf8");
    const relativeLinks = [
      ...readme.matchAll(/\[[^\]]+\]\((?!https?:\/\/)([^)#?]+)(?:[?#][^)]*)?\)/gu),
    ]
      .map((match) => path.normalize((match[1] ?? "").replace(/^\.\//u, "")))
      .filter(Boolean);

    for (const linkedPath of relativeLinks) {
      const included = files.some((entry) => {
        const normalizedEntry = path.normalize(entry.replace(/^\.\//u, ""));
        return (
          linkedPath === normalizedEntry || linkedPath.startsWith(`${normalizedEntry}${path.sep}`)
        );
      });
      expect(included, `README link ${linkedPath} is absent from package.json files`).to.equal(
        true,
      );
    }
  });

  it("keeps SDK entrypoints independent of service runtime packages", () => {
    const packageJson = loadPackageJson();
    const entrypoints = Object.entries(packageJson.exports ?? {})
      .filter(([name]) => name !== "./service")
      .map(([, entrypoint]) => entrypoint)
      .map(runtimeExportEntrypoint)
      .filter((entrypoint): entrypoint is string => entrypoint !== null)
      .map(toSourceEntrypoint)
      .filter((entrypoint): entrypoint is string => entrypoint !== null);
    const closure = collectRuntimeClosure(entrypoints);
    const importedPackages = new Set<string>();

    for (const filePath of closure) {
      for (const specifier of runtimeSpecifiers(readFileSync(filePath, "utf8"))) {
        if (!specifier.startsWith(".")) {
          importedPackages.add(specifier);
        }
      }
    }

    for (const packageName of serviceRuntimePackages) {
      expect([...importedPackages], packageName).not.to.include(packageName);
    }
  });

  it("exports the compiled reference service entrypoint", () => {
    const packageJson = loadPackageJson();
    expect(packageJson.exports?.["./service"]).to.deep.equal({
      types: "./dist/service/index.d.ts",
      import: "./dist/service/index.js",
    });
  });
});
