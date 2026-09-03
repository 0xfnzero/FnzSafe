import assert from "node:assert/strict";
import test from "node:test";
import { persistJsonAfterHydration } from "./hydratedStorage.ts";

test("does not overwrite an existing cache before hydration completes", () => {
  const values = new Map([["signals", JSON.stringify({ signals: [{ id: "saved" }] })]]);
  const storage = {
    setItem(key, value) {
      values.set(key, value);
    },
  };

  const written = persistJsonAfterHydration(storage, "signals", { signals: [] }, false);

  assert.equal(written, false);
  assert.deepEqual(JSON.parse(values.get("signals")), { signals: [{ id: "saved" }] });
});

test("persists current state after hydration completes", () => {
  const values = new Map();
  const storage = {
    setItem(key, value) {
      values.set(key, value);
    },
  };

  const written = persistJsonAfterHydration(storage, "signals", { signals: [{ id: "current" }] }, true);

  assert.equal(written, true);
  assert.deepEqual(JSON.parse(values.get("signals")), { signals: [{ id: "current" }] });
});

test("reports storage failures without throwing into a React effect", () => {
  const storage = {
    setItem() {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
  };

  assert.equal(persistJsonAfterHydration(storage, "signals", { signals: [] }, true), false);
});
