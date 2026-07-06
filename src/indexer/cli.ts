import { isMainModule } from "../shared/cli.js";
import { resolveReadModelSyncConfig, syncReadModel } from "./projector.js";

export async function syncReadModelFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{
  deploymentPath: string;
  outputPath: string;
  databaseUrl: string;
  claims: number;
  artifacts: number;
  replications: number;
  checkpoints: number;
  agents: number;
  forecasts: number;
  challenges: number;
  appeals: number;
}> {
  const { databaseUrl, deploymentPath, outputPath } = resolveReadModelSyncConfig(env);
  const summary = await syncReadModel(deploymentPath, outputPath, databaseUrl, { env });

  return {
    deploymentPath,
    outputPath,
    databaseUrl,
    claims: summary.counts.claims,
    artifacts: summary.counts.artifacts,
    replications: summary.counts.replications,
    checkpoints: summary.counts.checkpoints,
    agents: summary.counts.agents,
    forecasts: summary.counts.forecasts,
    challenges: summary.counts.challenges,
    appeals: summary.counts.appeals,
  };
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(await syncReadModelFromEnv(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
