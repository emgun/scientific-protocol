import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";

type Queryable = Pool | PoolClient;

export type DemoScenarioView = {
  claimId: string;
  detail: string;
  domainId: number;
  eyebrow: string;
  proofPoint: string | null;
  scenarioKey: string;
  summary: string;
  title: string;
  updatedAt: string;
  whyItMatters: string | null;
};

export async function prepareDemoStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

function toDemoScenarioView(row: {
  claim_id: string;
  detail: string;
  domain_id: string | number;
  eyebrow: string;
  proof_point: string | null;
  scenario_key: string;
  summary: string;
  title: string;
  updated_at: Date;
  why_it_matters: string | null;
}): DemoScenarioView {
  return {
    scenarioKey: row.scenario_key,
    claimId: row.claim_id,
    domainId: Number(row.domain_id),
    eyebrow: row.eyebrow,
    title: row.title,
    summary: row.summary,
    detail: row.detail,
    whyItMatters: row.why_it_matters,
    proofPoint: row.proof_point,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function upsertDemoScenario(
  queryable: Queryable,
  input: {
    claimId: string;
    detail: string;
    domainId: number;
    eyebrow: string;
    proofPoint?: string | null;
    scenarioKey: string;
    summary: string;
    title: string;
    whyItMatters?: string | null;
  },
): Promise<DemoScenarioView> {
  const result = await queryable.query(
    `
      INSERT INTO demo_scenarios (
        scenario_key,
        claim_id,
        domain_id,
        eyebrow,
        title,
        summary,
        detail,
        why_it_matters,
        proof_point,
        updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (scenario_key)
      DO UPDATE SET
        claim_id = EXCLUDED.claim_id,
        domain_id = EXCLUDED.domain_id,
        eyebrow = EXCLUDED.eyebrow,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        detail = EXCLUDED.detail,
        why_it_matters = EXCLUDED.why_it_matters,
        proof_point = EXCLUDED.proof_point,
        updated_at = NOW()
      RETURNING
        scenario_key,
        claim_id,
        domain_id,
        eyebrow,
        title,
        summary,
        detail,
        why_it_matters,
        proof_point,
        updated_at
    `,
    [
      input.scenarioKey,
      input.claimId,
      input.domainId,
      input.eyebrow,
      input.title,
      input.summary,
      input.detail,
      input.whyItMatters ?? null,
      input.proofPoint ?? null,
    ],
  );

  return toDemoScenarioView(result.rows[0]);
}

export async function readDemoScenarios(queryable: Queryable): Promise<DemoScenarioView[]> {
  const result = await queryable.query(
    `
      SELECT
        scenario_key,
        claim_id,
        domain_id,
        eyebrow,
        title,
        summary,
        detail,
        why_it_matters,
        proof_point,
        updated_at
      FROM demo_scenarios
      ORDER BY
        CASE scenario_key
          WHEN 'full-claim-object' THEN 1
          WHEN 'operational-loop' THEN 2
          ELSE 100
        END,
        updated_at DESC
    `,
  );

  return result.rows.map((row) => toDemoScenarioView(row));
}

export async function readDemoScenario(
  queryable: Queryable,
  scenarioKey: string,
): Promise<DemoScenarioView | null> {
  const result = await queryable.query(
    `
      SELECT
        scenario_key,
        claim_id,
        domain_id,
        eyebrow,
        title,
        summary,
        detail,
        why_it_matters,
        proof_point,
        updated_at
      FROM demo_scenarios
      WHERE scenario_key = $1
    `,
    [scenarioKey],
  );

  return result.rowCount ? toDemoScenarioView(result.rows[0]) : null;
}
