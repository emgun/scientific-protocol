import { describe, it } from "node:test";
import { expect } from "chai";
import { parseResolutionRunTxHashes } from "../src/resolver/store.js";

describe("resolver store", () => {
  it("parses persisted resolution transaction hashes defensively", () => {
    expect(parseResolutionRunTxHashes(null)).to.deep.equal([]);
    expect(parseResolutionRunTxHashes("")).to.deep.equal([]);
    expect(parseResolutionRunTxHashes('["0xabc","0xdef"]')).to.deep.equal(["0xabc", "0xdef"]);

    expect(() => parseResolutionRunTxHashes("{")).to.throw(
      "resolution run tx_hashes_json must be a JSON array of strings",
    );
    expect(() => parseResolutionRunTxHashes('["0xabc",5]')).to.throw(
      "resolution run tx_hashes_json must be a JSON array of strings",
    );
  });
});
