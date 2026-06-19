import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { expect } from "chai";
import {
  extractContractEventId,
  getProvider,
  getRpcUrl,
  requireContractEventId,
} from "../src/shared/contracts.js";
import {
  createManagedOperatorSigner,
  createOperatorSigner,
  destroySignerProvider,
  getOperatorPrivateKey,
  resetManagedOperatorSigners,
} from "../src/shared/operator.js";

type ProviderConnection = {
  _getConnection(): {
    url: string;
  };
};

function providerUrl(provider: unknown): string {
  return (provider as ProviderConnection)._getConnection().url;
}

describe("shared operator signers", () => {
  it("reads rpc urls from explicit env input", () => {
    expect(getRpcUrl({ SP_RPC_URL: " https://base.example.org " })).to.equal(
      "https://base.example.org",
    );
  });

  it("reads rpc urls from file-backed env input", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sp-rpc-url-"));
    const rpcUrlPath = path.join(tempRoot, "rpc-url");
    try {
      await writeFile(rpcUrlPath, " https://base-sepolia.example.org \n", "utf8");

      expect(getRpcUrl({ SP_RPC_URL_FILE: rpcUrlPath })).to.equal(
        "https://base-sepolia.example.org",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("reads private keys from explicit env input", () => {
    expect(
      getOperatorPrivateKey(["SP_OPERATOR_PRIVATE_KEY"], {
        env: {
          SP_OPERATOR_PRIVATE_KEY:
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        },
      }),
    ).to.equal("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
  });

  it("attaches operator signers to the requested rpc url", () => {
    resetManagedOperatorSigners();
    const signer = createOperatorSigner(["SP_OPERATOR_PRIVATE_KEY"], {
      rpcUrl: "http://127.0.0.1:8545",
    });

    expect(providerUrl(signer.provider)).to.equal("http://127.0.0.1:8545");
  });

  it("destroys cached managed signer providers on reset", () => {
    resetManagedOperatorSigners();
    const signer = createManagedOperatorSigner(["SP_OPERATOR_PRIVATE_KEY"], {
      rpcUrl: "http://127.0.0.1:8545",
    });
    const provider = signer.provider as ReturnType<typeof getProvider>;

    expect(provider.destroyed).to.equal(false);
    resetManagedOperatorSigners();
    expect(provider.destroyed).to.equal(true);
  });

  it("destroys one-shot signer providers explicitly", () => {
    const signer = createOperatorSigner(["SP_OPERATOR_PRIVATE_KEY"], {
      rpcUrl: "http://127.0.0.1:8545",
    });
    const provider = signer.provider as ReturnType<typeof getProvider>;

    expect(provider.destroyed).to.equal(false);
    destroySignerProvider(signer);
    expect(provider.destroyed).to.equal(true);
  });

  it("constructs providers for explicit rpc urls", () => {
    expect(providerUrl(getProvider("https://base.example.org"))).to.equal(
      "https://base.example.org",
    );
  });

  it("extracts contract event ids from matching receipt logs", () => {
    const contract = {
      interface: {
        parseLog(log: unknown) {
          if (log === "unrelated") {
            throw new Error("unknown event");
          }
          return {
            args: {
              claimId: { toString: () => "42" },
            },
            name: log === "target" ? "ClaimCreated" : "Other",
          };
        },
      },
    };

    expect(
      extractContractEventId(
        contract,
        { logs: ["unrelated", "other", "target"] },
        "ClaimCreated",
        "claimId",
      ),
    ).to.equal("42");
  });

  it("requires contract event ids with receipt-aware errors", () => {
    const contract = {
      interface: {
        parseLog() {
          return {
            args: {},
            name: "Other",
          };
        },
      },
    };

    expect(() =>
      requireContractEventId(
        contract,
        { hash: "0xabc", logs: ["other"] },
        "ClaimCreated",
        "claimId",
      ),
    ).to.throw("missing ClaimCreated.claimId in transaction 0xabc");
    expect(() => requireContractEventId(contract, null, "ClaimCreated", "claimId")).to.throw(
      "missing transaction receipt for ClaimCreated.claimId",
    );
  });
});
