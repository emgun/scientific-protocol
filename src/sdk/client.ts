import type {
  AdminStatusResponse,
  AgentRequestDetailResponse,
  AgentReviewCalibrationResponse,
  AgentRewardStateResponse,
  AgentRuntimeEventsResponse,
  AgentWebhookDeliveriesResponse,
  AgentWebhookSubscriptionCreateResponse,
  AgentWebhookSubscriptionDeleteResponse,
  AgentWebhookSubscriptionPingResponse,
  AgentWebhookSubscriptionsResponse,
  AgentWorkSummaryResponse,
  ArtifactMaintenanceTaskDetailResponse,
  ArtifactMaintenanceTaskRunView,
  ArtifactMaintenanceTaskView,
  CheckpointView,
  ClaimDetailResponse,
  ClaimEventsResponse,
  ClaimFeedResponse,
  ClaimListQuery,
  ClaimReviewState,
  ClaimRewardStateResponse,
  ClaimView,
  ClaimWorkGraphResponse,
  ClaimWorkItemDetailResponse,
  ClaimWorkItemView,
  ConfirmSourcePublicationResponse,
  CreateDemoClaimRequest,
  DemoAdminStatusResponse,
  DemoClaimResult,
  DemoDomainRecomputeResult,
  DemoMutationResponse,
  DemoScenariosResponse,
  DomainLeaderboardResponse,
  GovernanceEventsResponse,
  GovernanceOverviewResponse,
  GovernanceProposalDetailResponse,
  GovernanceProposalsResponse,
  GovernanceTreasuryResponse,
  HealthResponse,
  OpenDemoReplicationJobRequest,
  PagedResponse,
  PersistedArtifactDetailResponse,
  ProcessDemoReplicationJobRequest,
  ProductionArtifactDraftResult,
  ProductionClaimResult,
  RecipientRewardStateResponse,
  RejectSourcePublicationResponse,
  ReplicationJobDetailResponse,
  ReplicationJobRunView,
  ReplicationJobView,
  ReplicationView,
  ResolveDemoReplicationJobRequest,
  ReviewSubmissionView,
  ReviewTaskDetailResponse,
  ReviewTaskRunView,
  ReviewTaskView,
  RewardProtocolConfigResponse,
  RewardSettlementHistoryResponse,
  SignedAgentRequestBody,
  SignedPublicWriteRequestBody,
  SourceDetailResponse,
  SourceEventsResponse,
  SourceFeedResponse,
  SourceIngestionResponse,
  SourceListQuery,
  SourceListResponse,
  SourcePublicationDecisionsResponse,
  SourceWorkGraphResponse,
  WriteProtocolConfigResponse,
} from "./types.js";

export class ScientificProtocolApiError extends Error {
  readonly body: unknown;
  readonly response: Response;
  readonly status: number;

  constructor(response: Response, body: unknown) {
    super(`Scientific Protocol API request failed with status ${response.status}`);
    this.name = "ScientificProtocolApiError";
    this.status = response.status;
    this.response = response;
    this.body = body;
  }
}

export type ScientificProtocolClientOptions = {
  baseUrl: string | URL;
  demoAdminToken?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
};

function trimTrailingSlash(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parseWorkItemId(itemId: string): {
  itemKey: string;
  sourceId: string;
} {
  const separator = itemId.indexOf(":");
  if (separator <= 0 || separator === itemId.length - 1) {
    throw new Error(`unsupported_work_item_id:${itemId}`);
  }
  return {
    itemKey: itemId.slice(0, separator),
    sourceId: itemId.slice(separator + 1),
  };
}

function toSearchParams(query?: Record<string, string | number | boolean | undefined>): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();
  return text.length > 0 ? text : null;
}

export class ScientificProtocolClient {
  readonly baseUrl: string;
  readonly demoAdminToken?: string;

  private readonly defaultHeaders?: HeadersInit;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ScientificProtocolClientOptions) {
    this.baseUrl = trimTrailingSlash(String(options.baseUrl));
    this.demoAdminToken = options.demoAdminToken;
    this.defaultHeaders = options.headers;
    this.fetchImpl = options.fetch ?? fetch;
  }

  readonly demo = {
    createClaim: (input: CreateDemoClaimRequest) =>
      this.request<DemoMutationResponse<DemoClaimResult>>("/demo/claims", {
        body: input,
        method: "POST",
      }),
    enqueueArtifactAudits: (input: { requestedBy?: string; staleAfterMinutes?: number } = {}) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(
        "/demo/artifact-maintenance-tasks/enqueue-audits",
        {
          body: input,
          method: "POST",
        },
      ),
    getAdminStatus: () =>
      this.request<DemoAdminStatusResponse>("/demo/admin/status", {
        admin: true,
      }),
    getScenarios: () => this.request<DemoScenariosResponse>("/demo/scenarios"),
    openReplicationJob: (input: OpenDemoReplicationJobRequest) =>
      this.request<DemoMutationResponse<ReplicationJobView>>("/demo/replication-jobs", {
        body: input,
        method: "POST",
      }),
    openArtifactMaintenanceTask: (input: {
      artifactKey: string;
      requestedBy?: string;
      targetProvider?: string;
      targetReplicaKey?: string;
      taskType?: "audit" | "repair";
    }) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(
        "/demo/artifact-maintenance-tasks",
        {
          body: input,
          method: "POST",
        },
      ),
    processReplicationJob: (jobId: string, input: ProcessDemoReplicationJobRequest = {}) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(
        `/demo/replication-jobs/${jobId}/process`,
        {
          body: input,
          method: "POST",
        },
      ),
    recomputeDomain: (domainId: number) =>
      this.request<DemoMutationResponse<DemoDomainRecomputeResult>>(
        `/demo/domains/${domainId}/recompute`,
        {
          body: {},
          method: "POST",
        },
      ),
    reseedOperational: () =>
      this.request<DemoMutationResponse<Record<string, unknown>> & { scenarios: unknown[] }>(
        "/demo/admin/reseed-operational",
        {
          admin: true,
          body: {},
          method: "POST",
        },
      ),
    resetDemo: () =>
      this.request<DemoMutationResponse<Record<string, unknown>> & { scenarios: unknown[] }>(
        "/demo/admin/reset-demo",
        {
          admin: true,
          body: {},
          method: "POST",
        },
      ),
    resolveReplicationJob: (jobId: string, input: ResolveDemoReplicationJobRequest = {}) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(
        `/demo/replication-jobs/${jobId}/resolve`,
        {
          body: input,
          method: "POST",
        },
      ),
  };

  readonly production = {
    createClaim: (signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<ProductionClaimResult>>("/claims", {
        body: signedRequest,
        method: "POST",
      }),
    publishClaim: (claimId: string | number, signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(`/claims/${claimId}/publish`, {
        body: signedRequest,
        method: "POST",
      }),
    createSource: (signedRequest: SignedPublicWriteRequestBody) =>
      this.request<SourceIngestionResponse>("/sources", {
        body: signedRequest,
        method: "POST",
      }),
    createClaimDraftFromArtifact: (signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<ProductionArtifactDraftResult>>(
        "/claim-drafts/from-artifact",
        {
          body: signedRequest,
          method: "POST",
        },
      ),
    confirmSourcePublication: (
      sourceId: string | number,
      signedRequest: SignedPublicWriteRequestBody,
    ) =>
      this.request<ConfirmSourcePublicationResponse>(`/sources/${sourceId}/confirm`, {
        body: signedRequest,
        method: "POST",
      }),
    openReplicationJob: (claimId: string | number, signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<ReplicationJobView>>(
        `/claims/${claimId}/replication-jobs`,
        {
          body: signedRequest,
          method: "POST",
        },
      ),
    rejectSourcePublication: (
      sourceId: string | number,
      signedRequest: SignedPublicWriteRequestBody,
    ) =>
      this.request<RejectSourcePublicationResponse>(`/sources/${sourceId}/reject`, {
        body: signedRequest,
        method: "POST",
      }),
    processReplicationJob: (jobId: string | number, signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(
        `/replication-jobs/${jobId}/process`,
        {
          body: signedRequest,
          method: "POST",
        },
      ),
    recomputeDomain: (domainId: number, signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<DemoDomainRecomputeResult>>(
        `/domains/${domainId}/recompute`,
        {
          body: signedRequest,
          method: "POST",
        },
      ),
    resolveReplicationJob: (jobId: string | number, signedRequest: SignedPublicWriteRequestBody) =>
      this.request<DemoMutationResponse<Record<string, unknown>>>(
        `/replication-jobs/${jobId}/resolve`,
        {
          body: signedRequest,
          method: "POST",
        },
      ),
  };

  readonly agent = {
    claimArtifactMaintenanceTask: (
      taskId: string | number,
      signedRequest: SignedAgentRequestBody,
    ) =>
      this.request<{
        ok: true;
        result: {
          run: ArtifactMaintenanceTaskRunView;
          task: ArtifactMaintenanceTaskView;
        };
      }>(`/agent/artifact-maintenance-tasks/${taskId}/claim`, {
        body: signedRequest,
        method: "POST",
      }),
    heartbeatArtifactMaintenanceTask: (
      taskId: string | number,
      signedRequest: SignedAgentRequestBody,
    ) =>
      this.request<{
        ok: true;
        result: ArtifactMaintenanceTaskRunView;
      }>(`/agent/artifact-maintenance-tasks/${taskId}/heartbeat`, {
        body: signedRequest,
        method: "POST",
      }),
    submitArtifactAuditResults: (taskId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: Record<string, unknown>;
      }>(`/agent/artifact-maintenance-tasks/${taskId}/audit-results`, {
        body: signedRequest,
        method: "POST",
      }),
    submitArtifactRepairResults: (taskId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: Record<string, unknown>;
      }>(`/agent/artifact-maintenance-tasks/${taskId}/repair-results`, {
        body: signedRequest,
        method: "POST",
      }),
    claimReplicationJob: (jobId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: {
          job: ReplicationJobView;
          run: ReplicationJobRunView;
        };
      }>(`/agent/replication-jobs/${jobId}/claim`, {
        body: signedRequest,
        method: "POST",
      }),
    heartbeatReplicationJob: (jobId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: ReplicationJobRunView;
      }>(`/agent/replication-jobs/${jobId}/heartbeat`, {
        body: signedRequest,
        method: "POST",
      }),
    submitReplicationResults: (jobId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: {
          job: ReplicationJobView;
          operatorRequestId: string;
          resultArtifactKey: string;
          run: ReplicationJobRunView;
        };
      }>(`/agent/replication-jobs/${jobId}/submissions`, {
        body: signedRequest,
        method: "POST",
      }),
    claimReviewTask: (taskId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: {
          run: ReviewTaskRunView;
          task: ReviewTaskView;
        };
      }>(`/agent/review-tasks/${taskId}/claim`, {
        body: signedRequest,
        method: "POST",
      }),
    heartbeatReviewTask: (taskId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: ReviewTaskRunView;
      }>(`/agent/review-tasks/${taskId}/heartbeat`, {
        body: signedRequest,
        method: "POST",
      }),
    submitReviewResults: (taskId: string | number, signedRequest: SignedAgentRequestBody) =>
      this.request<{
        ok: true;
        result: {
          submission: ReviewSubmissionView;
          task: ReviewTaskView;
        };
      }>(`/agent/review-tasks/${taskId}/submissions`, {
        body: signedRequest,
        method: "POST",
      }),
    submitSource: (signedRequest: SignedAgentRequestBody) =>
      this.request<SourceIngestionResponse>("/agent/sources", {
        body: signedRequest,
        method: "POST",
      }),
    claimWorkItem: (itemId: string, signedRequest: SignedAgentRequestBody) => {
      const parsed = parseWorkItemId(itemId);
      if (parsed.itemKey === "review-task") {
        return this.agent.claimReviewTask(parsed.sourceId, signedRequest);
      }
      if (parsed.itemKey === "artifact-maintenance") {
        return this.agent.claimArtifactMaintenanceTask(parsed.sourceId, signedRequest);
      }
      if (parsed.itemKey === "replication-job") {
        return this.agent.claimReplicationJob(parsed.sourceId, signedRequest);
      }
      throw new Error(`unsupported_claimable_work_item:${itemId}`);
    },
    heartbeatWorkItem: (itemId: string, signedRequest: SignedAgentRequestBody) => {
      const parsed = parseWorkItemId(itemId);
      if (parsed.itemKey === "review-task") {
        return this.agent.heartbeatReviewTask(parsed.sourceId, signedRequest);
      }
      if (parsed.itemKey === "artifact-maintenance") {
        return this.agent.heartbeatArtifactMaintenanceTask(parsed.sourceId, signedRequest);
      }
      if (parsed.itemKey === "replication-job") {
        return this.agent.heartbeatReplicationJob(parsed.sourceId, signedRequest);
      }
      throw new Error(`unsupported_heartbeatable_work_item:${itemId}`);
    },
    submitWorkResults: (itemId: string, signedRequest: SignedAgentRequestBody) => {
      const parsed = parseWorkItemId(itemId);
      if (parsed.itemKey === "review-task") {
        return this.agent.submitReviewResults(parsed.sourceId, signedRequest);
      }
      if (parsed.itemKey === "artifact-maintenance") {
        if (signedRequest.envelope.actionType === "artifact_task_audit_submission") {
          return this.agent.submitArtifactAuditResults(parsed.sourceId, signedRequest);
        }
        if (signedRequest.envelope.actionType === "artifact_task_repair_submission") {
          return this.agent.submitArtifactRepairResults(parsed.sourceId, signedRequest);
        }
      }
      if (parsed.itemKey === "replication-job") {
        if (signedRequest.envelope.actionType === "replication_job_submission") {
          return this.agent.submitReplicationResults(parsed.sourceId, signedRequest);
        }
      }
      throw new Error(
        `unsupported_work_result_submission:${itemId}:${signedRequest.envelope.actionType}`,
      );
    },
    createWebhookSubscription: (signedRequest: SignedAgentRequestBody) =>
      this.request<AgentWebhookSubscriptionCreateResponse>("/agent/webhook-subscriptions", {
        body: signedRequest,
        method: "POST",
      }),
    deleteWebhookSubscription: (
      subscriptionId: string | number,
      signedRequest: SignedAgentRequestBody,
    ) =>
      this.request<AgentWebhookSubscriptionDeleteResponse>(
        `/agent/webhook-subscriptions/${subscriptionId}/delete`,
        {
          body: signedRequest,
          method: "POST",
        },
      ),
    pingWebhookSubscription: (
      subscriptionId: string | number,
      signedRequest: SignedAgentRequestBody,
    ) =>
      this.request<AgentWebhookSubscriptionPingResponse>(
        `/agent/webhook-subscriptions/${subscriptionId}/ping`,
        {
          body: signedRequest,
          method: "POST",
        },
      ),
  };

  async getAdminStatus(): Promise<AdminStatusResponse> {
    return this.request("/admin/status");
  }

  async getGovernance(): Promise<GovernanceOverviewResponse> {
    return this.request("/governance");
  }

  async listGovernanceEvents(query?: {
    limit?: number;
    offset?: number;
    proposalId?: string | number;
  }): Promise<GovernanceEventsResponse> {
    return this.request(`/governance/events${toSearchParams(query)}`);
  }

  async getGovernanceTreasury(query?: {
    limit?: number;
    offset?: number;
  }): Promise<GovernanceTreasuryResponse> {
    return this.request(`/governance/treasury${toSearchParams(query)}`);
  }

  async getGovernanceProposal(
    proposalId: string | number,
    query?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<GovernanceProposalDetailResponse> {
    return this.request(`/governance/proposals/${proposalId}${toSearchParams(query)}`);
  }

  async listGovernanceProposals(query?: {
    limit?: number;
    offset?: number;
    state?:
      | "Active"
      | "Canceled"
      | "Defeated"
      | "Executed"
      | "Expired"
      | "Pending"
      | "Queued"
      | "Succeeded";
  }): Promise<GovernanceProposalsResponse> {
    return this.request(`/governance/proposals${toSearchParams(query)}`);
  }

  async getAgentRequest(requestId: string | number): Promise<AgentRequestDetailResponse> {
    return this.request(`/agent-requests/${requestId}`);
  }

  async getAgentReviewCalibration(
    agentId: string | number,
    query?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<AgentReviewCalibrationResponse> {
    return this.request(`/agents/${agentId}/review-calibration${toSearchParams(query)}`);
  }

  async getAgentWorkSummary(
    agentId: string | number,
    query?: {
      domainId?: number;
    },
  ): Promise<AgentWorkSummaryResponse> {
    return this.request(`/agents/${agentId}/work-summary${toSearchParams(query)}`);
  }

  async getAgentRewards(
    agentId: string | number,
    query?: {
      limit?: number;
      offset?: number;
      policyVersion?: string;
      workKind?: "challenge" | "forecast" | "maintenance" | "replication" | "review" | "synthesis";
    },
  ): Promise<AgentRewardStateResponse> {
    return this.request(`/agents/${agentId}/rewards${toSearchParams(query)}`);
  }

  async getRewardSettlements(query?: {
    agentId?: string | number;
    claimId?: string | number;
    itemId?: string;
    limit?: number;
    offset?: number;
    policyVersion?: string;
    recipient?: string;
    workKind?: "challenge" | "forecast" | "maintenance" | "replication" | "review" | "synthesis";
  }): Promise<RewardSettlementHistoryResponse> {
    return this.request(`/reward-settlements${toSearchParams(query)}`);
  }

  async getRecipientRewards(
    recipient: string,
    query?: {
      itemId?: string;
      limit?: number;
      offset?: number;
      policyVersion?: string;
      workKind?: "challenge" | "forecast" | "maintenance" | "replication" | "review" | "synthesis";
    },
  ): Promise<RecipientRewardStateResponse> {
    return this.request(`/recipients/${recipient}/rewards${toSearchParams(query)}`);
  }

  async getRewardConfig(): Promise<RewardProtocolConfigResponse> {
    return this.request("/reward-config");
  }

  async getWriteConfig(): Promise<WriteProtocolConfigResponse> {
    return this.request("/write-config");
  }

  async getAgentRuntimeEvents(query?: {
    agentId?: string | number;
    claimId?: string | number;
    limit?: number;
    offset?: number;
    since?: string;
  }): Promise<AgentRuntimeEventsResponse> {
    return this.request(`/agent-runtime/events${toSearchParams(query)}`);
  }

  async getAgentWebhookSubscription(
    subscriptionId: string | number,
  ): Promise<AgentWebhookSubscriptionsResponse["items"][number]> {
    return this.request(`/agent-webhook-subscriptions/${subscriptionId}`);
  }

  async getAgentWebhookDelivery(
    deliveryId: string | number,
  ): Promise<AgentWebhookDeliveriesResponse["items"][number]> {
    return this.request(`/agent-webhook-deliveries/${deliveryId}`);
  }

  async getAgentWebhookSubscriptions(query?: {
    agentId?: string | number;
    limit?: number;
    offset?: number;
    status?: "active" | "inactive";
  }): Promise<AgentWebhookSubscriptionsResponse> {
    return this.request(`/agent-webhook-subscriptions${toSearchParams(query)}`);
  }

  async getAgentWebhookDeliveries(query?: {
    agentId?: string | number;
    limit?: number;
    offset?: number;
    status?: "delivered" | "failed" | "pending" | "retrying";
    subscriptionId?: string | number;
  }): Promise<AgentWebhookDeliveriesResponse> {
    return this.request(`/agent-webhook-deliveries${toSearchParams(query)}`);
  }

  async getArtifactMaintenanceTask(
    taskId: string | number,
  ): Promise<ArtifactMaintenanceTaskDetailResponse> {
    return this.request(`/artifact-maintenance-tasks/${taskId}`);
  }

  async getCheckpointPublications(query?: {
    domainId?: number;
    limit?: number;
    offset?: number;
    status?: string;
    subjectActor?: string;
    subjectAgentId?: string;
    subjectType?: number;
  }): Promise<PagedResponse<Record<string, unknown>>> {
    return this.request(`/checkpoint-publications${toSearchParams(query)}`);
  }

  async getClaim(claimId: string | number, options?: { view?: "full" | "summary" }) {
    return this.request<ClaimDetailResponse>(
      `/claims/${claimId}${toSearchParams({ view: options?.view })}`,
    );
  }

  async getClaimReview(claimId: string | number): Promise<ClaimReviewState> {
    return this.request(`/claims/${claimId}/review`);
  }

  async getClaimRewards(
    claimId: string | number,
    query?: {
      limit?: number;
      offset?: number;
      policyVersion?: string;
      workKind?: "challenge" | "forecast" | "maintenance" | "replication" | "review" | "synthesis";
    },
  ): Promise<ClaimRewardStateResponse> {
    return this.request(`/claims/${claimId}/rewards${toSearchParams(query)}`);
  }

  async getClaimWorkGraph(claimId: string | number): Promise<ClaimWorkGraphResponse> {
    return this.request(`/claims/${claimId}/work-graph`);
  }

  async getWorkItem(
    itemId: string,
    query?: {
      claimId?: string | number;
      sourceId?: string | number;
    },
  ): Promise<ClaimWorkItemDetailResponse> {
    return this.request(`/work-items/${encodeURIComponent(itemId)}${toSearchParams(query)}`);
  }

  async getDomainLeaderboard(
    domainId: string | number,
    query?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<DomainLeaderboardResponse> {
    return this.request(`/domains/${domainId}/leaderboard${toSearchParams(query)}`);
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request("/health");
  }

  async getReviewTask(taskId: string | number): Promise<ReviewTaskDetailResponse> {
    return this.request(`/review-tasks/${taskId}`);
  }

  async getSource(sourceId: string | number): Promise<SourceDetailResponse> {
    return this.request(`/sources/${sourceId}`);
  }

  async getSourcePublicationDecisions(
    sourceId: string | number,
    query?: {
      limit?: number;
      offset?: number;
      shouldPublish?: boolean;
    },
  ): Promise<SourcePublicationDecisionsResponse> {
    return this.request(`/sources/${sourceId}/publication-decisions${toSearchParams(query)}`);
  }

  async getSourceWorkGraph(sourceId: string | number): Promise<SourceWorkGraphResponse> {
    return this.request(`/sources/${sourceId}/work-graph`);
  }

  async listSourceFeed(query?: {
    limit?: number;
    offset?: number;
    status?:
      | "discovered"
      | "snapshotted"
      | "extracting"
      | "ready_for_publication"
      | "published"
      | "rejected";
  }): Promise<SourceFeedResponse> {
    return this.request(`/feeds/sources${toSearchParams(query)}`);
  }

  async listClaimFeed(query?: {
    claimId?: string | number;
    domainId?: number;
    limit?: number;
    machineProposed?: boolean;
    offset?: number;
    status?: number;
    view?: "record" | "summary";
  }): Promise<ClaimFeedResponse> {
    return this.request(`/feeds/claims${toSearchParams(query)}`);
  }

  async listSourceEvents(query?: {
    eventType?:
      | "source.discovered"
      | "source.extracting_started"
      | "source.published"
      | "source.ready_for_publication"
      | "source.rejected"
      | "source.snapshotted";
    limit?: number;
    offset?: number;
    sourceId?: string | number;
  }): Promise<SourceEventsResponse> {
    return this.request(`/events/sources${toSearchParams(query)}`);
  }

  async listClaimEvents(query?: {
    claimId?: string | number;
    domainId?: number;
    limit?: number;
    offset?: number;
  }): Promise<ClaimEventsResponse> {
    return this.request(`/events/claims${toSearchParams(query)}`);
  }

  async getOperatorRequests(query?: {
    actionType?: string;
    actor?: string;
    limit?: number;
    offset?: number;
    operator?: string;
    requestHash?: string;
  }): Promise<PagedResponse<Record<string, unknown>>> {
    return this.request(`/operator-requests${toSearchParams(query)}`);
  }

  async getReplicationJob(jobId: string | number): Promise<ReplicationJobDetailResponse> {
    return this.request(`/replication-jobs/${jobId}`);
  }

  async getPersistedArtifact(artifactKey: string): Promise<PersistedArtifactDetailResponse> {
    return this.request(`/persisted-artifacts/${encodeURIComponent(artifactKey)}`);
  }

  getPersistedArtifactContentUrl(artifactKey: string): string {
    return `${this.baseUrl}/persisted-artifacts/${encodeURIComponent(artifactKey)}/content`;
  }

  async getPersistedArtifactAudits(
    artifactKey: string,
    query?: {
      limit?: number;
      offset?: number;
    },
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.request(
      `/persisted-artifacts/${encodeURIComponent(artifactKey)}/audits${toSearchParams(query)}`,
    );
  }

  async getPersistedArtifactMaintenanceTasks(
    artifactKey: string,
    query?: {
      assignedAgentId?: string;
      limit?: number;
      offset?: number;
      status?: "assigned" | "completed" | "failed" | "open";
      targetReplicaKey?: string;
      taskType?: "audit" | "repair";
    },
  ): Promise<PagedResponse<Record<string, unknown>>> {
    return this.request(
      `/persisted-artifacts/${encodeURIComponent(artifactKey)}/maintenance-tasks${toSearchParams(query)}`,
    );
  }

  async getResolutionRun(runId: string | number): Promise<Record<string, unknown>> {
    return this.request(`/resolution-runs/${runId}`);
  }

  async listClaims(query?: ClaimListQuery): Promise<PagedResponse<ClaimView>> {
    return this.request(`/claims${toSearchParams(query)}`);
  }

  async listReplications(query?: {
    agentId?: string;
    claimId?: string;
    confidenceBps?: number;
    limit?: number;
    offset?: number;
    outcome?: number;
    replicator?: string;
    resolutionStatus?: number;
    resolverType?: number;
  }): Promise<PagedResponse<ReplicationView>> {
    return this.request(`/replications${toSearchParams(query)}`);
  }

  async listCheckpoints(query?: {
    claimId?: string;
    domainId?: number;
    limit?: number;
    offset?: number;
    subjectActor?: string;
    subjectAgentId?: string;
    subjectModule?: string;
    subjectType?: number;
  }): Promise<PagedResponse<CheckpointView>> {
    return this.request(`/checkpoints${toSearchParams(query)}`);
  }

  async listArtifactMaintenanceTasks(query?: {
    artifactKey?: string;
    assignedAgentId?: string;
    limit?: number;
    offset?: number;
    status?: "assigned" | "completed" | "failed" | "open";
    targetReplicaKey?: string;
    taskType?: "audit" | "repair";
  }): Promise<PagedResponse<Record<string, unknown>>> {
    return this.request(`/artifact-maintenance-tasks${toSearchParams(query)}`);
  }

  async listReviewTasks(query?: {
    claimId?: string;
    limit?: number;
    offset?: number;
    sourceId?: string;
    status?: "canceled" | "completed" | "escalated" | "open";
    taskType?:
      | "artifact_completeness_check"
      | "artifact_integrity_check"
      | "benchmark_rerun_check"
      | "certification_synthesis_check"
      | "claim_extraction_check"
      | "claim_extraction_synthesis_check"
      | "contradiction_scan"
      | "method_consistency_check"
      | "replication_readiness_check"
      | "stats_sanity_check";
  }): Promise<PagedResponse<ReviewTaskView>> {
    return this.request(`/review-tasks${toSearchParams(query)}`);
  }

  async listSources(query?: SourceListQuery): Promise<SourceListResponse> {
    return this.request(`/sources${toSearchParams(query)}`);
  }

  async listWorkItems(query?: {
    claimId?: string | number;
    claimable?: boolean;
    kind?: "artifact_maintenance" | "replication_job" | "review_task";
    lane?: "evaluation" | "execution" | "maintenance" | "synthesis";
    limit?: number;
    offset?: number;
    sourceId?: string | number;
    status?: "canceled" | "completed" | "escalated" | "failed" | "leased" | "open";
  }): Promise<PagedResponse<ClaimWorkItemView>> {
    return this.request(`/work-items${toSearchParams(query)}`);
  }

  async listAgentRequests(query?: {
    actionType?: string;
    agentId?: string;
    limit?: number;
    offset?: number;
    scopeKey?: string;
    status?: "accepted" | "rejected";
  }): Promise<PagedResponse<AgentRequestDetailResponse>> {
    return this.request(`/agent-requests${toSearchParams(query)}`);
  }

  async listScenarios(): Promise<DemoScenariosResponse> {
    return this.demo.getScenarios();
  }

  private async request<T>(
    pathname: string,
    init: {
      admin?: boolean;
      body?: unknown;
      headers?: HeadersInit;
      method?: "GET" | "POST";
    } = {},
  ): Promise<T> {
    const headers = new Headers(this.defaultHeaders);
    if (init.headers) {
      const extraHeaders = new Headers(init.headers);
      for (const [key, value] of extraHeaders.entries()) {
        headers.set(key, value);
      }
    }

    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    if (init.admin && this.demoAdminToken) {
      headers.set("authorization", `Bearer ${this.demoAdminToken}`);
      headers.set("x-sp-demo-admin-token", this.demoAdminToken);
    }

    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      headers,
      method: init.method ?? "GET",
    });

    const body = await parseResponseBody(response);
    if (!response.ok) {
      throw new ScientificProtocolApiError(response, body);
    }

    return body as T;
  }
}
