import type { AgentRequestActionType } from "../../shared/agent-requests.js";
import {
  auditPersistedArtifactReplicas,
  type PersistedArtifactAuditRecord,
  type PersistedArtifactReplicaRecord,
  persistJsonArtifact,
} from "../../shared/persisted-artifacts.js";
import { attemptSourceAutoPublication } from "../../sources/auto-publish.js";
import { insertSourceExtractionCandidate } from "../../sources/store.js";
import { resolveAgentResultArtifact } from "../agent-result-artifacts.js";
import { authenticateSignedAgentRequest } from "../auth.js";
import { json } from "../http.js";
import {
  canonicalizeSourceDraft,
  hasAnySearchParam,
  parseArtifactDraftPayload,
  parseBooleanParam,
  parseDetailView,
  parseIntegerParam,
  parseReviewIssueSeverity,
  parseReviewIssueStatus,
  parseReviewSubmissionVerdict,
  parseTimestampParam,
  parseWebhookSubscriptionCreatePayload,
} from "../params.js";
import {
  consumeConfiguredRateLimit,
  requestClientKey,
  sourceDuplicateCooldownKey,
} from "../rate-limit.js";
import {
  buildAgentControllerCount,
  buildAgentReviewCalibrationPayload,
  buildAgentRuntimeEventsPayload,
  buildAgentWorkSummaryPayload,
  redactAgentWebhookDeliveryForPublic,
  redactAgentWebhookSubscriptionForPublic,
  redactPageItems,
} from "../read-payloads.js";
import type { RouteContext } from "./context.js";

export async function handleAgentActionRoutes(context: RouteContext): Promise<boolean> {
  const {
    dependencies,
    env,
    pool,
    rateLimitConfig,
    rateLimitBackend,
    request,
    response,
    sourceDuplicateCooldownBuckets,
    url,
  } = context;
  if (url.pathname === "/agent/webhook-subscriptions" && request.method === "POST") {
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "webhook_subscription_create",
      scopeKeyValidator: (scopeKey, envelope) =>
        scopeKey === `agent-webhook-subscriptions:${envelope.agentId}`,
    });
    const payload = parseWebhookSubscriptionCreatePayload(authenticated.envelope.payload);
    const created = await dependencies.createAgentWebhookSubscription(pool, {
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      eventTypes: payload.eventTypes,
      label: payload.label,
      signingSecret: payload.signingSecret,
      targetUrl: payload.targetUrl,
    });
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `created webhook subscription ${created.subscriptionId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    const { signingSecret, ...subscription } = created;
    json(response, 200, {
      ok: true,
      result: {
        signingSecret,
        subscription,
      },
    });
    return true;
  }

  const agentDeleteWebhookSubscriptionMatch = url.pathname.match(
    /^\/agent\/webhook-subscriptions\/(\d+)\/delete$/,
  );
  if (agentDeleteWebhookSubscriptionMatch && request.method === "POST") {
    const subscriptionId = agentDeleteWebhookSubscriptionMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "webhook_subscription_delete",
      scopeKey: `agent-webhook-subscription:${subscriptionId}`,
    });
    const subscription = await dependencies.readAgentWebhookSubscription(pool, subscriptionId);
    if (!subscription) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `webhook subscription ${subscriptionId} not found`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 404, { error: "agent_webhook_subscription_not_found" });
      return true;
    }
    if (subscription.agentId !== authenticated.envelope.agentId) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `webhook subscription ${subscriptionId} belongs to another agent`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 403, { error: "agent_webhook_subscription_agent_mismatch" });
      return true;
    }
    const deactivated = await dependencies.deactivateAgentWebhookSubscription(pool, subscriptionId);
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `deactivated webhook subscription ${subscriptionId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: deactivated });
    return true;
  }

  const agentPingWebhookSubscriptionMatch = url.pathname.match(
    /^\/agent\/webhook-subscriptions\/(\d+)\/ping$/,
  );
  if (agentPingWebhookSubscriptionMatch && request.method === "POST") {
    const subscriptionId = agentPingWebhookSubscriptionMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "webhook_subscription_ping",
      scopeKey: `agent-webhook-subscription:${subscriptionId}`,
    });
    const subscription = await dependencies.readAgentWebhookSubscription(pool, subscriptionId);
    if (!subscription) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `webhook subscription ${subscriptionId} not found`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 404, { error: "agent_webhook_subscription_not_found" });
      return true;
    }
    if (subscription.agentId !== authenticated.envelope.agentId) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `webhook subscription ${subscriptionId} belongs to another agent`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 403, { error: "agent_webhook_subscription_agent_mismatch" });
      return true;
    }
    const delivery = await dependencies.enqueueAgentWebhookPingDelivery(pool, subscription);
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `queued webhook ping delivery ${delivery.deliveryId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, {
      ok: true,
      result: {
        delivery,
        subscription,
      },
    });
    return true;
  }

  const agentClaimMaintenanceTaskMatch = url.pathname.match(
    /^\/agent\/artifact-maintenance-tasks\/(\d+)\/claim$/,
  );
  if (agentClaimMaintenanceTaskMatch && request.method === "POST") {
    const taskId = agentClaimMaintenanceTaskMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "artifact_task_claim",
      scopeKey: `artifact-maintenance-task:${taskId}`,
    });
    const workerId =
      typeof authenticated.envelope.payload.workerId === "string" &&
      authenticated.envelope.payload.workerId.trim()
        ? authenticated.envelope.payload.workerId
        : `agent-${authenticated.envelope.agentId}-worker`;
    const claimed = await dependencies.claimArtifactMaintenanceTaskById(pool, {
      agentId: authenticated.envelope.agentId,
      taskId,
      workerId,
    });
    if (!claimed) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: "artifact maintenance task is not open",
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "artifact_maintenance_task_not_open" });
      return true;
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `claimed task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: claimed });
    return true;
  }

  const agentHeartbeatMaintenanceTaskMatch = url.pathname.match(
    /^\/agent\/artifact-maintenance-tasks\/(\d+)\/heartbeat$/,
  );
  if (agentHeartbeatMaintenanceTaskMatch && request.method === "POST") {
    const taskId = agentHeartbeatMaintenanceTaskMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "artifact_task_heartbeat",
      scopeKey: `artifact-maintenance-task:${taskId}`,
    });
    const runId =
      typeof authenticated.envelope.payload.runId === "string" &&
      authenticated.envelope.payload.runId.trim()
        ? authenticated.envelope.payload.runId.trim()
        : null;
    if (!runId) {
      json(response, 400, { error: "artifact_maintenance_task_run_id_required" });
      return true;
    }
    const workerId =
      typeof authenticated.envelope.payload.workerId === "string" &&
      authenticated.envelope.payload.workerId.trim()
        ? authenticated.envelope.payload.workerId.trim()
        : null;
    const heartbeat = await dependencies.heartbeatArtifactMaintenanceTaskRun(pool, {
      agentId: authenticated.envelope.agentId,
      runId,
      taskId,
      workerId,
    });
    if (!heartbeat) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `artifact maintenance heartbeat rejected for task ${taskId}`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "artifact_maintenance_task_run_not_running" });
      return true;
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `heartbeat recorded for artifact maintenance task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: heartbeat });
    return true;
  }

  const agentSubmitAuditMatch = url.pathname.match(
    /^\/agent\/artifact-maintenance-tasks\/(\d+)\/audit-results$/,
  );
  if (agentSubmitAuditMatch && request.method === "POST") {
    const taskId = agentSubmitAuditMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "artifact_task_audit_submission",
      scopeKey: `artifact-maintenance-task:${taskId}`,
    });
    const task = await dependencies.readArtifactMaintenanceTask(pool, taskId);
    if (!task) {
      json(response, 404, { error: "artifact_maintenance_task_not_found" });
      return true;
    }
    if (task.taskType !== "audit") {
      json(response, 409, { error: "artifact_maintenance_task_type_mismatch" });
      return true;
    }
    if (task.assignedAgentId !== authenticated.envelope.agentId) {
      json(response, 409, { error: "artifact_maintenance_task_not_assigned_to_agent" });
      return true;
    }

    const rawAudits = Array.isArray(authenticated.envelope.payload.audits)
      ? authenticated.envelope.payload.audits
      : [];
    const audits: PersistedArtifactAuditRecord[] = rawAudits.map((entry) => {
      const value = entry as Record<string, unknown>;
      const status = String(value.status ?? "");
      if (
        status !== "hash_mismatch" &&
        status !== "replicated" &&
        status !== "replication_failed" &&
        status !== "unreachable" &&
        status !== "verified"
      ) {
        throw new Error("invalid_agent_audit_status");
      }
      return {
        checkKind: "agent_report",
        checkedAt: new Date().toISOString(),
        detail: typeof value.detail === "string" ? value.detail : null,
        locator: typeof value.locator === "string" ? value.locator : null,
        observedSha256: typeof value.observedSha256 === "string" ? value.observedSha256 : null,
        provider: String(value.provider ?? "unknown"),
        replicaKey: typeof value.replicaKey === "string" ? value.replicaKey : null,
        status,
      };
    });

    for (const audit of audits) {
      await dependencies.recordPersistedArtifactAudit(pool, task.artifactKey, audit);
    }

    const createdRepairTasks = [];
    for (const audit of audits) {
      if (
        (audit.status === "hash_mismatch" || audit.status === "unreachable") &&
        audit.replicaKey &&
        audit.replicaKey !== "primary"
      ) {
        createdRepairTasks.push(
          await dependencies.createArtifactMaintenanceTask(pool, {
            artifactKey: task.artifactKey,
            requestedBy: `agent-audit:${task.taskId}:${authenticated.envelope.agentId}`,
            targetProvider: audit.provider,
            targetReplicaKey: audit.replicaKey,
            taskType: "repair",
          }),
        );
      }
    }

    const resultArtifact = await persistJsonArtifact("artifact-maintenance-agent-audit-result", {
      artifactKey: task.artifactKey,
      audits,
      createdRepairTasks: createdRepairTasks.map((repairTask) => ({
        taskId: repairTask.taskId,
        targetProvider: repairTask.targetProvider,
        targetReplicaKey: repairTask.targetReplicaKey,
      })),
      reportedBy: authenticated.envelope.actorAddress,
      runContext: {
        agentId: authenticated.envelope.agentId,
        taskId,
      },
    });
    await dependencies.upsertPersistedArtifact(pool, resultArtifact);
    const currentRun = (await dependencies.readArtifactMaintenanceTaskRuns(pool, taskId)).at(-1);
    if (!currentRun) {
      throw new Error("artifact_maintenance_run_not_found");
    }
    const completedTask = await dependencies.completeArtifactMaintenanceTask(pool, {
      resultArtifactKey: resultArtifact.artifactKey,
      runId: currentRun.runId,
      taskId,
    });
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `submitted audit results for task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, {
      ok: true,
      result: {
        createdRepairTasks,
        task: completedTask,
      },
    });
    return true;
  }

  const agentSubmitRepairMatch = url.pathname.match(
    /^\/agent\/artifact-maintenance-tasks\/(\d+)\/repair-results$/,
  );
  if (agentSubmitRepairMatch && request.method === "POST") {
    const taskId = agentSubmitRepairMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "artifact_task_repair_submission",
      scopeKey: `artifact-maintenance-task:${taskId}`,
    });
    const task = await dependencies.readArtifactMaintenanceTask(pool, taskId);
    if (!task) {
      json(response, 404, { error: "artifact_maintenance_task_not_found" });
      return true;
    }
    if (task.taskType !== "repair") {
      json(response, 409, { error: "artifact_maintenance_task_type_mismatch" });
      return true;
    }
    if (task.assignedAgentId !== authenticated.envelope.agentId) {
      json(response, 409, { error: "artifact_maintenance_task_not_assigned_to_agent" });
      return true;
    }
    const artifact = await dependencies.readPersistedArtifact(pool, task.artifactKey);
    if (!artifact) {
      json(response, 404, { error: "persisted_artifact_not_found" });
      return true;
    }
    const rawReplica = authenticated.envelope.payload.repairedReplica as
      | Record<string, unknown>
      | undefined;
    if (!rawReplica) {
      throw new Error("invalid_agent_repair_replica");
    }
    const repairedReplica: PersistedArtifactReplicaRecord = {
      isPrimary: false,
      locator: String(rawReplica.locator ?? ""),
      provider: String(rawReplica.provider ?? task.targetProvider ?? "unknown"),
      replicaKey: String(
        rawReplica.replicaKey ??
          task.targetReplicaKey ??
          `agent-${authenticated.envelope.agentId}-repair`,
      ),
    };
    await dependencies.upsertPersistedArtifactReplica(pool, task.artifactKey, repairedReplica);
    const verificationAudits = await auditPersistedArtifactReplicas(
      {
        ...artifact,
        replicas: [repairedReplica],
      },
      {},
    );
    for (const audit of verificationAudits) {
      await dependencies.recordPersistedArtifactAudit(pool, task.artifactKey, audit);
    }
    const verified = verificationAudits.every((audit) => audit.status === "verified");
    if (!verified) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `repair submission for task ${taskId} failed verification`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 422, {
        error: "artifact_repair_verification_failed",
        audits: verificationAudits,
      });
      return true;
    }

    const resultArtifact = await persistJsonArtifact("artifact-maintenance-agent-repair-result", {
      artifactKey: task.artifactKey,
      repairedReplica,
      repairSourceReplicaKey:
        typeof authenticated.envelope.payload.repairSourceReplicaKey === "string"
          ? authenticated.envelope.payload.repairSourceReplicaKey
          : null,
      reportedBy: authenticated.envelope.actorAddress,
      verificationAudits,
      runContext: {
        agentId: authenticated.envelope.agentId,
        taskId,
      },
    });
    await dependencies.upsertPersistedArtifact(pool, resultArtifact);
    const currentRun = (await dependencies.readArtifactMaintenanceTaskRuns(pool, taskId)).at(-1);
    if (!currentRun) {
      throw new Error("artifact_maintenance_run_not_found");
    }
    const completedTask = await dependencies.completeArtifactMaintenanceTask(pool, {
      repairLocator: repairedReplica.locator,
      repairSourceReplicaKey:
        typeof authenticated.envelope.payload.repairSourceReplicaKey === "string"
          ? authenticated.envelope.payload.repairSourceReplicaKey
          : null,
      resultArtifactKey: resultArtifact.artifactKey,
      runId: currentRun.runId,
      taskId,
    });
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `submitted repair results for task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, {
      ok: true,
      result: {
        task: completedTask,
        verificationAudits,
      },
    });
    return true;
  }

  const agentClaimReplicationJobMatch = url.pathname.match(
    /^\/agent\/replication-jobs\/(\d+)\/claim$/,
  );
  if (agentClaimReplicationJobMatch && request.method === "POST") {
    const jobId = agentClaimReplicationJobMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "replication_job_claim",
      scopeKey: `replication-job:${jobId}`,
    });
    const workerId =
      typeof authenticated.envelope.payload.workerId === "string" &&
      authenticated.envelope.payload.workerId.trim()
        ? authenticated.envelope.payload.workerId
        : `agent-${authenticated.envelope.agentId}-replication-worker`;
    const claimed = await dependencies.claimReplicationJobById(pool, {
      agentId: authenticated.envelope.agentId,
      jobId,
      workerId,
    });
    if (!claimed) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: "replication job is not open",
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "replication_job_not_open" });
      return true;
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `claimed replication job ${jobId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: claimed });
    return true;
  }

  const agentHeartbeatReplicationJobMatch = url.pathname.match(
    /^\/agent\/replication-jobs\/(\d+)\/heartbeat$/,
  );
  if (agentHeartbeatReplicationJobMatch && request.method === "POST") {
    const jobId = agentHeartbeatReplicationJobMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "replication_job_heartbeat",
      scopeKey: `replication-job:${jobId}`,
    });
    const runId =
      typeof authenticated.envelope.payload.runId === "string" &&
      authenticated.envelope.payload.runId.trim()
        ? authenticated.envelope.payload.runId.trim()
        : null;
    if (!runId) {
      json(response, 400, { error: "replication_job_run_id_required" });
      return true;
    }
    const workerId =
      typeof authenticated.envelope.payload.workerId === "string" &&
      authenticated.envelope.payload.workerId.trim()
        ? authenticated.envelope.payload.workerId.trim()
        : null;
    const heartbeat = await dependencies.heartbeatReplicationJobRun(pool, {
      agentId: authenticated.envelope.agentId,
      jobId,
      runId,
      workerId,
    });
    if (!heartbeat) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `replication heartbeat rejected for job ${jobId}`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "replication_job_run_not_running" });
      return true;
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `heartbeat recorded for replication job ${jobId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: heartbeat });
    return true;
  }

  const agentSubmitReplicationMatch = url.pathname.match(
    /^\/agent\/replication-jobs\/(\d+)\/submissions$/,
  );
  if (agentSubmitReplicationMatch && request.method === "POST") {
    const jobId = agentSubmitReplicationMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "replication_job_submission",
      scopeKey: `replication-job:${jobId}`,
    });
    const job = await dependencies.readReplicationJob(pool, jobId);
    if (!job) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: "replication job not found",
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 404, { error: "replication_job_not_found" });
      return true;
    }
    if (job.assignedAgentId !== authenticated.envelope.agentId) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `replication job ${jobId} is not assigned to this agent`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "replication_job_not_assigned_to_agent" });
      return true;
    }

    const payload = authenticated.envelope.payload;
    const runId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId : null;
    if (!runId) {
      json(response, 400, { error: "replication_job_run_id_required" });
      return true;
    }
    const run = (await dependencies.readReplicationJobRuns(pool, jobId)).find(
      (entry) =>
        entry.runId === runId &&
        entry.status === "running" &&
        entry.agentId === authenticated.envelope.agentId,
    );
    if (!run) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `replication submission rejected for job ${jobId}; run ${runId} is not active`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "replication_job_run_not_running" });
      return true;
    }

    const claim = await dependencies.readClaim(pool, job.claimId);
    if (!claim) {
      json(response, 404, { error: "claim_not_found" });
      return true;
    }
    const artifacts = await dependencies.readArtifactsByClaim(pool, claim.claimId);
    const summary =
      typeof payload.summary === "string" && payload.summary.trim().length > 0
        ? payload.summary.trim()
        : `Replication submission for claim ${claim.claimId}`;
    const resultArtifact = await persistJsonArtifact("replication-result", {
      artifacts: artifacts.map((artifact) => ({
        artifactId: artifact.artifactId,
        artifactType: artifact.artifactType,
        contentDigest: artifact.contentDigest,
        uri: artifact.uri,
      })),
      claim: {
        author: claim.author,
        claimId: claim.claimId,
        domainId: claim.domainId,
        metadataHash: claim.metadataHash,
        status: claim.status,
      },
      job,
      reportedBy: authenticated.envelope.actorAddress,
      runContext: {
        agentId: authenticated.envelope.agentId,
        jobId,
        runId,
        workerId: run.workerId,
      },
      submission: {
        ...payload,
        summary,
      },
      summary,
    });
    await dependencies.upsertPersistedArtifact(pool, resultArtifact);

    try {
      const submission = await dependencies.submitPersistedReplicationResult({
        assignedAgentId: job.assignedAgentId,
        claimId: job.claimId,
        env,
        jobId,
        pool,
        resultArtifact,
        runId,
        workerId: run.workerId,
      });
      const completedJob = await dependencies.completeReplicationJob(pool, {
        evidenceHash: resultArtifact.sha256,
        evidenceURI: resultArtifact.storagePath,
        executionManifestHash: resultArtifact.sha256,
        jobId,
        onchainReplicationId: submission.onchainReplicationId,
        requestId: submission.operatorRequestId,
        resultArtifactKey: resultArtifact.artifactKey,
        resultHash: resultArtifact.sha256,
        runId,
        submissionActor: submission.submissionActor,
        submissionTxHash: submission.submissionTxHash,
      });
      const completedRun =
        (await dependencies.readReplicationJobRuns(pool, jobId)).find(
          (entry) => entry.runId === runId,
        ) ?? run;
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `submitted replication results for job ${jobId}`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "accepted",
      });
      json(response, 200, {
        ok: true,
        result: {
          job: completedJob,
          operatorRequestId: submission.operatorRequestId,
          resultArtifactKey: resultArtifact.artifactKey,
          run: completedRun,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const operatorRequestId =
        error && typeof error === "object" && "operatorRequestId" in error
          ? ((error as { operatorRequestId?: unknown }).operatorRequestId ?? null)
          : null;
      await dependencies.failReplicationJob(pool, {
        failureReason: message,
        jobId,
        requestId: typeof operatorRequestId === "string" ? operatorRequestId : null,
        runId,
      });
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `replication submission failed for job ${jobId}: ${message}`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 502, { error: "replication_submission_failed", message });
      return true;
    }
  }

  if (url.pathname === "/agent/sources" && request.method === "POST") {
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "source_discovery_submission",
      scopeKeyValidator: (scopeKey) => scopeKey.startsWith("source-discovery"),
    });
    try {
      const payload = parseArtifactDraftPayload(authenticated.envelope.payload);
      const canonical = canonicalizeSourceDraft(payload);
      for (const bucketKey of [
        `agentSourceSubmission:client:${requestClientKey(request, rateLimitConfig.trustProxy)}`,
        `agentSourceSubmission:actor:${authenticated.envelope.actorAddress.toLowerCase()}:agent:${authenticated.envelope.agentId}`,
      ]) {
        const globalThrottle = await consumeConfiguredRateLimit({
          backend: rateLimitBackend,
          bucketKey,
          buckets: sourceDuplicateCooldownBuckets,
          pool,
          response,
          rule: rateLimitConfig.agentSourceSubmission,
        });
        if (!globalThrottle.allowed) {
          json(response, 429, {
            error: "rate_limited",
            retryAfterSeconds: globalThrottle.retryAfterSeconds,
            scope: "agentSourceSubmission",
          });
          return true;
        }
      }
      const duplicateCooldownBucketKey = sourceDuplicateCooldownKey(
        "agentSourceSubmission",
        canonical.canonicalSourceKey,
        authenticated.envelope.actorAddress,
        authenticated.envelope.agentId,
      );
      const throttle = await consumeConfiguredRateLimit({
        backend: rateLimitBackend,
        bucketKey: duplicateCooldownBucketKey,
        buckets: sourceDuplicateCooldownBuckets,
        pool,
        response,
        rule: rateLimitConfig.agentSourceSubmission,
      });
      if (!throttle.allowed) {
        await dependencies.insertAgentRequest(pool, {
          actionType: authenticated.envelope.actionType,
          actorAddress: authenticated.envelope.actorAddress,
          agentId: authenticated.envelope.agentId,
          outcomeDetail: `source discovery rate limited for ${canonical.canonicalSourceKey}`,
          payload: authenticated.envelope.payload,
          requestHash: authenticated.requestHash,
          requestNonce: authenticated.envelope.requestNonce,
          scopeKey: authenticated.envelope.scopeKey,
          signature: authenticated.signature,
          status: "rejected",
        });
        json(response, 429, {
          error: "rate_limited",
          retryAfterSeconds: throttle.retryAfterSeconds,
          scope: "agentSourceSubmission",
        });
        return true;
      }
      const result = await dependencies.ingestSource(pool, payload, {
        discoveryMode: "agent_discovered",
        submittedByActor: authenticated.envelope.actorAddress,
        submittedByAgentId: authenticated.envelope.agentId,
      });
      const recorded = await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `source ${result.source.sourceId} ingested`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "accepted",
      });
      json(response, 200, {
        ok: true,
        requestId: recorded.requestId,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `source discovery failed: ${message}`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 400, { error: "source_discovery_failed", message });
    }
    return true;
  }

  const agentClaimReviewTaskMatch = url.pathname.match(/^\/agent\/review-tasks\/(\d+)\/claim$/);
  if (agentClaimReviewTaskMatch && request.method === "POST") {
    const taskId = agentClaimReviewTaskMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "review_task_claim",
      scopeKey: `review-task:${taskId}`,
    });
    const workerId =
      typeof authenticated.envelope.payload.workerId === "string" &&
      authenticated.envelope.payload.workerId.trim()
        ? authenticated.envelope.payload.workerId
        : `agent-${authenticated.envelope.agentId}-review-worker`;
    const claimed = await dependencies.claimReviewTaskById(pool, {
      agentId: authenticated.envelope.agentId,
      taskId,
      workerId,
    });
    if (!claimed) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: "review task is not open or claim capacity is exhausted",
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "review_task_not_open" });
      return true;
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `claimed review task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: claimed });
    return true;
  }

  const agentHeartbeatReviewTaskMatch = url.pathname.match(
    /^\/agent\/review-tasks\/(\d+)\/heartbeat$/,
  );
  if (agentHeartbeatReviewTaskMatch && request.method === "POST") {
    const taskId = agentHeartbeatReviewTaskMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "review_task_heartbeat",
      scopeKey: `review-task:${taskId}`,
    });
    const runId =
      typeof authenticated.envelope.payload.runId === "string" &&
      authenticated.envelope.payload.runId.trim()
        ? authenticated.envelope.payload.runId.trim()
        : null;
    if (!runId) {
      json(response, 400, { error: "review_task_run_id_required" });
      return true;
    }
    const workerId =
      typeof authenticated.envelope.payload.workerId === "string" &&
      authenticated.envelope.payload.workerId.trim()
        ? authenticated.envelope.payload.workerId.trim()
        : null;
    const heartbeat = await dependencies.heartbeatReviewTaskRun(pool, {
      agentId: authenticated.envelope.agentId,
      runId,
      taskId,
      workerId,
    });
    if (!heartbeat) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: `review heartbeat rejected for task ${taskId}`,
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 409, { error: "review_task_run_not_running" });
      return true;
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `heartbeat recorded for review task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, { ok: true, result: heartbeat });
    return true;
  }

  const agentSubmitReviewMatch = url.pathname.match(/^\/agent\/review-tasks\/(\d+)\/submissions$/);
  if (agentSubmitReviewMatch && request.method === "POST") {
    const taskId = agentSubmitReviewMatch[1];
    const authenticated = await authenticateSignedAgentRequest(dependencies, pool, request, {
      actionType: "review_task_submission",
      scopeKey: `review-task:${taskId}`,
    });
    const task = await dependencies.readReviewTask(pool, taskId);
    if (!task) {
      await dependencies.insertAgentRequest(pool, {
        actionType: authenticated.envelope.actionType,
        actorAddress: authenticated.envelope.actorAddress,
        agentId: authenticated.envelope.agentId,
        outcomeDetail: "review task not found",
        payload: authenticated.envelope.payload,
        requestHash: authenticated.requestHash,
        requestNonce: authenticated.envelope.requestNonce,
        scopeKey: authenticated.envelope.scopeKey,
        signature: authenticated.signature,
        status: "rejected",
      });
      json(response, 404, { error: "review_task_not_found" });
      return true;
    }

    const payload = authenticated.envelope.payload;
    const runId = typeof payload.runId === "string" && payload.runId.trim() ? payload.runId : null;
    if (!runId) {
      json(response, 400, { error: "review_task_run_id_required" });
      return true;
    }

    const issues = Array.isArray(payload.issues)
      ? payload.issues.map((entry) => {
          const value = entry as Record<string, unknown>;
          return {
            artifactAnchor:
              value.artifactAnchor &&
              typeof value.artifactAnchor === "object" &&
              !Array.isArray(value.artifactAnchor)
                ? (value.artifactAnchor as Record<string, unknown>)
                : undefined,
            category: String(value.category ?? "review"),
            severity: parseReviewIssueSeverity(value.severity ?? "medium"),
            status: value.status ? parseReviewIssueStatus(value.status) : undefined,
            summary: String(value.summary ?? ""),
          };
        })
      : [];

    const verdict = parseReviewSubmissionVerdict(payload.verdict);
    const confidenceBps =
      typeof payload.confidenceBps === "number"
        ? Math.max(0, Math.min(10_000, Math.floor(payload.confidenceBps)))
        : 5_000;
    const dimensions =
      payload.dimensions &&
      typeof payload.dimensions === "object" &&
      !Array.isArray(payload.dimensions)
        ? (payload.dimensions as Record<string, unknown>)
        : {};
    const summary =
      typeof payload.summary === "string" && payload.summary.trim().length > 0
        ? payload.summary.trim()
        : `${task.taskType} submission`;
    const { resultArtifact: suppliedResultArtifact, ...artifactPayload } = payload;
    const resultArtifactPayload = {
      claimId: task.claimId,
      reportedBy: authenticated.envelope.actorAddress,
      runId,
      summary,
      taskId,
      taskType: task.taskType,
      verdict,
      ...artifactPayload,
    };
    const resultArtifact = await resolveAgentResultArtifact({
      fallbackPayload: resultArtifactPayload,
      kind: "agent-review-submission-result",
      suppliedArtifact: suppliedResultArtifact,
    });
    await dependencies.upsertPersistedArtifact(pool, resultArtifact);
    const recorded = await dependencies.recordReviewSubmission(pool, {
      confidenceBps,
      dimensions,
      evidenceArtifactKey:
        typeof payload.evidenceArtifactKey === "string" ? payload.evidenceArtifactKey : null,
      issues: issues.filter((issue) => issue.summary.trim().length > 0),
      payload: {
        ...payload,
        resultArtifactKey: resultArtifact.artifactKey,
        summary,
      },
      resultArtifactKey: resultArtifact.artifactKey,
      reviewerActor: authenticated.envelope.actorAddress,
      reviewerAgentId: authenticated.envelope.agentId,
      runId,
      taskId,
      verdict,
    });
    let sourcePublication: Awaited<ReturnType<typeof attemptSourceAutoPublication>> | null = null;
    if (task.taskType === "claim_extraction_check" && task.sourceId) {
      const candidateClaim =
        payload.candidateClaim &&
        typeof payload.candidateClaim === "object" &&
        !Array.isArray(payload.candidateClaim)
          ? (payload.candidateClaim as Record<string, unknown>)
          : null;
      if (candidateClaim) {
        await insertSourceExtractionCandidate(pool, {
          anchors: Array.isArray(candidateClaim.anchors)
            ? candidateClaim.anchors
                .filter(
                  (entry): entry is { label?: unknown; text?: unknown } =>
                    Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
                )
                .map((entry) => ({
                  label: String(entry.label ?? "source"),
                  text: String(entry.text ?? ""),
                }))
            : [],
          candidateId: recorded.submission.submissionId,
          claimType: String(candidateClaim.claimType ?? "general"),
          confidenceBps,
          createdAt: recorded.submission.createdAt,
          methodology: String(candidateClaim.methodology ?? payload.summary ?? ""),
          reviewerAgentId: authenticated.envelope.agentId,
          scope: String(candidateClaim.scope ?? ""),
          sourceId: task.sourceId,
          statement: String(candidateClaim.statement ?? ""),
          submissionId: recorded.submission.submissionId,
          taskId,
        });
        sourcePublication = await attemptSourceAutoPublication(pool, task.sourceId, env);
      }
    }
    await dependencies.insertAgentRequest(pool, {
      actionType: authenticated.envelope.actionType,
      actorAddress: authenticated.envelope.actorAddress,
      agentId: authenticated.envelope.agentId,
      outcomeDetail: `submitted review for task ${taskId}`,
      payload: authenticated.envelope.payload,
      requestHash: authenticated.requestHash,
      requestNonce: authenticated.envelope.requestNonce,
      scopeKey: authenticated.envelope.scopeKey,
      signature: authenticated.signature,
      status: "accepted",
    });
    json(response, 200, {
      ok: true,
      result: {
        ...recorded,
        sourcePublication,
      },
    });
    return true;
  }

  return false;
}

export async function handleAgentReadRoutes(context: RouteContext): Promise<boolean> {
  const { dependencies, pool, response, url } = context;
  if (url.pathname === "/agents") {
    if (hasAnySearchParam(url, ["limit", "offset", "active", "operator"])) {
      json(
        response,
        200,
        await dependencies.readAgentsPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          active: parseBooleanParam(url, "active"),
          operator: url.searchParams.get("operator") ?? undefined,
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAgents(pool));
    return true;
  }

  const agentMatch = url.pathname.match(/^\/agents\/(\d+)$/);
  if (agentMatch) {
    const agent = await dependencies.readAgent(pool, agentMatch[1]);
    if (!agent) {
      json(response, 404, { error: "agent_not_found" });
      return true;
    }

    const view = parseDetailView(url);
    if (view === "summary") {
      json(response, 200, {
        ...agent,
        controllerCount: await buildAgentControllerCount(dependencies, pool, agent.agentId),
      });
      return true;
    }

    const controllers = await dependencies.readAgentControllers(pool, agent.agentId);
    json(response, 200, {
      ...agent,
      controllerCount: controllers.length,
      controllers,
    });
    return true;
  }

  const agentReviewCalibrationMatch = url.pathname.match(/^\/agents\/(\d+)\/review-calibration$/);
  if (agentReviewCalibrationMatch) {
    const payload = await buildAgentReviewCalibrationPayload(
      dependencies,
      pool,
      agentReviewCalibrationMatch[1],
      {
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
      },
    );
    if (!payload) {
      json(response, 404, { error: "agent_not_found" });
      return true;
    }

    json(response, 200, payload);
    return true;
  }

  const agentWorkSummaryMatch = url.pathname.match(/^\/agents\/(\d+)\/work-summary$/);
  if (agentWorkSummaryMatch) {
    const payload = await buildAgentWorkSummaryPayload(
      dependencies,
      pool,
      agentWorkSummaryMatch[1],
      {
        domainId: parseIntegerParam(url, "domainId"),
      },
    );
    if (!payload) {
      json(response, 404, { error: "agent_not_found" });
      return true;
    }
    json(response, 200, payload);
    return true;
  }
  const agentControllersMatch = url.pathname.match(/^\/agents\/(\d+)\/controllers$/);
  if (agentControllersMatch) {
    if (hasAnySearchParam(url, ["limit", "offset", "controller", "authorized"])) {
      json(
        response,
        200,
        await dependencies.readAgentControllersPage(pool, {
          limit: parseIntegerParam(url, "limit"),
          offset: parseIntegerParam(url, "offset"),
          agentId: agentControllersMatch[1],
          controller: url.searchParams.get("controller") ?? undefined,
          authorized: parseBooleanParam(url, "authorized"),
        }),
      );
      return true;
    }

    json(response, 200, await dependencies.readAgentControllers(pool, agentControllersMatch[1]));
    return true;
  }
  if (url.pathname === "/agent-requests") {
    json(
      response,
      200,
      await dependencies.readAgentRequestsPage(pool, {
        actionType:
          (url.searchParams.get("actionType") as AgentRequestActionType | null) ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        scopeKey: url.searchParams.get("scopeKey") ?? undefined,
        status: (url.searchParams.get("status") as "accepted" | "rejected" | null) ?? undefined,
      }),
    );
    return true;
  }

  if (url.pathname === "/agent-webhook-subscriptions") {
    const page = await dependencies.readAgentWebhookSubscriptionsPage(pool, {
      agentId: url.searchParams.get("agentId") ?? undefined,
      limit: parseIntegerParam(url, "limit"),
      offset: parseIntegerParam(url, "offset"),
      status: (url.searchParams.get("status") as "active" | "inactive" | null) ?? undefined,
    });
    json(response, 200, redactPageItems(page, redactAgentWebhookSubscriptionForPublic));
    return true;
  }

  if (url.pathname === "/agent-webhook-deliveries") {
    const page = await dependencies.readAgentWebhookDeliveriesPage(pool, {
      agentId: url.searchParams.get("agentId") ?? undefined,
      limit: parseIntegerParam(url, "limit"),
      offset: parseIntegerParam(url, "offset"),
      status:
        (url.searchParams.get("status") as
          | "delivered"
          | "failed"
          | "pending"
          | "retrying"
          | null) ?? undefined,
      subscriptionId: url.searchParams.get("subscriptionId") ?? undefined,
    });
    json(response, 200, redactPageItems(page, redactAgentWebhookDeliveryForPublic));
    return true;
  }

  if (url.pathname === "/agent-runtime/events") {
    json(
      response,
      200,
      await buildAgentRuntimeEventsPayload(dependencies, pool, {
        agentId: url.searchParams.get("agentId") ?? undefined,
        claimId: url.searchParams.get("claimId") ?? undefined,
        limit: parseIntegerParam(url, "limit"),
        offset: parseIntegerParam(url, "offset"),
        since: parseTimestampParam(url, "since"),
      }),
    );
    return true;
  }

  const agentWebhookSubscriptionMatch = url.pathname.match(
    /^\/agent-webhook-subscriptions\/(\d+)$/,
  );
  if (agentWebhookSubscriptionMatch) {
    const subscription = await dependencies.readAgentWebhookSubscription(
      pool,
      agentWebhookSubscriptionMatch[1],
    );
    if (!subscription) {
      json(response, 404, { error: "agent_webhook_subscription_not_found" });
      return true;
    }
    json(response, 200, redactAgentWebhookSubscriptionForPublic(subscription));
    return true;
  }

  const agentWebhookSubscriptionDeliveriesMatch = url.pathname.match(
    /^\/agent-webhook-subscriptions\/(\d+)\/deliveries$/,
  );
  if (agentWebhookSubscriptionDeliveriesMatch) {
    const page = await dependencies.readAgentWebhookDeliveriesPage(pool, {
      limit: parseIntegerParam(url, "limit"),
      offset: parseIntegerParam(url, "offset"),
      status:
        (url.searchParams.get("status") as
          | "delivered"
          | "failed"
          | "pending"
          | "retrying"
          | null) ?? undefined,
      subscriptionId: agentWebhookSubscriptionDeliveriesMatch[1],
    });
    json(response, 200, redactPageItems(page, redactAgentWebhookDeliveryForPublic));
    return true;
  }

  const agentWebhookDeliveryMatch = url.pathname.match(/^\/agent-webhook-deliveries\/(\d+)$/);
  if (agentWebhookDeliveryMatch) {
    const delivery = await dependencies.readAgentWebhookDelivery(
      pool,
      agentWebhookDeliveryMatch[1],
    );
    if (!delivery) {
      json(response, 404, { error: "agent_webhook_delivery_not_found" });
      return true;
    }
    json(response, 200, redactAgentWebhookDeliveryForPublic(delivery));
    return true;
  }

  const agentRequestMatch = url.pathname.match(/^\/agent-requests\/(\d+)$/);
  if (agentRequestMatch) {
    const agentRequest = await dependencies.readAgentRequest(pool, agentRequestMatch[1]);
    if (!agentRequest) {
      json(response, 404, { error: "agent_request_not_found" });
      return true;
    }
    json(response, 200, agentRequest);
    return true;
  }

  return false;
}
