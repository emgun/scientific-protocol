const PRIVILEGED_PUBLIC_SERVICE_KEYS = [
  "SP_OPERATOR_PRIVATE_KEY",
  "SP_PROTOCOL_ADMIN_PRIVATE_KEY",
  "SP_CLAIM_AUTHOR_PRIVATE_KEY",
  "SP_REPLICATOR_PRIVATE_KEY",
  "SP_AGENT_OPERATOR_PRIVATE_KEY",
  "SP_REPLICATION_SUBMITTER_PRIVATE_KEY",
  "SP_RESOLVER_PRIVATE_KEY",
  "SP_CHECKPOINT_PUBLISHER_PRIVATE_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

export function assertPublicServiceCredentialBoundary(env: NodeJS.ProcessEnv): void {
  if (env.SP_PUBLIC_SERVICE !== "true") return;
  const configured = PRIVILEGED_PUBLIC_SERVICE_KEYS.filter(
    (key) => env[key]?.trim() || env[`${key}_FILE`]?.trim() || env[`${key}_SECRET_REF`]?.trim(),
  );
  if (configured.length > 0) {
    throw new Error(
      `public service must not carry privileged credentials: ${configured.join(", ")}`,
    );
  }
  if (env.SP_REFERENCE_CANARY_MODE === "true") {
    throw new Error("public service must not enable SP_REFERENCE_CANARY_MODE");
  }
}
