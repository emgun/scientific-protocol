import { ArtifactAdded } from "../generated/ArtifactRegistry/ArtifactRegistry";
import { Artifact } from "../generated/schema";

export function handleArtifactAdded(event: ArtifactAdded): void {
  const artifact = new Artifact(event.params.artifactId.toString());
  artifact.claim = event.params.claimId.toString();
  artifact.artifactType = event.params.artifactType;
  artifact.contentDigest = event.params.contentDigest;
  artifact.uri = event.params.uri;
  artifact.submitter = event.params.submitter;
  artifact.createdAtBlock = event.block.number;
  artifact.save();
}
