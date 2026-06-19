import { createHmac, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { createReadModelPool, DEFAULT_DATABASE_URL, migrateReadModelDb } from "../indexer/store.js";
import type { ScientificProtocolClient } from "../sdk/client.js";
import { normalizePagination } from "../shared/pagination.js";
import { AGENT_RUNTIME_EVENT_TYPES, type AgentRuntimeEventView } from "./runtime-events.js";

type Queryable = Pool | PoolClient;

export const AGENT_WEBHOOK_EVENT_TYPES = [...AGENT_RUNTIME_EVENT_TYPES, "webhook.ping"] as const;

export type AgentWebhookEventType = (typeof AGENT_WEBHOOK_EVENT_TYPES)[number];
export type AgentWebhookSubscriptionStatus = "active" | "inactive";
export type AgentWebhookDeliveryStatus = "delivered" | "failed" | "pending" | "retrying";

export type AgentWebhookSubscriptionView = {
  actorAddress: string;
  agentId: string;
  createdAt: string;
  cursorEventId: string | null;
  cursorOccurredAt: string | null;
  eventTypes: AgentWebhookEventType[];
  failureReason: string | null;
  label: string | null;
  lastDeliveryAt: string | null;
  lastEnqueuedAt: string | null;
  signingSecretPreview: string;
  status: AgentWebhookSubscriptionStatus;
  subscriptionId: string;
  targetUrl: string;
  updatedAt: string;
};

export type AgentWebhookSubscriptionSecretView = AgentWebhookSubscriptionView & {
  signingSecret: string;
};

export type AgentWebhookDeliveryView = {
  agentId: string;
  attempts: number;
  createdAt: string;
  deliveredAt: string | null;
  deliveryId: string;
  eventId: string;
  eventType: AgentWebhookEventType;
  lastAttemptedAt: string | null;
  nextAttemptAt: string;
  occurredAt: string;
  payload: Record<string, unknown>;
  responseBody: string | null;
  responseStatus: number | null;
  signature: string | null;
  status: AgentWebhookDeliveryStatus;
  subscriptionId: string;
  updatedAt: string;
};

export type AgentWebhookSubscriptionListOptions = {
  agentId?: string;
  limit?: number;
  offset?: number;
  status?: AgentWebhookSubscriptionStatus;
};

export type AgentWebhookDeliveryListOptions = {
  agentId?: string;
  limit?: number;
  offset?: number;
  status?: AgentWebhookDeliveryStatus;
  subscriptionId?: string;
};

export type PageResult<T> = {
  items: T[];
  limit: number;
  offset: number;
  total: number;
};

type RawAgentWebhookSubscriptionRow = {
  actorAddress: string;
  agentId: string;
  createdAt: Date;
  cursorEventId: string | null;
  cursorOccurredAt: Date | null;
  eventTypes: AgentWebhookEventType[] | null;
  failureReason: string | null;
  label: string | null;
  lastDeliveryAt: Date | null;
  lastEnqueuedAt: Date | null;
  signingSecret: string;
  status: AgentWebhookSubscriptionStatus;
  subscriptionId: string;
  targetUrl: string;
  updatedAt: Date;
};

type RawAgentWebhookDeliveryRow = {
  agentId: string;
  attempts: number;
  createdAt: Date;
  deliveredAt: Date | null;
  deliveryId: string;
  eventId: string;
  eventType: AgentWebhookEventType;
  lastAttemptedAt: Date | null;
  nextAttemptAt: Date;
  occurredAt: Date;
  payload: Record<string, unknown> | null;
  responseBody: string | null;
  responseStatus: number | null;
  signature: string | null;
  status: AgentWebhookDeliveryStatus;
  subscriptionId: string;
  updatedAt: Date;
};

type RuntimeEventsClient = Pick<ScientificProtocolClient, "getAgentRuntimeEvents">;

function signingSecretPreview(secret: string): string {
  if (secret.length <= 16) {
    return secret;
  }
  return `${secret.slice(0, 12)}...${secret.slice(-4)}`;
}

function toAgentWebhookSubscriptionView(
  row: RawAgentWebhookSubscriptionRow,
): AgentWebhookSubscriptionSecretView {
  return {
    actorAddress: row.actorAddress,
    agentId: row.agentId,
    createdAt: row.createdAt.toISOString(),
    cursorEventId: row.cursorEventId,
    cursorOccurredAt: row.cursorOccurredAt?.toISOString() ?? null,
    eventTypes: normalizeAgentWebhookEventTypes(row.eventTypes),
    failureReason: row.failureReason,
    label: row.label,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastEnqueuedAt: row.lastEnqueuedAt?.toISOString() ?? null,
    signingSecret: row.signingSecret,
    signingSecretPreview: signingSecretPreview(row.signingSecret),
    status: row.status,
    subscriptionId: row.subscriptionId,
    targetUrl: row.targetUrl,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAgentWebhookDeliveryView(row: RawAgentWebhookDeliveryRow): AgentWebhookDeliveryView {
  return {
    agentId: row.agentId,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    deliveryId: row.deliveryId,
    eventId: row.eventId,
    eventType: row.eventType,
    lastAttemptedAt: row.lastAttemptedAt?.toISOString() ?? null,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    occurredAt: row.occurredAt.toISOString(),
    payload: row.payload ?? {},
    responseBody: row.responseBody,
    responseStatus: row.responseStatus,
    signature: row.signature,
    status: row.status,
    subscriptionId: row.subscriptionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function trimResponseBody(body: string | null, maxLength = 4_096): string | null {
  if (body === null) {
    return null;
  }
  if (body.length <= maxLength) {
    return body;
  }
  return `${body.slice(0, maxLength)}…`;
}

function compareEventTuple(
  left: { eventId: string; occurredAt: string },
  right: { eventId: string; occurredAt: string },
): number {
  if (left.occurredAt !== right.occurredAt) {
    return left.occurredAt.localeCompare(right.occurredAt);
  }
  return left.eventId.localeCompare(right.eventId);
}

function compareRuntimeEventsAscending(
  left: Pick<AgentRuntimeEventView, "eventId" | "occurredAt">,
  right: Pick<AgentRuntimeEventView, "eventId" | "occurredAt">,
): number {
  return compareEventTuple(left, right);
}

function eventAfterCursor(
  event: Pick<AgentRuntimeEventView, "eventId" | "occurredAt">,
  cursor: {
    eventId: string | null;
    occurredAt: string | null;
  },
): boolean {
  if (!cursor.occurredAt) {
    return true;
  }
  return (
    compareEventTuple(event, {
      eventId: cursor.eventId ?? "",
      occurredAt: cursor.occurredAt,
    }) > 0
  );
}

export function normalizeAgentWebhookEventTypes(
  eventTypes: readonly string[] | null | undefined,
): AgentWebhookEventType[] {
  const allowed = new Set<string>(AGENT_WEBHOOK_EVENT_TYPES);
  const values =
    eventTypes && eventTypes.length > 0
      ? eventTypes.filter((entry): entry is AgentWebhookEventType => allowed.has(entry))
      : [...AGENT_RUNTIME_EVENT_TYPES];
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function matchesAgentWebhookEventType(
  eventTypes: readonly AgentWebhookEventType[] | null | undefined,
  eventType: AgentWebhookEventType,
): boolean {
  const normalized = normalizeAgentWebhookEventTypes(eventTypes);
  return normalized.includes(eventType);
}

export function createAgentWebhookSigningSecret(): string {
  return `ospwhsec_${randomBytes(24).toString("hex")}`;
}

export function signAgentWebhookPayload(input: {
  payloadBody: string;
  secret: string;
  timestamp: string;
}): string {
  return `v1=${createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.payloadBody}`)
    .digest("hex")}`;
}

export function computeAgentWebhookRetryDelayMs(attempts: number): number {
  const normalizedAttempts = Math.max(1, Math.floor(attempts));
  return Math.min(60_000 * 60, 15_000 * 2 ** (normalizedAttempts - 1));
}

export async function prepareAgentWebhookStore(
  connectionString = DEFAULT_DATABASE_URL,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Pool> {
  const pool = createReadModelPool(connectionString, env);
  await migrateReadModelDb(pool);
  return pool;
}

export async function createAgentWebhookSubscription(
  queryable: Queryable,
  input: {
    actorAddress: string;
    agentId: string;
    eventTypes?: AgentWebhookEventType[];
    label?: string | null;
    signingSecret?: string;
    targetUrl: string;
  },
): Promise<AgentWebhookSubscriptionSecretView> {
  const result = await queryable.query<{ subscription_id: string }>(
    `
      INSERT INTO agent_webhook_subscriptions (
        agent_id,
        actor_address,
        label,
        target_url,
        event_types,
        signing_secret,
        status
      ) VALUES ($1, lower($2), $3, $4, $5::jsonb, $6, 'active')
      RETURNING subscription_id::text AS subscription_id
    `,
    [
      input.agentId,
      input.actorAddress,
      input.label ?? null,
      input.targetUrl,
      JSON.stringify(normalizeAgentWebhookEventTypes(input.eventTypes)),
      input.signingSecret ?? createAgentWebhookSigningSecret(),
    ],
  );
  const subscriptionId = result.rows[0]?.subscription_id;
  if (!subscriptionId) {
    throw new Error("agent_webhook_subscription_insert_failed");
  }
  const subscription = await readAgentWebhookSubscriptionSecret(queryable, subscriptionId);
  if (!subscription) {
    throw new Error("agent_webhook_subscription_insert_failed");
  }
  return subscription;
}

export async function readAgentWebhookSubscriptionSecret(
  queryable: Queryable,
  subscriptionId: string,
): Promise<AgentWebhookSubscriptionSecretView | undefined> {
  const result = await queryable.query<RawAgentWebhookSubscriptionRow>(
    `
      SELECT
        subscription_id::text AS "subscriptionId",
        agent_id AS "agentId",
        actor_address AS "actorAddress",
        label,
        target_url AS "targetUrl",
        event_types AS "eventTypes",
        signing_secret AS "signingSecret",
        status,
        cursor_occurred_at AS "cursorOccurredAt",
        cursor_event_id AS "cursorEventId",
        last_enqueued_at AS "lastEnqueuedAt",
        last_delivery_at AS "lastDeliveryAt",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_webhook_subscriptions
      WHERE subscription_id = $1
    `,
    [subscriptionId],
  );
  const row = result.rows[0];
  return row ? toAgentWebhookSubscriptionView(row) : undefined;
}

export async function readAgentWebhookSubscription(
  queryable: Queryable,
  subscriptionId: string,
): Promise<AgentWebhookSubscriptionView | undefined> {
  const subscription = await readAgentWebhookSubscriptionSecret(queryable, subscriptionId);
  if (!subscription) {
    return undefined;
  }
  const { signingSecret: _signingSecret, ...view } = subscription;
  return view;
}

export async function readAgentWebhookSubscriptionsPage(
  queryable: Queryable,
  options: AgentWebhookSubscriptionListOptions = {},
): Promise<PageResult<AgentWebhookSubscriptionView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`agent_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`status = $${values.length}`);
  }
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM agent_webhook_subscriptions${whereClause}`,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<RawAgentWebhookSubscriptionRow>(
    `
      SELECT
        subscription_id::text AS "subscriptionId",
        agent_id AS "agentId",
        actor_address AS "actorAddress",
        label,
        target_url AS "targetUrl",
        event_types AS "eventTypes",
        signing_secret AS "signingSecret",
        status,
        cursor_occurred_at AS "cursorOccurredAt",
        cursor_event_id AS "cursorEventId",
        last_enqueued_at AS "lastEnqueuedAt",
        last_delivery_at AS "lastDeliveryAt",
        failure_reason AS "failureReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_webhook_subscriptions
      ${whereClause}
      ORDER BY created_at DESC, subscription_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );
  return {
    items: result.rows.map((row) => {
      const { signingSecret: _signingSecret, ...view } = toAgentWebhookSubscriptionView(row);
      return view;
    }),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

export async function deactivateAgentWebhookSubscription(
  queryable: Queryable,
  subscriptionId: string,
): Promise<AgentWebhookSubscriptionView | undefined> {
  await queryable.query(
    `
      UPDATE agent_webhook_subscriptions
      SET
        status = 'inactive',
        updated_at = NOW()
      WHERE subscription_id = $1
    `,
    [subscriptionId],
  );
  return readAgentWebhookSubscription(queryable, subscriptionId);
}

export async function updateAgentWebhookSubscriptionCursor(
  queryable: Queryable,
  input: {
    cursorEventId: string;
    cursorOccurredAt: string;
    subscriptionId: string;
  },
): Promise<void> {
  await queryable.query(
    `
      UPDATE agent_webhook_subscriptions
      SET
        cursor_event_id = $2,
        cursor_occurred_at = $3::timestamptz,
        last_enqueued_at = NOW(),
        updated_at = NOW()
      WHERE subscription_id = $1
    `,
    [input.subscriptionId, input.cursorEventId, input.cursorOccurredAt],
  );
}

export async function noteAgentWebhookSubscriptionDelivery(
  queryable: Queryable,
  input: {
    failureReason?: string | null;
    lastDeliveryAt?: string;
    subscriptionId: string;
  },
): Promise<void> {
  await queryable.query(
    `
      UPDATE agent_webhook_subscriptions
      SET
        last_delivery_at = COALESCE($2::timestamptz, last_delivery_at),
        failure_reason = $3,
        updated_at = NOW()
      WHERE subscription_id = $1
    `,
    [input.subscriptionId, input.lastDeliveryAt ?? null, input.failureReason ?? null],
  );
}

export async function enqueueAgentWebhookDelivery(
  queryable: Queryable,
  input: {
    eventId: string;
    eventType: AgentWebhookEventType;
    occurredAt: string;
    payload: Record<string, unknown>;
    subscriptionId: string;
  },
): Promise<AgentWebhookDeliveryView> {
  const result = await queryable.query<{ delivery_id: string }>(
    `
      INSERT INTO agent_webhook_deliveries (
        subscription_id,
        event_id,
        event_type,
        occurred_at,
        payload,
        status,
        next_attempt_at
      ) VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb, 'pending', NOW())
      ON CONFLICT (subscription_id, event_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING delivery_id::text AS delivery_id
    `,
    [
      input.subscriptionId,
      input.eventId,
      input.eventType,
      input.occurredAt,
      JSON.stringify(input.payload),
    ],
  );
  const deliveryId = result.rows[0]?.delivery_id;
  if (!deliveryId) {
    throw new Error("agent_webhook_delivery_insert_failed");
  }
  const delivery = await readAgentWebhookDelivery(queryable, deliveryId);
  if (!delivery) {
    throw new Error("agent_webhook_delivery_insert_failed");
  }
  return delivery;
}

export async function readAgentWebhookDelivery(
  queryable: Queryable,
  deliveryId: string,
): Promise<AgentWebhookDeliveryView | undefined> {
  const result = await queryable.query<RawAgentWebhookDeliveryRow>(
    `
      SELECT
        delivery.delivery_id::text AS "deliveryId",
        delivery.subscription_id::text AS "subscriptionId",
        subscription.agent_id AS "agentId",
        delivery.event_id AS "eventId",
        delivery.event_type AS "eventType",
        delivery.occurred_at AS "occurredAt",
        delivery.payload,
        delivery.status,
        delivery.attempts,
        delivery.next_attempt_at AS "nextAttemptAt",
        delivery.last_attempted_at AS "lastAttemptedAt",
        delivery.delivered_at AS "deliveredAt",
        delivery.response_status AS "responseStatus",
        delivery.response_body AS "responseBody",
        delivery.signature,
        delivery.created_at AS "createdAt",
        delivery.updated_at AS "updatedAt"
      FROM agent_webhook_deliveries AS delivery
      INNER JOIN agent_webhook_subscriptions AS subscription
        ON subscription.subscription_id = delivery.subscription_id
      WHERE delivery.delivery_id = $1
    `,
    [deliveryId],
  );
  const row = result.rows[0];
  return row ? toAgentWebhookDeliveryView(row) : undefined;
}

export async function readAgentWebhookDeliveriesPage(
  queryable: Queryable,
  options: AgentWebhookDeliveryListOptions = {},
): Promise<PageResult<AgentWebhookDeliveryView>> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (options.subscriptionId) {
    values.push(options.subscriptionId);
    clauses.push(`delivery.subscription_id = $${values.length}`);
  }
  if (options.agentId) {
    values.push(options.agentId);
    clauses.push(`subscription.agent_id = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    clauses.push(`delivery.status = $${values.length}`);
  }
  const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset } = normalizePagination(options);
  const countResult = await queryable.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM agent_webhook_deliveries AS delivery
      INNER JOIN agent_webhook_subscriptions AS subscription
        ON subscription.subscription_id = delivery.subscription_id
      ${whereClause}
    `,
    values,
  );
  const pageValues = [...values, limit, offset];
  const result = await queryable.query<RawAgentWebhookDeliveryRow>(
    `
      SELECT
        delivery.delivery_id::text AS "deliveryId",
        delivery.subscription_id::text AS "subscriptionId",
        subscription.agent_id AS "agentId",
        delivery.event_id AS "eventId",
        delivery.event_type AS "eventType",
        delivery.occurred_at AS "occurredAt",
        delivery.payload,
        delivery.status,
        delivery.attempts,
        delivery.next_attempt_at AS "nextAttemptAt",
        delivery.last_attempted_at AS "lastAttemptedAt",
        delivery.delivered_at AS "deliveredAt",
        delivery.response_status AS "responseStatus",
        delivery.response_body AS "responseBody",
        delivery.signature,
        delivery.created_at AS "createdAt",
        delivery.updated_at AS "updatedAt"
      FROM agent_webhook_deliveries AS delivery
      INNER JOIN agent_webhook_subscriptions AS subscription
        ON subscription.subscription_id = delivery.subscription_id
      ${whereClause}
      ORDER BY delivery.created_at DESC, delivery.delivery_id DESC
      LIMIT $${pageValues.length - 1}
      OFFSET $${pageValues.length}
    `,
    pageValues,
  );
  return {
    items: result.rows.map(toAgentWebhookDeliveryView),
    limit,
    offset,
    total: Number(countResult.rows[0]?.count ?? "0"),
  };
}

export async function readDueAgentWebhookDeliveries(
  queryable: Queryable,
  options: { limit?: number } = {},
): Promise<AgentWebhookDeliveryView[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
  const result = await queryable.query<RawAgentWebhookDeliveryRow>(
    `
      SELECT
        delivery.delivery_id::text AS "deliveryId",
        delivery.subscription_id::text AS "subscriptionId",
        subscription.agent_id AS "agentId",
        delivery.event_id AS "eventId",
        delivery.event_type AS "eventType",
        delivery.occurred_at AS "occurredAt",
        delivery.payload,
        delivery.status,
        delivery.attempts,
        delivery.next_attempt_at AS "nextAttemptAt",
        delivery.last_attempted_at AS "lastAttemptedAt",
        delivery.delivered_at AS "deliveredAt",
        delivery.response_status AS "responseStatus",
        delivery.response_body AS "responseBody",
        delivery.signature,
        delivery.created_at AS "createdAt",
        delivery.updated_at AS "updatedAt"
      FROM agent_webhook_deliveries AS delivery
      INNER JOIN agent_webhook_subscriptions AS subscription
        ON subscription.subscription_id = delivery.subscription_id
      WHERE
        subscription.status = 'active'
        AND delivery.status IN ('pending', 'retrying')
        AND delivery.next_attempt_at <= NOW()
      ORDER BY delivery.next_attempt_at ASC, delivery.delivery_id ASC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(toAgentWebhookDeliveryView);
}

export async function markAgentWebhookDeliveryDelivered(
  queryable: Queryable,
  input: {
    attempts: number;
    deliveredAt: string;
    deliveryId: string;
    responseBody?: string | null;
    responseStatus?: number | null;
    signature: string;
  },
): Promise<AgentWebhookDeliveryView | undefined> {
  await queryable.query(
    `
      UPDATE agent_webhook_deliveries
      SET
        attempts = $2,
        status = 'delivered',
        last_attempted_at = $3::timestamptz,
        delivered_at = $3::timestamptz,
        response_status = $4,
        response_body = $5,
        signature = $6,
        updated_at = NOW()
      WHERE delivery_id = $1
    `,
    [
      input.deliveryId,
      input.attempts,
      input.deliveredAt,
      input.responseStatus ?? null,
      trimResponseBody(input.responseBody ?? null),
      input.signature,
    ],
  );
  return readAgentWebhookDelivery(queryable, input.deliveryId);
}

export async function markAgentWebhookDeliveryRetrying(
  queryable: Queryable,
  input: {
    attempts: number;
    deliveryId: string;
    nextAttemptAt: string;
    responseBody?: string | null;
    responseStatus?: number | null;
    signature?: string | null;
  },
): Promise<AgentWebhookDeliveryView | undefined> {
  await queryable.query(
    `
      UPDATE agent_webhook_deliveries
      SET
        attempts = $2,
        status = 'retrying',
        next_attempt_at = $3::timestamptz,
        last_attempted_at = NOW(),
        response_status = $4,
        response_body = $5,
        signature = COALESCE($6, signature),
        updated_at = NOW()
      WHERE delivery_id = $1
    `,
    [
      input.deliveryId,
      input.attempts,
      input.nextAttemptAt,
      input.responseStatus ?? null,
      trimResponseBody(input.responseBody ?? null),
      input.signature ?? null,
    ],
  );
  return readAgentWebhookDelivery(queryable, input.deliveryId);
}

export async function markAgentWebhookDeliveryFailed(
  queryable: Queryable,
  input: {
    attempts: number;
    deliveryId: string;
    responseBody?: string | null;
    responseStatus?: number | null;
    signature?: string | null;
  },
): Promise<AgentWebhookDeliveryView | undefined> {
  await queryable.query(
    `
      UPDATE agent_webhook_deliveries
      SET
        attempts = $2,
        status = 'failed',
        last_attempted_at = NOW(),
        response_status = $3,
        response_body = $4,
        signature = COALESCE($5, signature),
        updated_at = NOW()
      WHERE delivery_id = $1
    `,
    [
      input.deliveryId,
      input.attempts,
      input.responseStatus ?? null,
      trimResponseBody(input.responseBody ?? null),
      input.signature ?? null,
    ],
  );
  return readAgentWebhookDelivery(queryable, input.deliveryId);
}

export function filterFreshAgentRuntimeEvents(
  events: AgentRuntimeEventView[],
  subscription: Pick<AgentWebhookSubscriptionView, "cursorEventId" | "cursorOccurredAt">,
): AgentRuntimeEventView[] {
  const unique = new Map<string, AgentRuntimeEventView>();
  for (const event of events) {
    if (
      !eventAfterCursor(event, {
        eventId: subscription.cursorEventId,
        occurredAt: subscription.cursorOccurredAt,
      })
    ) {
      continue;
    }
    unique.set(event.eventId, event);
  }
  return [...unique.values()].sort(compareRuntimeEventsAscending);
}

async function collectAgentRuntimeEventsForSubscription(input: {
  client: RuntimeEventsClient;
  pageLimit: number;
  subscription: AgentWebhookSubscriptionView;
}): Promise<AgentRuntimeEventView[]> {
  const items: AgentRuntimeEventView[] = [];
  let offset = 0;
  while (true) {
    const page = await input.client.getAgentRuntimeEvents({
      agentId: input.subscription.agentId,
      limit: input.pageLimit,
      offset,
      since: input.subscription.cursorOccurredAt ?? undefined,
    });
    items.push(...page.items);
    if (page.items.length < input.pageLimit) {
      break;
    }
    offset += input.pageLimit;
  }
  return filterFreshAgentRuntimeEvents(items, input.subscription);
}

export async function syncAgentWebhookSubscriptionsFromRuntimeFeed(input: {
  client: RuntimeEventsClient;
  pageLimit?: number;
  pool: Queryable;
}): Promise<{
  enqueuedDeliveries: number;
  subscriptionsScanned: number;
  subscriptionsUpdated: number;
}> {
  const subscriptions = await readAgentWebhookSubscriptionsPage(input.pool, {
    limit: 1000,
    offset: 0,
    status: "active",
  });
  let enqueuedDeliveries = 0;
  let subscriptionsUpdated = 0;
  for (const subscription of subscriptions.items) {
    const freshEvents = await collectAgentRuntimeEventsForSubscription({
      client: input.client,
      pageLimit: Math.max(1, Math.min(input.pageLimit ?? 100, 500)),
      subscription,
    });
    if (freshEvents.length === 0) {
      continue;
    }
    for (const event of freshEvents) {
      if (!matchesAgentWebhookEventType(subscription.eventTypes, event.eventType)) {
        continue;
      }
      await enqueueAgentWebhookDelivery(input.pool, {
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        payload: {
          agentIds: event.agentIds,
          claimId: event.claimId,
          payload: event.payload,
          scopeKey: event.scopeKey,
          summary: event.summary,
          title: event.title,
        },
        subscriptionId: subscription.subscriptionId,
      });
      enqueuedDeliveries += 1;
    }
    const latestEvent = freshEvents[freshEvents.length - 1];
    if (latestEvent) {
      await updateAgentWebhookSubscriptionCursor(input.pool, {
        cursorEventId: latestEvent.eventId,
        cursorOccurredAt: latestEvent.occurredAt,
        subscriptionId: subscription.subscriptionId,
      });
      subscriptionsUpdated += 1;
    }
  }
  return {
    enqueuedDeliveries,
    subscriptionsScanned: subscriptions.items.length,
    subscriptionsUpdated,
  };
}

export async function enqueueAgentWebhookPingDelivery(
  queryable: Queryable,
  subscription: Pick<AgentWebhookSubscriptionView, "agentId" | "subscriptionId" | "targetUrl">,
): Promise<AgentWebhookDeliveryView> {
  const occurredAt = new Date().toISOString();
  return enqueueAgentWebhookDelivery(queryable, {
    eventId: `webhook-ping:${subscription.subscriptionId}:${occurredAt}`,
    eventType: "webhook.ping",
    occurredAt,
    payload: {
      agentId: subscription.agentId,
      message: "Webhook ping requested.",
      subscriptionId: subscription.subscriptionId,
      targetUrl: subscription.targetUrl,
    },
    subscriptionId: subscription.subscriptionId,
  });
}

export async function dispatchAgentWebhookDeliveryAttempt(input: {
  delivery: AgentWebhookDeliveryView;
  fetchImpl?: typeof fetch;
  subscription: AgentWebhookSubscriptionSecretView;
}): Promise<{
  delivered: boolean;
  payloadBody: string;
  responseBody: string | null;
  responseStatus: number | null;
  signature: string;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timestamp = new Date().toISOString();
  const payloadBody = JSON.stringify({
    agentId: input.subscription.agentId,
    deliveryId: input.delivery.deliveryId,
    eventId: input.delivery.eventId,
    eventType: input.delivery.eventType,
    occurredAt: input.delivery.occurredAt,
    payload: input.delivery.payload,
    subscriptionId: input.subscription.subscriptionId,
  });
  const signature = signAgentWebhookPayload({
    payloadBody,
    secret: input.subscription.signingSecret,
    timestamp,
  });
  const response = await fetchImpl(input.subscription.targetUrl, {
    body: payloadBody,
    headers: {
      "content-type": "application/json",
      "user-agent": "scientific-protocol-webhooks/1.0",
      "x-sp-webhook-delivery-id": input.delivery.deliveryId,
      "x-sp-webhook-event-id": input.delivery.eventId,
      "x-sp-webhook-event-type": input.delivery.eventType,
      "x-sp-webhook-signature": signature,
      "x-sp-webhook-subscription-id": input.subscription.subscriptionId,
      "x-sp-webhook-timestamp": timestamp,
    },
    method: "POST",
  });
  const responseBody = trimResponseBody(await response.text());
  return {
    delivered: response.ok,
    payloadBody,
    responseBody,
    responseStatus: response.status,
    signature,
  };
}

export async function dispatchDueAgentWebhookDeliveries(input: {
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  pool: Queryable;
  limit?: number;
}): Promise<{
  attempted: number;
  delivered: number;
  failed: number;
  retrying: number;
}> {
  const dueDeliveries = await readDueAgentWebhookDeliveries(input.pool, {
    limit: input.limit,
  });
  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let retrying = 0;
  const maxAttempts = Math.max(1, Math.min(input.maxAttempts ?? 5, 20));

  for (const delivery of dueDeliveries) {
    attempted += 1;
    const subscription = await readAgentWebhookSubscriptionSecret(
      input.pool,
      delivery.subscriptionId,
    );
    if (!subscription || subscription.status !== "active") {
      await markAgentWebhookDeliveryFailed(input.pool, {
        attempts: delivery.attempts + 1,
        deliveryId: delivery.deliveryId,
        responseBody: "subscription_inactive",
      });
      failed += 1;
      continue;
    }

    try {
      const result = await dispatchAgentWebhookDeliveryAttempt({
        delivery,
        fetchImpl: input.fetchImpl,
        subscription,
      });
      if (result.delivered) {
        const deliveredAt = new Date().toISOString();
        await markAgentWebhookDeliveryDelivered(input.pool, {
          attempts: delivery.attempts + 1,
          deliveredAt,
          deliveryId: delivery.deliveryId,
          responseBody: result.responseBody,
          responseStatus: result.responseStatus,
          signature: result.signature,
        });
        await noteAgentWebhookSubscriptionDelivery(input.pool, {
          failureReason: null,
          lastDeliveryAt: deliveredAt,
          subscriptionId: subscription.subscriptionId,
        });
        delivered += 1;
        continue;
      }

      const attempts = delivery.attempts + 1;
      if (attempts >= maxAttempts) {
        await markAgentWebhookDeliveryFailed(input.pool, {
          attempts,
          deliveryId: delivery.deliveryId,
          responseBody: result.responseBody,
          responseStatus: result.responseStatus,
          signature: result.signature,
        });
        await noteAgentWebhookSubscriptionDelivery(input.pool, {
          failureReason: `delivery_failed:${result.responseStatus ?? "network"}`,
          subscriptionId: subscription.subscriptionId,
        });
        failed += 1;
        continue;
      }

      await markAgentWebhookDeliveryRetrying(input.pool, {
        attempts,
        deliveryId: delivery.deliveryId,
        nextAttemptAt: new Date(
          Date.now() + computeAgentWebhookRetryDelayMs(attempts),
        ).toISOString(),
        responseBody: result.responseBody,
        responseStatus: result.responseStatus,
        signature: result.signature,
      });
      retrying += 1;
    } catch (error) {
      const attempts = delivery.attempts + 1;
      const responseBody = error instanceof Error ? error.message : String(error);
      if (attempts >= maxAttempts) {
        await markAgentWebhookDeliveryFailed(input.pool, {
          attempts,
          deliveryId: delivery.deliveryId,
          responseBody,
        });
        await noteAgentWebhookSubscriptionDelivery(input.pool, {
          failureReason: "delivery_failed:network",
          subscriptionId: delivery.subscriptionId,
        });
        failed += 1;
        continue;
      }
      await markAgentWebhookDeliveryRetrying(input.pool, {
        attempts,
        deliveryId: delivery.deliveryId,
        nextAttemptAt: new Date(
          Date.now() + computeAgentWebhookRetryDelayMs(attempts),
        ).toISOString(),
        responseBody,
      });
      retrying += 1;
    }
  }

  return {
    attempted,
    delivered,
    failed,
    retrying,
  };
}

export async function runAgentWebhookDispatchCycle(input: {
  client: RuntimeEventsClient;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  pool: Queryable;
  syncPageLimit?: number;
  deliveryLimit?: number;
}): Promise<{
  attemptedDeliveries: number;
  delivered: number;
  enqueuedDeliveries: number;
  failed: number;
  retrying: number;
  subscriptionsScanned: number;
  subscriptionsUpdated: number;
}> {
  const synced = await syncAgentWebhookSubscriptionsFromRuntimeFeed({
    client: input.client,
    pageLimit: input.syncPageLimit,
    pool: input.pool,
  });
  const dispatched = await dispatchDueAgentWebhookDeliveries({
    fetchImpl: input.fetchImpl,
    limit: input.deliveryLimit,
    maxAttempts: input.maxAttempts,
    pool: input.pool,
  });
  return {
    attemptedDeliveries: dispatched.attempted,
    delivered: dispatched.delivered,
    enqueuedDeliveries: synced.enqueuedDeliveries,
    failed: dispatched.failed,
    retrying: dispatched.retrying,
    subscriptionsScanned: synced.subscriptionsScanned,
    subscriptionsUpdated: synced.subscriptionsUpdated,
  };
}
