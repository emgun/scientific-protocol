import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import { normalizePagination } from "../shared/pagination.js";
import type { ClaimRewardWorkKind } from "./types.js";

type Queryable = Pool | PoolClient;

export type WorkRewardSettlementView = {
  accruedTotalWei: string;
  agentId: string | null;
  amountWei: string;
  budgetTopUpBps: number;
  claimId: string;
  createdAt: string;
  itemId: string;
  marketPressureBps: number;
  policyVersion: string;
  qualityBps: number;
  recipient: string;
  settlementId: string;
  settlementLabel: string;
  targetTotalWei: string;
  txHash: string;
  workKind: ClaimRewardWorkKind;
};

export type WorkRewardSettlementListOptions = {
  agentId?: string;
  claimId?: string;
  itemId?: string;
  limit?: number;
  offset?: number;
  policyVersion?: string;
  recipient?: string;
  workKind?: ClaimRewardWorkKind;
};

export type WorkRewardSettlementTotalsOptions = {
  agentId?: string;
  claimId?: string;
  itemId?: string;
  policyVersion?: string;
  recipient?: string;
  workKind?: ClaimRewardWorkKind;
};

type WorkRewardSettlementRow = {
  accruedTotalWei: string;
  agentId: string | null;
  amountWei: string;
  budgetTopUpBps: number;
  claimId: string;
  createdAt: Date;
  itemId: string;
  marketPressureBps: number;
  policyVersion: string;
  qualityBps: number;
  recipient: string;
  settlementId: string;
  settlementLabel: string;
  targetTotalWei: string;
  txHash: string;
  workKind: ClaimRewardWorkKind;
};

type WorkRewardSettlementTotalRow = {
  amountWei: string;
  settlementCount: string;
  workKind: ClaimRewardWorkKind;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

export type WorkRewardSettlementWorkKindTotalView = {
  amountWei: string;
  settlementCount: number;
  workKind: ClaimRewardWorkKind;
};

export type WorkRewardSettlementTotalsView = {
  byWorkKind: WorkRewardSettlementWorkKindTotalView[];
  settlementCount: number;
  totalAmountWei: string;
};

function mapWorkRewardSettlementRow(row: WorkRewardSettlementRow): WorkRewardSettlementView {
  return {
    accruedTotalWei: row.accruedTotalWei,
    agentId: row.agentId,
    amountWei: row.amountWei,
    budgetTopUpBps: row.budgetTopUpBps,
    claimId: row.claimId,
    createdAt: row.createdAt.toISOString(),
    itemId: row.itemId,
    marketPressureBps: row.marketPressureBps,
    policyVersion: row.policyVersion,
    qualityBps: row.qualityBps,
    recipient: row.recipient,
    settlementId: row.settlementId,
    settlementLabel: row.settlementLabel,
    targetTotalWei: row.targetTotalWei,
    txHash: row.txHash,
    workKind: row.workKind,
  };
}

export async function prepareRewardStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function insertWorkRewardSettlement(
  queryable: Queryable,
  input: Omit<WorkRewardSettlementView, "createdAt">,
): Promise<WorkRewardSettlementView> {
  const result = await queryable.query<WorkRewardSettlementRow>(
    `
      INSERT INTO work_reward_settlements (
        settlement_id,
        item_id,
        claim_id,
        work_kind,
        policy_version,
        settlement_label,
        tx_hash,
        recipient,
        agent_id,
        amount_wei,
        accrued_total_wei,
        target_total_wei,
        market_pressure_bps,
        quality_bps,
        budget_top_up_bps
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING
        settlement_id AS "settlementId",
        item_id AS "itemId",
        claim_id AS "claimId",
        work_kind AS "workKind",
        policy_version AS "policyVersion",
        settlement_label AS "settlementLabel",
        tx_hash AS "txHash",
        recipient,
        agent_id AS "agentId",
        amount_wei::text AS "amountWei",
        accrued_total_wei::text AS "accruedTotalWei",
        target_total_wei::text AS "targetTotalWei",
        market_pressure_bps AS "marketPressureBps",
        quality_bps AS "qualityBps",
        budget_top_up_bps AS "budgetTopUpBps",
        created_at AS "createdAt"
    `,
    [
      input.settlementId,
      input.itemId,
      input.claimId,
      input.workKind,
      input.policyVersion,
      input.settlementLabel,
      input.txHash,
      input.recipient,
      input.agentId,
      input.amountWei,
      input.accruedTotalWei,
      input.targetTotalWei,
      input.marketPressureBps,
      input.qualityBps,
      input.budgetTopUpBps,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`failed to insert work reward settlement for ${input.itemId}`);
  }
  return mapWorkRewardSettlementRow(row);
}

export async function readAccruedRewardTotals(
  queryable: Queryable,
  policyVersion: string,
): Promise<
  Map<
    string,
    {
      accruedWei: bigint;
      count: number;
    }
  >
> {
  const result = await queryable.query<{
    accruedWei: string;
    count: string;
    itemId: string;
  }>(
    `
      SELECT
        item_id AS "itemId",
        COALESCE(SUM(amount_wei), 0)::text AS "accruedWei",
        COUNT(*)::text AS count
      FROM work_reward_settlements
      WHERE policy_version = $1
      GROUP BY item_id
    `,
    [policyVersion],
  );
  return new Map(
    result.rows.map((row) => [
      row.itemId,
      {
        accruedWei: BigInt(row.accruedWei),
        count: Number(row.count),
      },
    ]),
  );
}

export async function readWorkRewardSettlementsPage(
  queryable: Queryable,
  options: WorkRewardSettlementListOptions = {},
): Promise<PageResult<WorkRewardSettlementView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.itemId) {
    values.push(options.itemId);
    clauses.push(`item_id = $${values.length}`);
  }
  if (options.policyVersion) {
    values.push(options.policyVersion);
    clauses.push(`policy_version = $${values.length}`);
  }
  if (options.recipient) {
    values.push(options.recipient);
    clauses.push(`recipient = $${values.length}`);
  }
  if (options.workKind) {
    values.push(options.workKind);
    clauses.push(`work_kind = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM work_reward_settlements${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<WorkRewardSettlementRow>(
    `
      SELECT
        settlement_id AS "settlementId",
        item_id AS "itemId",
        claim_id AS "claimId",
        work_kind AS "workKind",
        policy_version AS "policyVersion",
        settlement_label AS "settlementLabel",
        tx_hash AS "txHash",
        recipient,
        agent_id AS "agentId",
        amount_wei::text AS "amountWei",
        accrued_total_wei::text AS "accruedTotalWei",
        target_total_wei::text AS "targetTotalWei",
        market_pressure_bps AS "marketPressureBps",
        quality_bps AS "qualityBps",
        budget_top_up_bps AS "budgetTopUpBps",
        created_at AS "createdAt"
      FROM work_reward_settlements
      ${whereClause}
      ORDER BY created_at DESC, settlement_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );

  return {
    items: result.rows.map(mapWorkRewardSettlementRow),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

export async function readWorkRewardSettlementTotals(
  queryable: Queryable,
  options: WorkRewardSettlementTotalsOptions = {},
): Promise<WorkRewardSettlementTotalsView> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.claimId) {
    values.push(options.claimId);
    clauses.push(`claim_id = $${values.length}`);
  }
  if (options.itemId) {
    values.push(options.itemId);
    clauses.push(`item_id = $${values.length}`);
  }
  if (options.policyVersion) {
    values.push(options.policyVersion);
    clauses.push(`policy_version = $${values.length}`);
  }
  if (options.recipient) {
    values.push(options.recipient);
    clauses.push(`recipient = $${values.length}`);
  }
  if (options.workKind) {
    values.push(options.workKind);
    clauses.push(`work_kind = $${values.length}`);
  }

  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const [summaryResult, groupedResult] = await Promise.all([
    queryable.query<{ settlementCount: string; totalAmountWei: string }>(
      `
        SELECT
          COUNT(*)::text AS "settlementCount",
          COALESCE(SUM(amount_wei), 0)::text AS "totalAmountWei"
        FROM work_reward_settlements
        ${whereClause}
      `,
      values,
    ),
    queryable.query<WorkRewardSettlementTotalRow>(
      `
        SELECT
          work_kind AS "workKind",
          COALESCE(SUM(amount_wei), 0)::text AS "amountWei",
          COUNT(*)::text AS "settlementCount"
        FROM work_reward_settlements
        ${whereClause}
        GROUP BY work_kind
        ORDER BY work_kind ASC
      `,
      values,
    ),
  ]);

  return {
    byWorkKind: groupedResult.rows.map((row) => ({
      amountWei: row.amountWei,
      settlementCount: Number(row.settlementCount),
      workKind: row.workKind,
    })),
    settlementCount: Number(summaryResult.rows[0]?.settlementCount ?? "0"),
    totalAmountWei: summaryResult.rows[0]?.totalAmountWei ?? "0",
  };
}
