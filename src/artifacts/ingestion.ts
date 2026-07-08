import { execFile as execFileCallback } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Pool } from "pg";
import { prepareCoordinatorStore, upsertPersistedArtifact } from "../coordinator/store.js";
import { getContract } from "../shared/contracts.js";
import { getDeploymentPath, loadDeploymentFile } from "../shared/deployment.js";
import { isIpfsUrl, parseIpfsUrl } from "../shared/ipfs.js";
import { resolveOptionalIntegerInput } from "../shared/numbers.js";
import { createManagedOperatorSigner } from "../shared/operator.js";
import {
  type ArtifactPersistenceOptions,
  type PersistedArtifactRecord,
  persistBinaryArtifact,
  persistFileArtifact,
  persistJsonArtifact,
  readPersistedArtifactBytes,
} from "../shared/persisted-artifacts.js";

const execFile = promisify(execFileCallback);

const README_CANDIDATES = [
  "README.md",
  "README.mdx",
  "README.txt",
  "README.rst",
  "readme.md",
  "readme.txt",
  "readme.rst",
];

const CLAIM_SENTENCE_HINTS = [
  "achieve",
  "achieves",
  "cause",
  "causes",
  "demonstrate",
  "demonstrates",
  "fails",
  "fails to",
  "improve",
  "improves",
  "increase",
  "increases",
  "maintain",
  "maintains",
  "outperform",
  "outperforms",
  "preserve",
  "preserves",
  "reduce",
  "reduces",
  "replicate",
  "replicates",
  "support",
  "supports",
];

type CoordinatorConnection = Pool | string | undefined;

type ArtifactSourceBaseInput = {
  artifactType?: number;
  domainId?: number;
  metadata?: string;
  methodology?: string;
  predictionHooks?: string;
  requestedBy?: string;
  scope?: string;
  statement?: string;
};

export type ArtifactUrlDraftInput = ArtifactSourceBaseInput & {
  sourceType: "url";
  sourceUrl: string;
};

export type RepositoryDraftInput = ArtifactSourceBaseInput & {
  ref?: string;
  repositoryUrl: string;
  sourceType: "repository";
};

export type ArtifactDraftInput = ArtifactUrlDraftInput | RepositoryDraftInput;

export type ArtifactExtractionPreview = {
  candidateStatements: string[];
  extractedTextPreview: string;
  metadata: string;
  methodology: string;
  predictionHooks: string;
  scope: string;
  sourceDescriptor: string;
  statement: string;
  summary: string;
  title: string;
};

export type ArtifactIngestionResult = {
  artifactType: number;
  extractionArtifact: PersistedArtifactRecord;
  preview: ArtifactExtractionPreview;
  snapshotArtifact: PersistedArtifactRecord;
  sourceLocator: string;
  sourceType: "repository" | "url";
  sourceVersion: {
    cid?: string | null;
    commitHash?: string | null;
    contentType: string;
    extension: string;
    finalUrl?: string | null;
    ref?: string | null;
  };
};

export type DraftClaimFromArtifactResult = ArtifactIngestionResult & {
  artifactIds: {
    extractionArtifactId: string | null;
    snapshotArtifactId: string | null;
  };
  claimId: string;
  createdBy: string;
  txHashes: {
    addExtractionArtifact: string;
    addSnapshotArtifact: string;
    createClaim: string;
  };
};

type ExtractionContext = {
  extension: string;
  sourceDescriptor: string;
  sourceType: "repository" | "url";
  titleHint?: string | null;
  versionLabel?: string | null;
};

type ExtractedTextResult = {
  sourceText: string;
  titleHint?: string | null;
};

type SnapshotResult = {
  artifactType: number;
  contentType: string;
  extension: string;
  sourceLocator: string;
  sourceType: "repository" | "url";
  snapshotArtifact: PersistedArtifactRecord;
  sourceText: string;
  titleHint?: string | null;
  version: {
    cid?: string | null;
    commitHash?: string | null;
    finalUrl?: string | null;
    ref?: string | null;
  };
};

function normalizeNonEmpty(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function keccakText(value: string): string {
  return keccak256(toUtf8Bytes(value));
}

function extractEventId(
  contract: {
    interface: {
      parseLog(
        log: unknown,
      ): { args: Record<string, { toString(): string }>; name?: string } | null;
    };
  },
  receipt: { logs: Array<unknown> },
  eventName: string,
  argName: string,
): string | null {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed.args[argName].toString();
      }
    } catch {
      // Skip unrelated logs.
    }
  }
  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstNonEmptyLine(value: string): string | null {
  for (const line of value.split(/\r?\n/)) {
    const normalized = normalizeWhitespace(line);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function inferContentTypeFromExtension(extension: string): string {
  const normalized = extension.replace(/^\./, "").toLowerCase();
  switch (normalized) {
    case "pdf":
      return "application/pdf";
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "md":
      return "text/markdown; charset=utf-8";
    case "json":
      return "application/json";
    case "txt":
    case "text":
      return "text/plain; charset=utf-8";
    case "zip":
      return "application/zip";
    case "tar":
      return "application/x-tar";
    case "gz":
    case "tgz":
    case "tar.gz":
      return "application/gzip";
    default:
      return "application/octet-stream";
  }
}

function extensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase();
  if (normalized.includes("application/pdf")) {
    return "pdf";
  }
  if (normalized.includes("text/html")) {
    return "html";
  }
  if (normalized.includes("text/markdown")) {
    return "md";
  }
  if (normalized.includes("text/plain")) {
    return "txt";
  }
  if (normalized.includes("application/json")) {
    return "json";
  }
  if (normalized.includes("application/zip")) {
    return "zip";
  }
  if (normalized.includes("application/gzip") || normalized.includes("application/x-gzip")) {
    return "gz";
  }
  return "bin";
}

function inferExtensionFromUrl(rawUrl: string): string | null {
  const pathname = new URL(rawUrl).pathname;
  const basename = path.basename(pathname);
  if (!basename.includes(".")) {
    return null;
  }
  if (basename.endsWith(".tar.gz")) {
    return "tar.gz";
  }
  return basename.split(".").pop() ?? null;
}

function inferLocalPathExtension(localPath: string): string | null {
  const basename = path.basename(localPath);
  if (!basename.includes(".")) {
    return null;
  }
  if (basename.endsWith(".tar.gz")) {
    return "tar.gz";
  }
  return basename.split(".").pop() ?? null;
}

function defaultArtifactType(sourceType: "repository" | "url", extension: string): number {
  if (sourceType === "repository") {
    return 1;
  }
  if (extension.toLowerCase() === "pdf") {
    return 5;
  }
  if (["html", "htm", "md", "txt"].includes(extension.toLowerCase())) {
    return 5;
  }
  if (["zip", "tar", "tgz", "tar.gz", "gz"].includes(extension.toLowerCase())) {
    return 1;
  }
  return 7;
}

function htmlToText(html: string): string {
  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">"),
  );
}

function markdownToText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function extractAbstractSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = normalizeWhitespace(lines[index] ?? "").toLowerCase();
    if (!["abstract", "summary"].includes(heading)) {
      continue;
    }

    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const current = lines[cursor] ?? "";
      const normalized = normalizeWhitespace(current);
      if (!normalized) {
        if (body.length > 0) {
          break;
        }
        continue;
      }
      if (/^[A-Z][A-Za-z0-9 /:-]{2,80}$/.test(normalized) && body.length > 0) {
        break;
      }
      body.push(normalized);
    }

    const extracted = normalizeWhitespace(body.join(" "));
    if (extracted.length >= 40) {
      return extracted;
    }
  }

  return null;
}

function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 40);
}

function pickClaimSentence(sentences: string[]): string | null {
  const normalizedHints = CLAIM_SENTENCE_HINTS.map((hint) => hint.toLowerCase());
  const hinted = sentences.find((sentence) => {
    const lower = sentence.toLowerCase();
    return normalizedHints.some((hint) => lower.includes(hint));
  });
  if (hinted) {
    return hinted;
  }

  return sentences.find((sentence) => sentence.length >= 60 && sentence.length <= 280) ?? null;
}

function deriveTitle(text: string, hint: string | null | undefined, fallback: string): string {
  const explicitHint = hint ? normalizeWhitespace(hint) : "";
  if (explicitHint) {
    return explicitHint.slice(0, 180);
  }

  const firstLine = firstNonEmptyLine(text);
  if (firstLine && firstLine.length <= 180) {
    return firstLine;
  }

  const firstSentence = splitSentences(text)[0];
  return (firstSentence ?? fallback).slice(0, 180);
}

function deriveSummary(text: string, title: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return `${title} was ingested into a protocol-controlled artifact snapshot.`;
  }
  if (normalized.startsWith(title)) {
    return normalized.slice(0, 260);
  }
  return `${title}. ${normalized}`.slice(0, 260);
}

function buildExtractionPreview(
  input: ArtifactDraftInput,
  extractedText: string,
  context: ExtractionContext,
): ArtifactExtractionPreview {
  const normalizedText = normalizeWhitespace(extractedText);
  const candidateSourceText = extractAbstractSection(extractedText) ?? normalizedText;
  const title = deriveTitle(
    extractedText,
    context.titleHint,
    context.sourceType === "repository" ? "Repository snapshot" : "Manuscript snapshot",
  );
  const sentences = splitSentences(candidateSourceText);
  const chosenStatement =
    normalizeNonEmpty(input.statement, pickClaimSentence(sentences) ?? title) ||
    (context.sourceType === "repository" ? "Repository snapshot draft claim" : "Draft claim");
  const versionSuffix = context.versionLabel ? ` (${context.versionLabel})` : "";
  const methodologyDefault =
    context.sourceType === "repository"
      ? `Automatically extracted from the repository snapshot${versionSuffix}.`
      : `Automatically extracted from the manuscript snapshot${versionSuffix}.`;
  const scopeDefault =
    context.sourceType === "repository"
      ? "Limited to the behavior and assertions visible in the ingested repository snapshot."
      : "Limited to the assertion and evidence visible in the ingested manuscript snapshot.";
  const metadataDefault = JSON.stringify(
    {
      sourceDescriptor: context.sourceDescriptor,
      sourceType: context.sourceType,
      title,
      versionLabel: context.versionLabel ?? null,
    },
    null,
    2,
  );

  return {
    candidateStatements: sentences.slice(0, 5),
    extractedTextPreview: normalizedText.slice(0, 1_200),
    metadata: normalizeNonEmpty(input.metadata, metadataDefault),
    methodology: normalizeNonEmpty(input.methodology, methodologyDefault),
    predictionHooks: normalizeNonEmpty(
      input.predictionHooks,
      "auto-ingested artifact draft; requires explicit review before publication",
    ),
    scope: normalizeNonEmpty(input.scope, scopeDefault),
    sourceDescriptor: context.sourceDescriptor,
    statement: chosenStatement,
    summary: deriveSummary(normalizedText, title),
    title,
  };
}

async function maybeReadLocalFile(rawLocator: string): Promise<{
  bytes: Buffer;
  contentType: string;
  extension: string;
  locator: string;
} | null> {
  const localPath = rawLocator.startsWith("file://")
    ? fileURLToPath(rawLocator)
    : path.resolve(rawLocator);
  try {
    const localStats = await stat(localPath);
    if (!localStats.isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  const extension = inferLocalPathExtension(localPath) ?? "bin";
  return {
    bytes: await readFile(localPath),
    contentType: inferContentTypeFromExtension(extension),
    extension,
    locator: localPath,
  };
}

async function extractTextFromBytes(
  bytes: Buffer,
  contentType: string,
  extension: string,
): Promise<ExtractedTextResult> {
  const normalizedType = contentType.toLowerCase();
  const normalizedExtension = extension.toLowerCase();

  if (normalizedType.includes("application/pdf") || normalizedExtension === "pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: bytes });
    try {
      const [parsedText, parsedInfo] = await Promise.all([parser.getText(), parser.getInfo()]);
      return {
        sourceText: parsedText.text ?? "",
        titleHint: parsedInfo.info?.Title ? String(parsedInfo.info.Title) : null,
      };
    } finally {
      await parser.destroy();
    }
  }

  const text = bytes.toString("utf8");
  if (normalizedType.includes("text/html") || ["html", "htm"].includes(normalizedExtension)) {
    return { sourceText: htmlToText(text) };
  }
  if (normalizedType.includes("text/markdown") || normalizedExtension === "md") {
    return { sourceText: markdownToText(text) };
  }

  if (normalizedType.includes("application/json") || normalizedExtension === "json") {
    try {
      return { sourceText: JSON.stringify(JSON.parse(text), null, 2) };
    } catch {
      return { sourceText: text };
    }
  }

  return { sourceText: sanitizeDecodedText(text) };
}

/// Unknown content types get decoded as UTF-8 opportunistically; binary
/// formats (DjVu, images, archives) then leak NUL and other control bytes
/// that Postgres JSON columns reject outright. Strip them, and when what
/// remains is mostly non-textual, treat the source as yielding no text so
/// extraction degrades cleanly instead of storing garbage candidates.
function sanitizeDecodedText(text: string): string {
  const stripped = text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control bytes is the point
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/gu,
    " ",
  );
  const printable = stripped.replace(/[^\p{L}\p{N}\p{P} ]/gu, "");
  if (text.length > 0 && printable.length / text.length < 0.5) {
    return "";
  }
  return stripped;
}

async function snapshotUrlSource(
  input: ArtifactUrlDraftInput,
  persistenceOptions: ArtifactPersistenceOptions,
): Promise<SnapshotResult> {
  if (!input.sourceUrl || input.sourceUrl.trim() === "") {
    throw new Error("sourceUrl is required");
  }
  const configuredArtifactType = resolveOptionalIntegerInput(input.artifactType, "artifactType", {
    min: 1,
  });
  const localFile = await maybeReadLocalFile(input.sourceUrl);
  let bytes: Buffer;
  let contentType: string;
  let extension: string;
  let cid: string | null = null;
  let finalUrl: string | null = null;
  let sourceLocator = input.sourceUrl;
  let stagedFilePath: string | null = null;
  let stagedTempRoot: string | null = null;

  try {
    if (isIpfsUrl(input.sourceUrl)) {
      bytes = await readPersistedArtifactBytes(
        {
          storagePath: input.sourceUrl,
        },
        persistenceOptions,
      );
      extension = inferExtensionFromUrl(input.sourceUrl) ?? "bin";
      contentType = inferContentTypeFromExtension(extension);
      cid = parseIpfsUrl(input.sourceUrl).cid;
    } else if (localFile) {
      bytes = localFile.bytes;
      contentType = localFile.contentType;
      extension = localFile.extension;
      sourceLocator = localFile.locator;
      stagedFilePath = localFile.locator;
    } else {
      const response = await fetch(input.sourceUrl);
      if (!response.ok) {
        throw new Error(`artifact source fetch failed with status ${response.status}`);
      }
      contentType =
        response.headers.get("content-type") ??
        inferContentTypeFromExtension(inferExtensionFromUrl(input.sourceUrl) ?? "bin");
      extension =
        inferExtensionFromUrl(response.url || input.sourceUrl) ??
        extensionFromContentType(contentType);
      finalUrl = response.url || input.sourceUrl;
      stagedTempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-artifact-fetch-"));
      stagedFilePath = path.join(
        stagedTempRoot,
        `source.${normalizeNonEmpty(extension, "bin").replace(/\//g, "-")}`,
      );
      if (response.body) {
        await pipeline(
          Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
          createWriteStream(stagedFilePath),
        );
      } else {
        await writeFile(stagedFilePath, Buffer.from(await response.arrayBuffer()));
      }
      bytes = await readFile(stagedFilePath);
    }

    const persistedSnapshotArtifact = stagedFilePath
      ? await persistFileArtifact(
          "artifact-source-snapshot",
          stagedFilePath,
          {
            contentType,
            extension,
          },
          persistenceOptions,
        )
      : await persistBinaryArtifact(
          "artifact-source-snapshot",
          bytes,
          {
            contentType,
            extension,
          },
          persistenceOptions,
        );
    const snapshotArtifact = {
      ...persistedSnapshotArtifact,
      provenance: {
        cid: cid ?? null,
        finalUrl: finalUrl ?? null,
        metadata: {
          artifactType: configuredArtifactType ?? defaultArtifactType("url", extension),
          contentType,
          extension,
        },
        ref: null,
        sourceLocator,
        sourceType: isIpfsUrl(input.sourceUrl) ? "ipfs" : "url",
      },
    };

    const extracted = await extractTextFromBytes(bytes, contentType, extension);

    return {
      artifactType: configuredArtifactType ?? defaultArtifactType("url", extension),
      contentType,
      extension,
      snapshotArtifact,
      sourceLocator,
      sourceText: extracted.sourceText,
      sourceType: "url",
      titleHint: extracted.titleHint ?? null,
      version: {
        cid,
        finalUrl,
        ref: null,
      },
    };
  } finally {
    if (stagedTempRoot) {
      await rm(stagedTempRoot, { force: true, recursive: true });
    }
  }
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

async function runGit(
  args: string[],
  cwd?: string,
): Promise<{
  stderr: string;
  stdout: string;
}> {
  return execFile("git", args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function extractRepositoryReadme(repoPath: string, ref: string): Promise<string> {
  for (const candidate of README_CANDIDATES) {
    try {
      const { stdout } = await runGit(["show", `${ref}:${candidate}`], repoPath);
      if (normalizeWhitespace(stdout)) {
        return stdout;
      }
    } catch {
      // Try the next README candidate.
    }
  }

  try {
    const { stdout } = await runGit(["ls-tree", "-r", "--name-only", ref], repoPath);
    const matched = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => /(^|\/)readme(\.[^/]+)?$/i.test(entry));
    if (matched) {
      return (await runGit(["show", `${ref}:${matched}`], repoPath)).stdout;
    }
  } catch {
    // Fall through to package metadata or empty text.
  }

  try {
    const packageJson = (await runGit(["show", `${ref}:package.json`], repoPath)).stdout;
    const parsed = JSON.parse(packageJson) as { description?: string; name?: string };
    return [parsed.name, parsed.description].filter(Boolean).join("\n\n");
  } catch {
    return "";
  }
}

async function snapshotRepositorySource(
  input: RepositoryDraftInput,
  persistenceOptions: ArtifactPersistenceOptions,
): Promise<SnapshotResult> {
  if (!input.repositoryUrl || input.repositoryUrl.trim() === "") {
    throw new Error("repositoryUrl is required");
  }
  const artifactType =
    resolveOptionalIntegerInput(input.artifactType, "artifactType", { min: 1 }) ?? 1;
  const maybeLocalPath = input.repositoryUrl.startsWith("file://")
    ? fileURLToPath(input.repositoryUrl)
    : path.resolve(input.repositoryUrl);
  const localRepo = (await pathExists(path.join(maybeLocalPath, ".git"))) ? maybeLocalPath : null;
  const tempRoot = localRepo ? null : await mkdtemp(path.join(os.tmpdir(), "sp-repo-ingest-"));
  const workspaceRoot = tempRoot ?? localRepo;
  if (!workspaceRoot) {
    throw new Error("failed to allocate repository snapshot workspace");
  }
  const repoPath = localRepo ?? path.join(workspaceRoot, "repo");

  try {
    if (!localRepo) {
      const cloneArgs = ["clone", "--quiet", "--depth", "1"];
      if (input.ref?.trim()) {
        cloneArgs.push("--branch", input.ref.trim());
      }
      cloneArgs.push(input.repositoryUrl, repoPath);
      await runGit(cloneArgs);
    }

    const resolvedRef = normalizeNonEmpty(input.ref, "HEAD");
    const commitHash = normalizeWhitespace(
      (await runGit(["rev-parse", resolvedRef], repoPath)).stdout,
    );
    const archivePath = path.join(tempRoot ?? repoPath, "snapshot.tar.gz");
    await runGit(["archive", "--format=tar.gz", `--output=${archivePath}`, commitHash], repoPath);
    const readme = await extractRepositoryReadme(repoPath, commitHash);
    const repoName =
      path.basename(input.repositoryUrl.replace(/\/+$/, "")).replace(/\.git$/i, "") ||
      "Repository snapshot";
    const persistedSnapshotArtifact = await persistFileArtifact(
      "artifact-repository-snapshot",
      archivePath,
      {
        contentType: "application/gzip",
        extension: "tar.gz",
      },
      persistenceOptions,
    );
    const snapshotArtifact = {
      ...persistedSnapshotArtifact,
      provenance: {
        commitHash,
        metadata: {
          artifactType,
          contentType: "application/gzip",
          extension: "tar.gz",
          repositoryName: repoName,
        },
        ref: input.ref?.trim() || null,
        sourceLocator: input.repositoryUrl,
        sourceType: "repository",
      },
    };

    return {
      artifactType,
      contentType: "application/gzip",
      extension: "tar.gz",
      snapshotArtifact,
      sourceLocator: input.repositoryUrl,
      sourceText: readme,
      sourceType: "repository",
      titleHint: repoName,
      version: {
        commitHash,
        ref: input.ref?.trim() || null,
      },
    };
  } finally {
    if (tempRoot) {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }
}

export async function ingestArtifactSource(
  input: ArtifactDraftInput,
  persistenceOptions: ArtifactPersistenceOptions = {},
): Promise<ArtifactIngestionResult> {
  resolveOptionalIntegerInput(input.domainId, "domainId");
  const snapshot =
    input.sourceType === "repository"
      ? await snapshotRepositorySource(input, persistenceOptions)
      : await snapshotUrlSource(input, persistenceOptions);

  const preview = buildExtractionPreview(input, snapshot.sourceText, {
    extension: snapshot.extension,
    sourceDescriptor: snapshot.sourceLocator,
    sourceType: snapshot.sourceType,
    titleHint: snapshot.titleHint,
    versionLabel: snapshot.version.commitHash ?? snapshot.version.finalUrl ?? null,
  });

  const persistedExtractionArtifact = await persistJsonArtifact(
    "claim-draft-extraction",
    {
      artifactType: snapshot.artifactType,
      extractedAt: new Date().toISOString(),
      preview,
      sourceLocator: snapshot.sourceLocator,
      sourceType: snapshot.sourceType,
      sourceVersion: {
        cid: snapshot.version.cid ?? null,
        commitHash: snapshot.version.commitHash ?? null,
        contentType: snapshot.contentType,
        extension: snapshot.extension,
        finalUrl: snapshot.version.finalUrl ?? null,
        ref: snapshot.version.ref ?? null,
      },
      snapshotArtifact: snapshot.snapshotArtifact,
    },
    persistenceOptions,
  );
  const extractionArtifact = {
    ...persistedExtractionArtifact,
    provenance: {
      cid: snapshot.version.cid ?? null,
      commitHash: snapshot.version.commitHash ?? null,
      derivedFromArtifactKey: snapshot.snapshotArtifact.artifactKey,
      finalUrl: snapshot.version.finalUrl ?? null,
      metadata: {
        artifactType: snapshot.artifactType,
        extractedFor: "claim-draft-preview",
        sourceType: snapshot.sourceType,
      },
      ref: snapshot.version.ref ?? null,
      sourceLocator: snapshot.sourceLocator,
      sourceType: "derived",
    },
  };

  return {
    artifactType: snapshot.artifactType,
    extractionArtifact,
    preview,
    snapshotArtifact: snapshot.snapshotArtifact,
    sourceLocator: snapshot.sourceLocator,
    sourceType: snapshot.sourceType,
    sourceVersion: {
      cid: snapshot.version.cid ?? null,
      commitHash: snapshot.version.commitHash ?? null,
      contentType: snapshot.contentType,
      extension: snapshot.extension,
      finalUrl: snapshot.version.finalUrl ?? null,
      ref: snapshot.version.ref ?? null,
    },
  };
}

export async function createDraftClaimFromArtifact(
  input: ArtifactDraftInput,
  connection?: CoordinatorConnection,
  persistenceOptions: ArtifactPersistenceOptions = {},
  options: {
    authorAddress?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<DraftClaimFromArtifactResult> {
  const env = options.env ?? process.env;
  const domainId = resolveOptionalIntegerInput(input.domainId, "domainId") ?? 1;
  const ingestion = await ingestArtifactSource(input, { env, ...persistenceOptions });

  const ownsPool = typeof connection === "string" || connection === undefined;
  const pool =
    typeof connection === "string" || connection === undefined
      ? await prepareCoordinatorStore(connection)
      : connection;

  try {
    const snapshotPersisted = await upsertPersistedArtifact(pool, ingestion.snapshotArtifact);
    const extractionPersisted = await upsertPersistedArtifact(pool, ingestion.extractionArtifact);

    const deployment = await loadDeploymentFile(getDeploymentPath(env), { env });
    const submitterSigner = createManagedOperatorSigner(
      [
        "SP_CLAIM_SUBMITTER_PRIVATE_KEY",
        "SP_CLAIM_AUTHOR_PRIVATE_KEY",
        "SP_PROTOCOL_ADMIN_PRIVATE_KEY",
        "SP_OPERATOR_PRIVATE_KEY",
      ],
      { env, localAccountIndex: 0 },
    );
    const claimRegistry = await getContract(
      "ClaimRegistry",
      deployment.addresses.claimRegistry,
      submitterSigner,
    );
    const artifactRegistry = await getContract(
      "ArtifactRegistry",
      deployment.addresses.artifactRegistry,
      submitterSigner,
    );
    const authorAddress =
      typeof options.authorAddress === "string" && options.authorAddress.trim().length > 0
        ? options.authorAddress.trim()
        : await submitterSigner.getAddress();

    const createTx = await claimRegistry.createClaimOnBehalf(
      {
        statementHash: keccakText(ingestion.preview.statement),
        methodologyHash: keccakText(ingestion.preview.methodology),
        scopeHash: keccakText(ingestion.preview.scope),
        metadataHash: ingestion.extractionArtifact.sha256,
        predictionHooksHash: keccakText(ingestion.preview.predictionHooks),
        domainId: BigInt(domainId),
        author: authorAddress,
      },
      0n,
      "0x0000000000000000000000000000000000000000",
    );
    const createReceipt = await createTx.wait();
    const claimId = extractEventId(claimRegistry, createReceipt, "ClaimCreated", "claimId");
    if (!claimId) {
      throw new Error(`claim transaction ${createReceipt.hash} did not emit ClaimCreated`);
    }

    const addSnapshotArtifactTx = await artifactRegistry.addArtifact(
      BigInt(claimId),
      BigInt(ingestion.artifactType),
      ingestion.snapshotArtifact.sha256,
      ingestion.snapshotArtifact.storagePath,
      ingestion.extractionArtifact.sha256,
    );
    const addSnapshotArtifactReceipt = await addSnapshotArtifactTx.wait();
    const snapshotArtifactId = extractEventId(
      artifactRegistry,
      addSnapshotArtifactReceipt,
      "ArtifactAdded",
      "artifactId",
    );

    const addExtractionArtifactTx = await artifactRegistry.addArtifact(
      BigInt(claimId),
      7n,
      ingestion.extractionArtifact.sha256,
      ingestion.extractionArtifact.storagePath,
      keccakText(
        JSON.stringify({
          kind: "claim-draft-extraction",
          persistedArtifactKey: extractionPersisted.artifactKey,
          sourceArtifactKey: snapshotPersisted.artifactKey,
        }),
      ),
    );
    const addExtractionArtifactReceipt = await addExtractionArtifactTx.wait();
    const extractionArtifactId = extractEventId(
      artifactRegistry,
      addExtractionArtifactReceipt,
      "ArtifactAdded",
      "artifactId",
    );

    return {
      ...ingestion,
      artifactIds: {
        extractionArtifactId,
        snapshotArtifactId,
      },
      claimId,
      createdBy: authorAddress,
      txHashes: {
        addExtractionArtifact: addExtractionArtifactReceipt.hash,
        addSnapshotArtifact: addSnapshotArtifactReceipt.hash,
        createClaim: createReceipt.hash,
      },
    };
  } finally {
    if (ownsPool) {
      await pool.end();
    }
  }
}
