export type DemoScenarioTemplate = {
  detail: string;
  domainId: number;
  eyebrow: string;
  proofPoint: string;
  scenarioKey: string;
  summary: string;
  title: string;
  whyItMatters: string;
};

export const FULL_CLAIM_OBJECT_SCENARIO_KEY = "full-claim-object";
export const OPERATIONAL_LOOP_SCENARIO_KEY = "operational-loop";

export const DEMO_SCENARIO_TEMPLATES: Record<string, DemoScenarioTemplate> = {
  [FULL_CLAIM_OBJECT_SCENARIO_KEY]: {
    scenarioKey: FULL_CLAIM_OBJECT_SCENARIO_KEY,
    domainId: 1,
    eyebrow: "Benchmark dispute",
    title: "Published model ranking survives a fresh rerun",
    summary:
      "Source evidence, an independent rerun, and an open challenge are tied to the same public claim.",
    detail:
      "The underlying claim is that the published benchmark bundle preserves the reported model ordering when rerun under the declared environment. This case shows how disagreement accumulates around one bounded scientific assertion.",
    whyItMatters:
      "Scientific review stays attached to the claim itself instead of splintering into disconnected papers, comments, and dashboards.",
    proofPoint:
      "Evidence, rerun results, challenges, and review work stay attached to one bounded claim.",
  },
  [OPERATIONAL_LOOP_SCENARIO_KEY]: {
    scenarioKey: OPERATIONAL_LOOP_SCENARIO_KEY,
    domainId: 1,
    eyebrow: "Computational rerun",
    title: "Independent benchmark rerun updates the claim record",
    summary: "A rerun result is attached to the claim and reflected in the public field record.",
    detail:
      "The underlying claim is that a published benchmark bundle can be rerun in the declared container and scored objectively against the reported output manifest.",
    whyItMatters:
      "The claim only changes scientific status when a typed replication result and settlement are appended to the record.",
    proofPoint:
      "The same claim moves from evidence to rerun result to public checkpoint without changing the atomic object.",
  },
};

export function listDemoScenarioTemplates(): DemoScenarioTemplate[] {
  return [
    DEMO_SCENARIO_TEMPLATES[FULL_CLAIM_OBJECT_SCENARIO_KEY],
    DEMO_SCENARIO_TEMPLATES[OPERATIONAL_LOOP_SCENARIO_KEY],
  ];
}

export function getDemoScenarioTemplate(scenarioKey: string): DemoScenarioTemplate | null {
  return DEMO_SCENARIO_TEMPLATES[scenarioKey] ?? null;
}

export function buildOperationalScenarioClaimInput(seedSuffix: string): {
  artifactUri: string;
  metadata: string;
  methodology: string;
  predictionHooks: string;
  requestedBy: string;
  scope: string;
  statement: string;
} {
  return {
    statement: `Benchmark rerun ${seedSuffix}: the published bundle preserves the reported model ordering when rerun under the declared container image.`,
    artifactUri: `ipfs://benchmark-rerun-${seedSuffix}`,
    metadata: `benchmark-rerun-meta-${seedSuffix}`,
    methodology: `benchmark-rerun-method-${seedSuffix}`,
    predictionHooks: `benchmark-rerun-hooks-${seedSuffix}`,
    requestedBy: "demo-admin-reseed",
    scope: `benchmark-rerun-scope-${seedSuffix}`,
  };
}
