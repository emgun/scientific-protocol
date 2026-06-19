import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvValue } from "./secrets.js";

export function isMainModule(moduleUrl: string, argv: string[] = process.argv): boolean {
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }

  return fileURLToPath(moduleUrl) === path.resolve(entryPath);
}

export function isCliEntrypoint(moduleUrl: string, argv: string[] = process.argv): boolean {
  if (isMainModule(moduleUrl, argv)) {
    return true;
  }
  const modulePath = fileURLToPath(moduleUrl);
  return argv.slice(2).some((entry) => path.resolve(entry) === modulePath);
}

export function readOptionalTrimmedEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  return readEnvValue(env, key) ?? undefined;
}

export function parseUrlValue(value: string, key: string): string {
  const trimmed = value.trim();
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`${key} must be a valid URL`);
  }
  return trimmed;
}

export function parseHttpUrlValue(value: string, key: string): string {
  const trimmed = parseUrlValue(value, key);
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use http or https`);
  }
  return trimmed;
}

export function readUrlEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = readEnvValue(env, key);
  return value === undefined ? parseUrlValue(fallback, key) : parseUrlValue(value, key);
}

export function readHttpUrlEnv(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = readEnvValue(env, key);
  return value === undefined ? parseHttpUrlValue(fallback, key) : parseHttpUrlValue(value, key);
}

export function readCsvEnv(env: NodeJS.ProcessEnv, key: string): string[] {
  return (readEnvValue(env, key) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readBooleanEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const value = readOptionalTrimmedEnv(env, key);
  if (!value) {
    return fallback;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`${key} must be true or false`);
}

export function readEnumEnv<const Value extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: readonly Value[],
): Value | undefined {
  return parseEnumValue(readOptionalTrimmedEnv(env, key), key, values);
}

export function parseEnumValue<const Value extends string>(
  raw: string | undefined,
  key: string,
  values: readonly Value[],
): Value | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if ((values as readonly string[]).includes(value)) {
    return value as Value;
  }
  throw new Error(`${key} must be one of: ${values.join(", ")}`);
}

export function readEnumCsvEnv<const Value extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: readonly Value[],
): Value[] {
  return readCsvEnv(env, key).map((entry) => parseEnumValue(entry, key, values) as Value);
}

export function parseIntegerValue(
  value: string,
  key: string,
  options: { max?: number; min?: number } = {},
): number {
  const trimmed = value.trim();
  const min = options.min ?? 1;
  if (!/^\d+$/u.test(trimmed)) {
    throw new Error(`${key} must be an integer greater than or equal to ${min}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${key} must be an integer greater than or equal to ${min}`);
  }
  return options.max === undefined ? parsed : Math.min(parsed, options.max);
}

export function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  options: { max?: number; min?: number } = {},
): number {
  const value = readOptionalTrimmedEnv(env, key);
  if (!value) {
    return fallback;
  }
  return parseIntegerValue(value, key, options);
}

export function parseCliArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const equalsIndex = key.indexOf("=");
    if (equalsIndex >= 0) {
      parsed[key.slice(0, equalsIndex)] = key.slice(equalsIndex + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

export function readJsonFileSync<T = unknown>(filePath: string): T {
  return parseJsonText(readFileSync(filePath, "utf8"), filePath);
}

export function parseJsonText<T = unknown>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} must contain valid JSON`, { cause: error });
    }
    throw error;
  }
}

export function reportCliLoopError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

export async function runJsonCliLoop<T>(input: {
  intervalMs: number;
  once: boolean;
  runOnce: () => Promise<T>;
}): Promise<void> {
  let inFlight = false;
  const printResult = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      console.log(JSON.stringify(await input.runOnce(), null, 2));
    } finally {
      inFlight = false;
    }
  };

  await printResult();
  if (!input.once) {
    setInterval(() => {
      void printResult().catch(reportCliLoopError);
    }, input.intervalMs);
  }
}

export async function runJsonCliCommand<T>(run: () => Promise<T>): Promise<void> {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
