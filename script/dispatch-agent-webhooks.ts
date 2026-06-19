import { prepareAgentWebhookStore, runAgentWebhookDispatchCycle } from "../src/agents/webhooks.js";
import { getDatabaseUrl } from "../src/indexer/store.js";
import { ScientificProtocolClient } from "../src/sdk/client.js";
import { isMainModule, readHttpUrlEnv, readPositiveIntegerEnv } from "../src/shared/cli.js";

export type AgentWebhookDispatchConfig = {
  apiBaseUrl: string;
  databaseUrl: string;
  deliveryLimit: number;
  maxAttempts: number;
  syncPageLimit: number;
};

export function resolveAgentWebhookDispatchConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentWebhookDispatchConfig {
  return {
    apiBaseUrl: readHttpUrlEnv(env, "SP_API_BASE_URL", "http://127.0.0.1:3000"),
    databaseUrl: getDatabaseUrl(env),
    deliveryLimit: readPositiveIntegerEnv(env, "SP_AGENT_WEBHOOK_DELIVERY_LIMIT", 50),
    maxAttempts: readPositiveIntegerEnv(env, "SP_AGENT_WEBHOOK_MAX_ATTEMPTS", 5),
    syncPageLimit: readPositiveIntegerEnv(env, "SP_AGENT_WEBHOOK_SYNC_PAGE_LIMIT", 100),
  };
}

export async function dispatchAgentWebhooksFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof runAgentWebhookDispatchCycle>>> {
  const config = resolveAgentWebhookDispatchConfig(env);

  const pool = await prepareAgentWebhookStore(config.databaseUrl);
  try {
    const client = new ScientificProtocolClient({ baseUrl: config.apiBaseUrl });
    const result = await runAgentWebhookDispatchCycle({
      client,
      deliveryLimit: config.deliveryLimit,
      maxAttempts: config.maxAttempts,
      pool,
      syncPageLimit: config.syncPageLimit,
    });
    return result;
  } finally {
    await pool.end();
  }
}

if (isMainModule(import.meta.url)) {
  dispatchAgentWebhooksFromEnv()
    .then((result) => {
      console.log(JSON.stringify({ ok: true, result }, null, 2));
    })
    .catch((error) => {
      console.error(
        JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            ok: false,
          },
          null,
          2,
        ),
      );
      process.exitCode = 1;
    });
}
