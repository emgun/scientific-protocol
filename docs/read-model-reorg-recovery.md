# Read-model reorg recovery

The indexer records the canonical hash at every committed chunk cursor and verifies that hash before
the next sync. Remote RPC profiles also hold indexing behind `SP_INDEXER_CONFIRMATION_DEPTH` (12 by
default). A mismatch stops indexing with `ReadModelReorgDetectedError`; it never continues from a
forked cursor.

## Safe rebuild command

Rebuild chain-derived state into a fresh database while leaving the current operated database
untouched:

```bash
SP_DATABASE_URL='postgresql://.../current' \
SP_REBUILD_DATABASE_URL='postgresql://.../fresh-rebuild' \
SP_DEPLOYMENT_PATH='/absolute/path/to/deployment.json' \
npm run indexer:rebuild:fresh
```

The command refuses the current database and refuses a target containing chain-derived or
operational records. Verify counts and indexed block/hash evidence in the fresh database before any
read-only traffic switch.

## Why in-place rewind is not automatic yet

Only the chain-derived tables are replayable from logs: `claims`, `artifacts`, `replications`,
`checkpoints`, `agents`, `agent_controllers`, `forecasts`, `challenges`, and `appeals`. Operated
tables—including sources, persisted artifacts, review/replication work, signed requests, webhook
state, reward settlements, resolution runs, and publication attempts—must survive a reorg.

Several operated tables currently reference chain-derived rows through immediate `ON DELETE
CASCADE` foreign keys, and most chain-derived rows do not retain their originating block number and
hash. An in-place delete-and-replay would therefore erase operated evidence, while an upsert-only
replay cannot remove orphaned fork records. Automatic rewind requires a migration that adds event
provenance to every chain-derived row and changes operated references to preservation-safe linkage.
Until that migration is designed and deployed, use a fresh rebuild, preserve the old database, and
reconcile operated records explicitly before moving write traffic.
