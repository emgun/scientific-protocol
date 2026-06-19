import { readFileSync } from "node:fs";

export type EnvRecord = Record<string, string | undefined>;

function normalizeValue(value: string, trim: boolean): string {
  return trim ? value.trim() : value;
}

export function readEnvValue(
  env: EnvRecord,
  key: string,
  options: {
    trim?: boolean;
  } = {},
): string | undefined {
  const trim = options.trim !== false;
  const directValue = env[key];
  if (typeof directValue === "string" && directValue.trim() !== "") {
    return normalizeValue(directValue, trim);
  }

  const filePath = env[`${key}_FILE`]?.trim();
  if (!filePath) {
    return undefined;
  }

  try {
    const fileValue = readFileSync(filePath, "utf8");
    return normalizeValue(fileValue, trim);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read ${key}_FILE (${filePath}): ${detail}`);
  }
}

export function hasConfiguredEnvValue(env: EnvRecord, key: string): boolean {
  return Boolean(readEnvValue(env, key) || hasSecretRef(env, key));
}

export function hasSecretRef(env: EnvRecord, key: string): boolean {
  const secretRef = env[`${key}_SECRET_REF`];
  return typeof secretRef === "string" && secretRef.trim() !== "";
}
