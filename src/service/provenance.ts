import { readOptionalTrimmedEnv } from "../shared/cli.js";

export type ServiceProvenance = {
  buildDate: string | null;
  imageRevision: string | null;
  version: string;
};

/** Build metadata injected by the release container without requiring package.json at runtime. */
export function serviceProvenance(env: NodeJS.ProcessEnv = process.env): ServiceProvenance {
  return {
    buildDate: readOptionalTrimmedEnv(env, "SP_SERVICE_BUILD_DATE") ?? null,
    imageRevision: readOptionalTrimmedEnv(env, "SP_SERVICE_REVISION") ?? null,
    version: readOptionalTrimmedEnv(env, "SP_SERVICE_VERSION") ?? "development",
  };
}
