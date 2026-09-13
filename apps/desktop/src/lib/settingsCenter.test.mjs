import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./settingsCenter.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`;
const settings = await import(moduleUrl);

function memoryStorage(values) {
  return { getItem: (key) => values[key] ?? null };
}

test("dangerous wallet maintenance tools are disabled by default", () => {
  assert.equal(settings.DEFAULT_APP_PREFERENCES.developerWalletMaintenance, false);
});

test("legacy RPC selections migrate to the selected profile network", () => {
  assert.equal(settings.resolveLegacySolanaNetwork("solana-devnet", undefined), "devnet");
  assert.equal(settings.resolveLegacySolanaNetwork("publicnode-testnet", undefined), "testnet");
  assert.equal(settings.resolveLegacySolanaNetwork("custom-testnet", [
    { id: "custom-testnet", network: "testnet", url: "https://rpc.example" },
  ]), "testnet");
  assert.equal(settings.resolveLegacySolanaNetwork("broken", [{ id: "broken", network: "localnet" }]), "mainnet");

  const imported = settings.buildLegacySettingsImport(memoryStorage({
    "fnzero-safe-network-v1": "custom-devnet",
    "fnzero-safe-rpc-profiles-v1": JSON.stringify([{ id: "custom-devnet", network: "devnet" }]),
  }));
  assert.equal(imported.solanaNetwork, "devnet");
});

test("search matches bilingual keywords and summaries", () => {
  const item = { title: "安全与隐私", description: "Auto lock", summary: "15 分钟", keywords: ["password", "密码"] };
  assert.equal(settings.matchesSettingsSearch(item, "auto"), true);
  assert.equal(settings.matchesSettingsSearch(item, "密码"), true);
  assert.equal(settings.matchesSettingsSearch(item, "RPC"), false);
});

test("DApp permissions prefer stable wallet ids while accepting legacy public keys", () => {
  const wallet = {
    id: "wallet-id",
    public_key: "wallet-public-key",
    evm_address: "0x1111111111111111111111111111111111111111",
  };
  assert.equal(settings.dappPermissionMatchesWallet({ walletId: "wallet-id" }, wallet), true);
  assert.equal(settings.dappPermissionMatchesWallet({ walletId: "wallet-public-key" }, wallet), true);
  assert.equal(settings.dappPermissionMatchesWallet({
    walletId: "0x1111111111111111111111111111111111111111".toUpperCase(),
  }, wallet), true);
  assert.equal(settings.dappPermissionMatchesWallet({ walletId: "another-wallet" }, wallet), false);
  assert.equal(settings.dappPermissionMatchesWallet({
    walletId: "wallet-id",
    walletPublicKey: "wallet-public-key",
  }, wallet), true);
  assert.equal(settings.dappPermissionMatchesWallet({
    walletId: "wallet-id",
    walletPublicKey: "different-public-key",
  }, wallet), false);
  assert.equal(settings.dappPermissionMatchesWallet({
    walletId: "wallet-id",
    walletPublicKey: "0x1111111111111111111111111111111111111111".toUpperCase(),
  }, wallet), true);
});

test("addresses normalize and duplicates are network scoped", () => {
  const address = "0x00000000000000000000000000000000000000AA";
  assert.equal(settings.normalizeAddress("evm", address), address.toLowerCase());
  const entries = [{ id: "1", chain: "evm", network: "1", address, label: "A", createdAtMs: 0, updatedAtMs: 0 }];
  assert.equal(settings.addressBookDuplicate(entries, { chain: "evm", network: "1", address: address.toLowerCase() }), true);
  assert.equal(settings.addressBookDuplicate(entries, { chain: "evm", network: "10", address }), false);
});

test("address-book networks are canonical and cannot bypass duplicate checks", () => {
  assert.equal(settings.normalizeAddressNetwork("solana", " DEVNET "), "devnet");
  assert.equal(settings.normalizeAddressNetwork("solana", "localnet"), null);
  assert.equal(settings.normalizeAddressNetwork("evm", "01"), null);
  assert.equal(settings.normalizeAddressNetwork("evm", "10"), "10");
  assert.equal(settings.normalizeAddressNetwork("evm", String(Number.MAX_SAFE_INTEGER + 1)), null);

  const address = "0x00000000000000000000000000000000000000AA";
  const entries = [{ id: "1", chain: "evm", network: "1", address, label: "A", createdAtMs: 0, updatedAtMs: 0 }];
  assert.equal(settings.addressBookDuplicate(entries, { chain: "evm", network: "01", address }), false);
});

test("Solana addresses must decode to exactly 32 bytes", () => {
  assert.equal(settings.normalizeAddress("solana", "11111111111111111111111111111111"), "11111111111111111111111111111111");
  assert.equal(settings.normalizeAddress("solana", "111111111111111111111111111111111"), null);
  assert.equal(settings.normalizeAddress("solana", "Vote111111111111111111111111111111111111111"), "Vote111111111111111111111111111111111111111");
  assert.equal(settings.normalizeAddress("solana", "not-an-address"), null);
});

test("Bitcoin and TRON address-book entries use their mainnet identities", () => {
  assert.equal(
    settings.normalizeAddress("bitcoin", "BC1P5CYXNUXMEUWUVKWFEM96LQZSZD02N6XDCJRS20CAC6YQJJWUDPXQKEDRCR"),
    "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
  );
  assert.equal(
    settings.normalizeAddress("bitcoin", "BC1QCR8TE4KR609GCAWUTMRZA0J4XV80JY8Z306FYU"),
    "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
  );
  assert.equal(settings.normalizeAddress("bitcoin", "bc1-not-an-address"), null);
  assert.equal(
    settings.normalizeAddress("tron", "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"),
    "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC",
  );
  assert.equal(settings.normalizeAddress("tron", "not-a-tron-address"), null);
  assert.equal(
    settings.normalizeAddressNetwork("bitcoin", "BIP122:000000000019D6689C085AE165831E93"),
    "bip122:000000000019d6689c085ae165831e93",
  );
  assert.equal(settings.normalizeAddressNetwork("tron", "TRON:728126428"), "tron:728126428");
});

test("network visibility and fallback always preserve an eligible EVM network", () => {
  const chains = [{ chain_id: 1, testnet: false }, { chain_id: 10, testnet: false }, { chain_id: 11155111, testnet: true }];
  const preferences = { ...settings.DEFAULT_APP_PREFERENCES, enabledEvmChainIds: [10], showTestnets: false };
  assert.deepEqual(settings.visibleEvmChainIds(chains, preferences), [10]);
  assert.equal(settings.enabledChainFallback(1, [10]), 10);
});

test("network toggles materialize hidden-testnet fallback and keep one eligible chain", () => {
  const chains = [{ chain_id: 1, testnet: false }, { chain_id: 10, testnet: false }, { chain_id: 11155111, testnet: true }];
  const hiddenTestnetOnly = { ...settings.DEFAULT_APP_PREFERENCES, enabledEvmChainIds: [11155111], showTestnets: false };
  assert.deepEqual(settings.visibleEvmChainIds(chains, hiddenTestnetOnly), [1]);
  assert.deepEqual(settings.toggleEnabledEvmChain(chains, hiddenTestnetOnly, 1, false), [1, 11155111]);
  assert.deepEqual(settings.toggleEnabledEvmChain(chains, hiddenTestnetOnly, 10, true), [1, 10, 11155111]);
  const twoMainnets = { ...hiddenTestnetOnly, enabledEvmChainIds: [1, 10, 11155111] };
  assert.deepEqual(settings.toggleEnabledEvmChain(chains, twoMainnets, 1, false), [10, 11155111]);
});

test("auto lock deadline supports never and deterministic expiry", () => {
  assert.equal(settings.nextAutoLockDeadline(1000, null), null);
  const deadline = settings.nextAutoLockDeadline(1000, 1);
  assert.equal(deadline, 61000);
  assert.equal(settings.hasAutoLockExpired(deadline, 60999), false);
  assert.equal(settings.hasAutoLockExpired(deadline, 61000), true);
});

test("locking strips secrets and temporary signing results from form state", () => {
  assert.deepEqual(settings.stripSensitiveFormFields({
    network: "mainnet",
    amount: "1",
    password: "secret",
    privateKey: "key",
    transactionBase64: "transaction",
    externalSignBackfillJson: "signed payload",
    signature: "signature",
  }), { network: "mainnet", amount: "1" });
});

test("serial task queue preserves write order and recovers after a rejection", async () => {
  const enqueue = settings.createSerialTaskQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
    return 1;
  });
  const rejected = enqueue(async () => {
    events.push("second");
    throw new Error("expected");
  });
  const third = enqueue(async () => {
    events.push("third");
    return 3;
  });

  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  assert.equal(await first, 1);
  await assert.rejects(rejected, /expected/);
  assert.equal(await third, 3);
  assert.deepEqual(events, ["first:start", "first:end", "second", "third"]);
});

test("DApp approval persists permission first and rolls back a newly created grant", async () => {
  const events = [];
  await assert.rejects(
    settings.persistPermissionBeforeApproval({
      permissionAlreadyExisted: false,
      grant: async () => {
        events.push("grant");
        return { id: "permission" };
      },
      approve: async () => {
        events.push("approve");
        throw new Error("bridge failed");
      },
      revoke: async () => {
        events.push("revoke");
      },
    }),
    /bridge failed/,
  );
  assert.deepEqual(events, ["grant", "approve", "revoke"]);
});

test("DApp approval preserves a permission that already existed", async () => {
  let revoked = false;
  await assert.rejects(
    settings.persistPermissionBeforeApproval({
      permissionAlreadyExisted: true,
      grant: async () => ({ id: "permission" }),
      approve: async () => {
        throw new Error("bridge failed");
      },
      revoke: async () => {
        revoked = true;
      },
    }),
    /bridge failed/,
  );
  assert.equal(revoked, false);
});
