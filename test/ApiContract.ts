import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect } from "chai";
import { parse } from "yaml";
import { PUBLIC_API_OPERATIONS } from "../src/api/public-contract.js";

type OpenApiDocument = {
  components?: { schemas?: Record<string, { properties?: Record<string, { enum?: string[] }> }> };
  info?: { version?: string };
  openapi?: string;
  paths?: Record<string, Record<string, unknown>>;
};

describe("published API contracts", () => {
  it("keeps the executable public-operation manifest synchronized with OpenAPI", async () => {
    const document = parse(await readFile("schemas/openapi.yaml", "utf8")) as OpenApiDocument;
    expect(document.openapi).to.equal("3.1.0");
    expect(document.info?.version).to.equal("0.3.0");
    expect(document.paths).not.to.have.property("/sources#post");
    expect(document.paths).to.have.property("/claims/{claimId}/publish");
    expect(
      document.components?.schemas?.PublicWriteEnvelope?.properties?.actionType?.enum,
    ).to.include("claim_publish");

    const documented = Object.entries(document.paths ?? {}).flatMap(([pathname, pathItem]) =>
      Object.keys(pathItem)
        .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
        .map((method) => [method, pathname] as const),
    );
    expect(documented.sort()).to.deep.equal([...PUBLIC_API_OPERATIONS].sort());
  });

  it("compiles every published JSON Schema with a draft-2020 validator", async () => {
    const schemaFiles = [
      "schemas/claim.schema.json",
      "schemas/replication.schema.json",
      "schemas/evaluation.schema.json",
      "schemas/artifact-storage-attestation.schema.json",
      "schemas/artifact-storage-bundle.schema.json",
    ];
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const schemaFile of schemaFiles) {
      const schema = JSON.parse(await readFile(schemaFile, "utf8")) as object;
      expect(() => ajv.compile(schema), schemaFile).not.to.throw();
    }
  });
});
