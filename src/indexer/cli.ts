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
  const model = await syncReadModel(deploymentPath, outputPath, databaseUrl, { env });

  return {
    deploymentPath,
    outputPath,
    databaseUrl,
    claims: model.claims.length,
    artifacts: model.artifacts.length,
    replications: model.replications.length,
    checkpoints: model.checkpoints.length,
    agents: model.agents.length,
    forecasts: model.forecasts.length,
    challenges: model.challenges.length,
    appeals: model.appeals.length,
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
