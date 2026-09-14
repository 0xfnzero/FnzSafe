import assert from "node:assert/strict";
import test from "node:test";

import { formatDappPayloadForDisplay } from "./dappPayload.ts";

test("formats nested EIP-712 JSON without escape slashes", () => {
  const typedData = JSON.stringify({
    types: { Permit: [{ name: "spender", type: "address" }] },
    primaryType: "Permit",
    message: { spender: "0x0000000000000000000000000000000000000001" },
  });
  const displayed = formatDappPayloadForDisplay(JSON.stringify({
    method: "eth_signTypedData_v4",
    params: ["0x0000000000000000000000000000000000000002", typedData],
  }));

  assert.doesNotMatch(displayed, /\\\"types\\\"/);
  const parsed = JSON.parse(displayed);
  assert.equal(parsed.params[1].primaryType, "Permit");
  assert.equal(parsed.params[1].types.Permit[0].name, "spender");
});

test("preserves ordinary and malformed string values", () => {
  const displayed = formatDappPayloadForDisplay(JSON.stringify({
    message: "Sign in to FnzSafe",
    malformed: "{not json}",
  }));
  const parsed = JSON.parse(displayed);
  assert.equal(parsed.message, "Sign in to FnzSafe");
  assert.equal(parsed.malformed, "{not json}");
});

test("falls back to the original payload when the outer JSON is invalid", () => {
  assert.equal(formatDappPayloadForDisplay("not-json"), "not-json");
});
