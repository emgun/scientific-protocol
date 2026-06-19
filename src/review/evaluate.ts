import type {
  ClaimReviewState,
  ReviewIssueSeverity,
  ReviewSubmissionVerdict,
  ReviewTaskView,
} from "./types.js";

export type ReviewTaskEvaluation = {
  confidenceBps: number;
  dimensions: Record<string, number>;
  issues: Array<{
    category: string;
    severity: ReviewIssueSeverity;
    summary: string;
  }>;
  summary: string;
  verdict: ReviewSubmissionVerdict;
};

export type ReviewTaskEvaluationInput = {
  artifactTypes: number[];
  artifactsCount: number;
  challengeCount: number;
  challengesOpen: number;
  claimStatus: number;
  reviewState: Pick<ClaimReviewState, "vector">;
  replicationCount: number;
  supportiveReplications: number;
};

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}

function hasArtifactType(artifactTypes: number[], artifactType: number): boolean {
  return artifactTypes.includes(artifactType);
}

export function evaluateReviewTask(
  task: ReviewTaskView,
  input: ReviewTaskEvaluationInput,
): ReviewTaskEvaluation {
  const hasManuscript = hasArtifactType(input.artifactTypes, 5);
  const hasCode = hasArtifactType(input.artifactTypes, 1);
  const hasContainer = hasArtifactType(input.artifactTypes, 2);
  const hasNotebook = hasArtifactType(input.artifactTypes, 4);
  const hasSupplements = hasArtifactType(input.artifactTypes, 6);

  switch (task.taskType) {
    case "artifact_completeness_check": {
      let score = input.artifactsCount === 0 ? 0 : 5_000;
      if (hasManuscript) {
        score += 1_500;
      }
      if (hasCode || hasNotebook) {
        score += 1_500;
      }
      if (hasContainer) {
        score += 1_000;
      }
      if (hasSupplements) {
        score += 500;
      }
      score = clampBps(score);
      return {
        confidenceBps: input.artifactsCount > 0 ? 8_000 : 9_000,
        dimensions: {
          artifactCompleteness: score,
        },
        issues:
          input.artifactsCount > 0
            ? []
            : [
                {
                  category: "missing_artifacts",
                  severity: "high",
                  summary: "The claim has no attached artifacts to evaluate for completeness.",
                },
              ],
        summary:
          input.artifactsCount > 0
            ? `${input.artifactsCount} artifacts are attached to the claim.`
            : "No artifacts are currently attached to the claim.",
        verdict: score >= 8_000 ? "pass" : input.artifactsCount > 0 ? "inconclusive" : "fail",
      };
    }
    case "artifact_integrity_check": {
      const score = clampBps(input.artifactsCount > 0 ? 8_500 : 0);
      return {
        confidenceBps: 7_500,
        dimensions: {
          artifactIntegrity: score,
        },
        issues:
          input.artifactsCount > 0
            ? []
            : [
                {
                  category: "integrity_unverifiable",
                  severity: "medium",
                  summary:
                    "Artifact integrity cannot be checked before the claim has any attached artifacts.",
                },
              ],
        summary:
          input.artifactsCount > 0
            ? "Artifacts expose typed digests and URIs suitable for integrity checks."
            : "No artifact commitments are available for integrity checks.",
        verdict: input.artifactsCount > 0 ? "pass" : "fail",
      };
    }
    case "method_consistency_check": {
      const score = clampBps(hasManuscript ? (hasCode || hasNotebook ? 7_800 : 6_300) : 2_500);
      return {
        confidenceBps: hasManuscript ? 6_800 : 4_000,
        dimensions: {
          methodConsistency: score,
        },
        issues: hasManuscript
          ? []
          : [
              {
                category: "missing_method_context",
                severity: "medium",
                summary:
                  "Method consistency review is weak without a manuscript or structured method artifact.",
              },
            ],
        summary: hasManuscript
          ? "A manuscript artifact is present for method-focused review."
          : "Method consistency review is limited because no manuscript artifact is present.",
        verdict: score >= 7_000 ? "pass" : hasManuscript ? "inconclusive" : "fail",
      };
    }
    case "stats_sanity_check": {
      const score = clampBps(hasManuscript ? (input.replicationCount > 0 ? 7_200 : 5_800) : 2_000);
      return {
        confidenceBps: hasManuscript ? 6_500 : 3_500,
        dimensions: {
          statisticalSanity: score,
        },
        issues: hasManuscript
          ? []
          : [
              {
                category: "missing_statistical_context",
                severity: "medium",
                summary:
                  "No manuscript artifact is present for a meaningful statistical sanity pass.",
              },
            ],
        summary: hasManuscript
          ? "The claim has enough manuscript context for a basic statistical pass."
          : "The claim lacks enough manuscript context for a meaningful statistical pass.",
        verdict: score >= 7_000 ? "pass" : hasManuscript ? "inconclusive" : "fail",
      };
    }
    case "replication_readiness_check": {
      const score = clampBps(
        hasCode && (hasContainer || hasNotebook)
          ? 8_500
          : hasCode || hasNotebook
            ? 7_000
            : input.artifactsCount > 0
              ? 4_500
              : 0,
      );
      return {
        confidenceBps: 7_800,
        dimensions: {
          reproducibilityReadiness: score,
        },
        issues:
          score >= 7_000
            ? []
            : [
                {
                  category: "execution_readiness",
                  severity: input.artifactsCount > 0 ? "medium" : "high",
                  summary:
                    input.artifactsCount > 0
                      ? "Artifacts exist, but the execution bundle is incomplete for reliable reruns."
                      : "No reproducibility artifacts are present.",
                },
              ],
        summary:
          score >= 7_000
            ? "The artifact bundle looks runnable enough for downstream replication."
            : "The artifact bundle is not yet strong enough for reliable downstream replication.",
        verdict: score >= 7_500 ? "pass" : score > 0 ? "inconclusive" : "fail",
      };
    }
    case "contradiction_scan": {
      const pressure = clampBps(
        input.challengeCount * 1_500 +
          input.challengesOpen * 1_500 +
          (task.status === "open" ? 500 : 0),
      );
      return {
        confidenceBps: 6_000,
        dimensions: {
          challengePressure: pressure,
          contradictionPressure: pressure,
        },
        issues:
          pressure >= 6_000
            ? [
                {
                  category: "contradiction",
                  severity: "high",
                  summary:
                    "Open contradiction pressure is elevated enough to block quiet certification.",
                },
              ]
            : [],
        summary:
          pressure >= 6_000
            ? "Challenge and contradiction pressure is elevated."
            : "No strong contradiction signal dominates the current record.",
        verdict: pressure >= 6_000 ? "flag" : "pass",
      };
    }
    case "benchmark_rerun_check": {
      const score = clampBps(
        input.supportiveReplications > 0
          ? 8_600
          : input.replicationCount > 0
            ? 5_200
            : hasCode || hasNotebook
              ? 5_500
              : 2_000,
      );
      return {
        confidenceBps: input.replicationCount > 0 ? 8_500 : 5_500,
        dimensions: {
          replicationSupport: score,
        },
        issues:
          input.replicationCount === 0
            ? [
                {
                  category: "no_rerun_recorded",
                  severity: "medium",
                  summary: "No replication result is recorded yet for this claim.",
                },
              ]
            : [],
        summary:
          input.replicationCount > 0
            ? `${input.replicationCount} replication result(s) are already recorded.`
            : "No benchmark rerun has been recorded yet.",
        verdict: score >= 8_000 ? "pass" : input.replicationCount > 0 ? "inconclusive" : "fail",
      };
    }
    case "claim_extraction_check": {
      return {
        confidenceBps: 7_200,
        dimensions: {},
        issues: [],
        summary: "Extraction work proposes a candidate atomic claim from the source snapshot.",
        verdict: "pass",
      };
    }
    case "claim_extraction_synthesis_check": {
      return {
        confidenceBps: 6_800,
        dimensions: {},
        issues: [],
        summary: "Synthesis work clusters extraction candidates into a publication-ready proposal.",
        verdict: "inconclusive",
      };
    }
    case "certification_synthesis_check": {
      const state = input.reviewState;
      const readiness =
        state.vector.find((entry) => entry.dimension === "certificationReadiness")?.scoreBps ?? 0;
      const contradiction =
        state.vector.find((entry) => entry.dimension === "contradictionPressure")?.scoreBps ?? 0;
      const challenge =
        state.vector.find((entry) => entry.dimension === "challengePressure")?.scoreBps ?? 0;
      return {
        confidenceBps: 7_000,
        dimensions: {
          certificationReadiness: readiness,
          reviewCoverage:
            state.vector.find((entry) => entry.dimension === "reviewCoverage")?.scoreBps ?? 0,
          reviewDiversity:
            state.vector.find((entry) => entry.dimension === "reviewDiversity")?.scoreBps ?? 0,
          reviewFreshness:
            state.vector.find((entry) => entry.dimension === "reviewFreshness")?.scoreBps ?? 0,
          contradictionPressure: contradiction,
          challengePressure: challenge,
          forecastSupport:
            state.vector.find((entry) => entry.dimension === "forecastSupport")?.scoreBps ?? 0,
          replicationSupport:
            state.vector.find((entry) => entry.dimension === "replicationSupport")?.scoreBps ?? 0,
        },
        issues:
          contradiction >= 6_000 || challenge >= 6_000
            ? [
                {
                  category: "certification_blocker",
                  severity: "high",
                  summary:
                    "Current contradiction or challenge pressure blocks certification from being quiet.",
                },
              ]
            : [],
        summary:
          readiness >= 7_500
            ? "The current claim review vector clears provisional certification thresholds."
            : "The current claim review vector has not yet cleared certification thresholds.",
        verdict:
          contradiction >= 6_000 || challenge >= 6_000
            ? "flag"
            : readiness >= 7_500
              ? "pass"
              : "inconclusive",
      };
    }
  }
}
