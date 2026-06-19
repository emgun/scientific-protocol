import { upsertPersistedArtifact } from "../coordinator/store.js";
import {
  readAllCheckpoints,
  readClaimsPage,
  readMetadata,
  readReplicationsPage,
  readSyncCursor,
} from "../indexer/store.js";
import { persistJsonArtifact, sha256Hex } from "../shared/persisted-artifacts.js";
import {
  insertReputationPayload,
  type LeaderboardEntryView,
  prepareReputationStore,
  type ReputationPayloadView,
  replaceLeaderboardEntries,
} from "./store.js";

type ActorAggregate = {
  checkpointCount: number;
  claimCount: number;
  fraudulentClaimCount: number;
  refutedClaimCount: number;
  replicationCount: number;
  score: bigint;
  subjectActor: string;
  supportedClaimCount: number;
};

export type ComputedLeaderboard = {
  entries: LeaderboardEntryView[];
  payload: ReputationPayloadView;
};

export async function computeDomainLeaderboard(
  connectionString: string | undefined,
  domainId: number,
): Promise<ComputedLeaderboard> {
  const pool = await prepareReputationStore(connectionString);
  try {
    const [metadata, cursorBlock, claimsPage, allCheckpoints] = await Promise.all([
      readMetadata(pool),
      readSyncCursor(pool),
      readClaimsPage(pool, { domainId, limit: 1000, offset: 0 }),
      readAllCheckpoints(pool),
    ]);
    const claimIds = claimsPage.items.map((claim) => claim.claimId);
    const replicationsPage = await readReplicationsPage(pool, { limit: 1000, offset: 0 });
    const replications = replicationsPage.items.filter((replication) =>
      claimIds.includes(replication.claimId),
    );
    const checkpoints = allCheckpoints.filter((checkpoint) => checkpoint.domainId === domainId);

    const aggregates = new Map<string, ActorAggregate>();
    const getAggregate = (actor: string): ActorAggregate => {
      const key = actor.toLowerCase();
      let aggregate = aggregates.get(key);
      if (!aggregate) {
        aggregate = {
          checkpointCount: 0,
          claimCount: 0,
          fraudulentClaimCount: 0,
          refutedClaimCount: 0,
          replicationCount: 0,
          score: 0n,
          subjectActor: actor,
          supportedClaimCount: 0,
        };
        aggregates.set(key, aggregate);
      }
      return aggregate;
    };

    for (const claim of claimsPage.items) {
      const aggregate = getAggregate(claim.author);
      aggregate.claimCount += 1;
      aggregate.score += 10n;
      if (claim.status === 3 || claim.status === 4) {
        aggregate.supportedClaimCount += 1;
        aggregate.score += claim.status === 4 ? 40n : 25n;
      } else if (claim.status === 5) {
        aggregate.refutedClaimCount += 1;
        aggregate.score -= 20n;
      } else if (claim.status === 6) {
        aggregate.fraudulentClaimCount += 1;
        aggregate.score -= 60n;
      }
    }

    for (const replication of replications) {
      const aggregate = getAggregate(replication.replicator);
      aggregate.replicationCount += 1;
      if (replication.resolutionStatus === 1) {
        aggregate.score += 20n;
      } else if (replication.resolutionStatus === 2) {
        aggregate.score += 25n;
      } else if (replication.resolutionStatus === 3) {
        aggregate.score += 5n;
      } else if (replication.resolutionStatus === 4) {
        aggregate.score -= 10n;
      } else if (replication.resolutionStatus === 5) {
        aggregate.score -= 40n;
      }
    }

    for (const checkpoint of checkpoints) {
      if (checkpoint.subjectActor === "0x0000000000000000000000000000000000000000") {
        continue;
      }
      const aggregate = getAggregate(checkpoint.subjectActor);
      aggregate.checkpointCount += 1;
      aggregate.score += 2n;
    }

    const ordered = [...aggregates.values()].sort((left, right) => {
      if (left.score === right.score) {
        return left.subjectActor.toLowerCase().localeCompare(right.subjectActor.toLowerCase());
      }
      return left.score > right.score ? -1 : 1;
    });

    const payloadBody = {
      contentHashAlgorithm: "sha256",
      createdAt: new Date().toISOString(),
      cutoffBlock: metadata.latestBlock,
      cursorBlock,
      domainId,
      entries: ordered.map((entry, index) => ({
        rank: index + 1,
        subjectActor: entry.subjectActor,
        score: entry.score.toString(),
        claimCount: entry.claimCount,
        supportedClaimCount: entry.supportedClaimCount,
        refutedClaimCount: entry.refutedClaimCount,
        fraudulentClaimCount: entry.fraudulentClaimCount,
        replicationCount: entry.replicationCount,
        checkpointCount: entry.checkpointCount,
      })),
      producer: "scientific-protocol/reputation-engine",
      schemaVersion: "1.0.0",
    };

    const persisted = await persistJsonArtifact("reputation-payload", payloadBody);
    await upsertPersistedArtifact(pool, persisted);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const payload = await insertReputationPayload(client, {
        artifactKey: persisted.artifactKey,
        cursorBlock,
        cutoffBlock: metadata.latestBlock,
        domainId,
        entryCount: ordered.length,
        payloadHash: `0x${sha256Hex(JSON.stringify(payloadBody))}`,
      });
      await replaceLeaderboardEntries(
        client,
        payload.payloadId,
        ordered.map((entry, index) => ({
          ...entry,
          domainId,
          rank: index + 1,
        })),
      );
      await client.query("COMMIT");

      return {
        entries: ordered.map((entry, index) => ({
          payloadId: payload.payloadId,
          domainId,
          rank: index + 1,
          subjectActor: entry.subjectActor,
          score: entry.score.toString(),
          claimCount: entry.claimCount,
          supportedClaimCount: entry.supportedClaimCount,
          refutedClaimCount: entry.refutedClaimCount,
          fraudulentClaimCount: entry.fraudulentClaimCount,
          replicationCount: entry.replicationCount,
          checkpointCount: entry.checkpointCount,
        })),
        payload,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
