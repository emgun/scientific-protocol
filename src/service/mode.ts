import { parseEnumValue, readOptionalTrimmedEnv } from "../shared/cli.js";

export const SERVICE_MODES = ["read-only", "write-enabled"] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

/** Resolves the gateway authority boundary. Omitted configuration fails safe to read-only. */
export function resolveServiceMode(env: NodeJS.ProcessEnv = process.env): ServiceMode {
  return (
    parseEnumValue(
      readOptionalTrimmedEnv(env, "SP_SERVICE_MODE"),
      "SP_SERVICE_MODE",
      SERVICE_MODES,
    ) ?? "read-only"
  );
}

export function serviceWritesEnabled(mode: ServiceMode): boolean {
  return mode === "write-enabled";
}

export function assertWriteEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!serviceWritesEnabled(resolveServiceMode(env))) {
    throw new Error("service command requires SP_SERVICE_MODE=write-enabled");
  }
}
