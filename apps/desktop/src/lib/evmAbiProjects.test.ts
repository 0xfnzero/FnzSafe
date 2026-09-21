import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteEvmAbiProject,
  normalizeEvmAbiProject,
  parseEvmAbiProjectsJson,
  shortContractAddress,
  upsertEvmAbiProject,
} from "./evmAbiProjects.ts";

test("parses stored ABI projects and sorts by updatedAt", () => {
  const projects = parseEvmAbiProjectsJson(JSON.stringify({
    version: 1,
    projects: [
      {
        id: "a",
        name: "Old",
        chainId: 4663,
        chainName: "Robinhood",
        contractAddress: "0x1111111111111111111111111111111111111111",
        abiJsonText: "[]",
        abiFileName: "a.json",
        functionCount: 1,
        createdAt: 1,
        updatedAt: 10,
      },
      {
        id: "b",
        name: "New",
        chainId: 1,
        chainName: "Ethereum",
        contractAddress: "0x2222222222222222222222222222222222222222",
        abiJsonText: "[]",
        abiFileName: "b.json",
        functionCount: 2,
        createdAt: 2,
        updatedAt: 20,
      },
    ],
  }));
  assert.equal(projects.length, 2);
  assert.equal(projects[0].id, "b");
  assert.equal(projects[1].id, "a");
});

test("upserts and deletes ABI projects", () => {
  const created = upsertEvmAbiProject([], {
    name: "ArbExecutor",
    chainId: 4663,
    chainName: "Robinhood Chain",
    contractAddress: "0x2255810211B713C3ED06DF0Ea3E416064744fbb3",
    abiJsonText: "[{}]",
    abiFileName: "ArbExecutor.json",
    functionCount: 26,
  });
  assert.equal(created.projects.length, 1);
  assert.equal(created.project.name, "ArbExecutor");

  const updated = upsertEvmAbiProject(created.projects, {
    name: "ArbExecutor proxy",
    chainId: 4663,
    chainName: "Robinhood Chain",
    contractAddress: "0x2255810211B713C3ED06DF0Ea3E416064744fbb3",
    abiJsonText: "[{}]",
    abiFileName: "ArbExecutor.json",
    functionCount: 26,
  }, created.project.id);
  assert.equal(updated.projects.length, 1);
  assert.equal(updated.project.name, "ArbExecutor proxy");
  assert.equal(updated.project.id, created.project.id);

  const removed = deleteEvmAbiProject(updated.projects, created.project.id);
  assert.equal(removed.length, 0);
});

test("rejects incomplete project records", () => {
  assert.equal(normalizeEvmAbiProject({ id: "x", name: "y" }), null);
  assert.equal(shortContractAddress("0x2255810211B713C3ED06DF0Ea3E416064744fbb3"), "0x2255...fbb3");
});
