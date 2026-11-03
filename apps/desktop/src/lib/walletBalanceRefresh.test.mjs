import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";

const source = fs.readFileSync(new URL("./walletBalanceRefresh.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createWalletBalanceRefresh } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function fixture(count = 19) {
  const queue = createWalletBalanceRefresh();
  const calls = [];
  const values = new Map();
  const errors = [];
  const targets = Array.from({ length: count }, (_, index) => ({
    key: `wallet-${index}:chain`, walletId: `wallet-${index}`, identity: `address-${index}`,
    load: async () => { calls.push(index); return index + 10; },
  }));
  const options = {
    targets, selectedWalletId: "wallet-0", contextKey: "rpc-a", refreshKey: "0",
    onStart: () => {},
    onSuccess: ({ key }, value) => values.set(key, value),
    onError: ({ key }, error) => errors.push([key, error.message]),
  };
  return { queue, calls, values, errors, options };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("19 wallets load once; switching A-B-C-A requests only the selected wallet", async () => {
  const f = fixture();
  await f.queue.refresh(f.options);
  assert.equal(f.calls.length, 19);
  for (const index of [1, 2, 0]) {
    const before = f.calls.length;
    await f.queue.refresh({ ...f.options, selectedWalletId: `wallet-${index}` });
    assert.deepEqual(f.calls.slice(before), [index]);
    // Session-check completion and unrelated rerenders must not reload the list.
    await f.queue.refresh({ ...f.options, selectedWalletId: `wallet-${index}` });
    assert.equal(f.calls.length, before + 1);
  }
  assert.equal(f.values.size, 19);
});

test("selection changes reuse in-flight requests and retain other wallets' results", async () => {
  const f = fixture(2);
  const pending = deferred();
  let calls = 0;
  f.options.targets[1].load = () => { calls += 1; return pending.promise; };
  const initial = f.queue.refresh(f.options);
  await Promise.resolve();
  const switched = f.queue.refresh({ ...f.options, selectedWalletId: "wallet-1" });
  pending.resolve(42);
  await Promise.all([initial, switched]);
  assert.equal(calls, 1);
  assert.equal(f.values.get("wallet-0:chain"), 10);
  assert.equal(f.values.get("wallet-1:chain"), 42);
});

test("manual refresh reloads the list but failed refresh never replaces the last successful value", async () => {
  const f = fixture(2);
  await f.queue.refresh(f.options);
  const pending = deferred();
  f.options.targets[0].load = () => pending.promise;
  const refresh = f.queue.refresh({ ...f.options, refreshKey: "1" });
  assert.equal(f.values.get("wallet-0:chain"), 10);
  pending.resolve(99);
  await refresh;
  assert.equal(f.values.get("wallet-0:chain"), 99);
  f.options.targets[0].load = async () => { throw new Error("RPC unavailable"); };
  await f.queue.refresh({ ...f.options, refreshKey: "2", selectedWalletId: "wallet-1" });
  assert.equal(f.values.get("wallet-0:chain"), 99);
  assert.deepEqual(f.errors, [["wallet-0:chain", "RPC unavailable"]]);
  assert.deepEqual(f.calls, [0, 1, 1, 1]);
});

test("old RPC responses cannot overwrite a new network configuration", async () => {
  const f = fixture(1);
  const pending = deferred();
  f.options.targets[0].load = () => pending.promise;
  const old = f.queue.refresh(f.options);
  await Promise.resolve();
  const targets = [{ ...f.options.targets[0], load: async () => 55 }];
  await f.queue.refresh({ ...f.options, targets, contextKey: "rpc-b" });
  pending.resolve(12);
  await old;
  assert.equal(f.values.get("wallet-0:chain"), 55);
});

test("changed addresses and newly added wallets load without refreshing unchanged wallets", async () => {
  const f = fixture(2);
  await f.queue.refresh(f.options);
  f.options.targets[0].identity = "replacement-address";
  f.options.targets.push({ key: "wallet-2:chain", walletId: "wallet-2", identity: "address-2", load: async () => { f.calls.push(2); return 12; } });
  await f.queue.refresh(f.options);
  assert.deepEqual(f.calls, [0, 1, 0, 2]);
});

test("unmount invalidates pending results", async () => {
  const f = fixture(1);
  const pending = deferred();
  f.options.targets[0].load = () => pending.promise;
  const old = f.queue.refresh(f.options);
  await Promise.resolve();
  f.queue.clear();
  pending.resolve(10);
  await old;
  assert.equal(f.values.size, 0);
});
