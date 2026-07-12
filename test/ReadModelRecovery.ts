import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rebuildReadModelFresh } from "../script/rebuild-read-model-fresh.js";

describe("read-model recovery", () => {
  it("requires fresh-database isolation for rebuilds", async () => {
    await assert.rejects(rebuildReadModelFresh({}), /SP_REBUILD_DATABASE_URL is required/);
    await assert.rejects(
      rebuildReadModelFresh({
        SP_DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/current",
        SP_REBUILD_DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/current",
      }),
      /must be a fresh database/,
    );
  });
});
