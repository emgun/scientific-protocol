export type PaginationInput = {
  limit?: number;
  offset?: number;
};

export type NormalizedPagination = {
  limit: number;
  offset: number;
};

export function normalizePagination(
  options: PaginationInput,
  config: { defaultLimit?: number } = {},
): NormalizedPagination {
  const defaultLimit = config.defaultLimit ?? 20;
  const limit = Number.isFinite(options.limit) ? Number(options.limit) : defaultLimit;
  const offset = Number.isFinite(options.offset) ? Number(options.offset) : 0;
  return {
    limit: Math.max(1, Math.min(100, Math.floor(limit))),
    offset: Math.max(0, Math.floor(offset)),
  };
}
