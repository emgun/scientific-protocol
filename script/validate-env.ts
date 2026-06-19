import { isMainModule } from "../src/shared/cli.js";
import { validateRuntimeEnvironment } from "../src/shared/env.js";

export function validateEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const result = validateRuntimeEnvironment(env);
  return { ok: true, ...result };
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(JSON.stringify(validateEnvironmentFromEnv(), null, 2));
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  }
}
