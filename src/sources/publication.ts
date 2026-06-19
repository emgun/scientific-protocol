export function sourcePublicationDomainId(sourceMetadata: Record<string, unknown>): number {
  const value = sourceMetadata.domainId;
  if (value === undefined || value === null) {
    return 1;
  }
  const trimmed = typeof value === "string" ? value.trim() : null;
  if (trimmed === "") {
    return 1;
  }
  const parsed = typeof value === "number" ? value : trimmed === null ? NaN : Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("sourceMetadata.domainId must be a non-negative integer");
  }
  return parsed;
}
