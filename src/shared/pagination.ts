export type PaginationInput = {
  limit?: number;
  offset?: number;
};

export type NormalizedPagination = {
  limit: number;
  offset: number;
};

export type PageItems<T> = { items: T[]; total: number };

/** Read every page from an internal store without weakening the public 100-row cap. */
export async function readAllPages<T>(
  readPage: (pagination: NormalizedPagination) => Promise<PageItems<T>>,
  config: { pageSize?: number } = {},
): Promise<T[]> {
  const pageSize = Math.max(1, Math.min(100, Math.floor(config.pageSize ?? 100)));
  const items: T[] = [];
  let offset = 0;
  while (true) {
    const page = await readPage({ limit: pageSize, offset });
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) return items;
  }
}

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
