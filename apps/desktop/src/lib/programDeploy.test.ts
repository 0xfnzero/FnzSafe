import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  buildProgramDeploymentReceiptJson,
  compactProgramDeploymentReceiptJson,
  isLikelySolanaGenesisHash,
  isLikelySolanaPublicKey,
  parseProgramKeypairJson,
  programIdFromKeypairBytes,
  serializeProgramKeypairJson,
  sha256Hex,
} from "./programDeploy";

const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

function ephemeralSolanaKeypairBytes(): Uint8Array {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  assert.equal(jwk.kty, "OKP");
  assert.equal(jwk.crv, "Ed25519");
  assert.ok(jwk.d);
  assert.ok(jwk.x);

  const secret = Buffer.from(jwk.d, "base64url");
  const publicKey = Buffer.from(jwk.x, "base64url");
  assert.equal(secret.length, 32);
  assert.equal(publicKey.length, 32);
  const keypair = Uint8Array.from([...secret, ...publicKey]);
  secret.fill(0);
  publicKey.fill(0);
  return keypair;
}

function distinctKeypairs(): [Uint8Array, Uint8Array] {
  const first = ephemeralSolanaKeypairBytes();
  const firstProgramId = programIdFromKeypairBytes(first);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const second = ephemeralSolanaKeypairBytes();
    const secondProgramId = programIdFromKeypairBytes(second);
    if (secondProgramId !== firstProgramId) {
      return [first, second];
    }
    second.fill(0);
  }

  first.fill(0);
  throw new Error("failed to generate distinct test program keypairs");
}

function signature(character: string): string {
  return character.repeat(88);
}

test("parses and derives distinct arbitrary program keypairs", () => {
  const keypairs = distinctKeypairs();
  try {
    const programIds = keypairs.map((bytes) => {
      const serialized = JSON.stringify(Array.from(bytes));
      const parsed = parseProgramKeypairJson(serialized);
      assert.deepEqual(parsed, bytes);
      assert.equal(serializeProgramKeypairJson(parsed), serialized);

      const programId = programIdFromKeypairBytes(parsed);
      assert.equal(isLikelySolanaPublicKey(programId), true);
      parsed.fill(0);
      return programId;
    });

    assert.notEqual(programIds[0], programIds[1]);
  } finally {
    keypairs.forEach((bytes) => bytes.fill(0));
  }
});

test("rejects malformed program keypair material", () => {
  for (const invalid of [
    "not-json",
    "{}",
    JSON.stringify(new Array(63).fill(1)),
    JSON.stringify(new Array(65).fill(1)),
    JSON.stringify([...new Array(63).fill(1), -1]),
    JSON.stringify([...new Array(63).fill(1), 256]),
    JSON.stringify([...new Array(63).fill(1), 1.5]),
  ]) {
    assert.throws(() => parseProgramKeypairJson(invalid));
  }
  assert.throws(() => serializeProgramKeypairJson(new Uint8Array(63)));
  assert.throws(() => programIdFromKeypairBytes(new Uint8Array(65)));
});

test("accepts only canonical nonzero 32-byte public keys", () => {
  const keypair = ephemeralSolanaKeypairBytes();
  try {
    const publicKey = programIdFromKeypairBytes(keypair);
    assert.equal(isLikelySolanaPublicKey(publicKey), true);
    assert.equal(isLikelySolanaPublicKey("11111111111111111111111111111111"), false);
    assert.equal(isLikelySolanaPublicKey(`${publicKey}1`), false);
    assert.equal(isLikelySolanaPublicKey("not-a-public-key"), false);
  } finally {
    keypair.fill(0);
  }
});

test("accepts canonical built-in cluster genesis hashes", () => {
  for (const genesisHash of [
    MAINNET_GENESIS_HASH,
    DEVNET_GENESIS_HASH,
    TESTNET_GENESIS_HASH,
  ]) {
    assert.equal(isLikelySolanaGenesisHash(genesisHash), true);
  }
  assert.equal(isLikelySolanaGenesisHash("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), false);
  assert.equal(isLikelySolanaGenesisHash("11111111111111111111111111111111"), false);
  assert.equal(isLikelySolanaGenesisHash(`${DEVNET_GENESIS_HASH}1`), false);
  assert.equal(isLikelySolanaGenesisHash("not-a-genesis-hash"), false);
});

test("computes the uploaded program hash in the browser-compatible helper", async () => {
  const bytes = new TextEncoder().encode("generic-solana-program");
  assert.equal(
    await sha256Hex(bytes),
    "0ebf1b7a7064f81403a118f1807aa5d71502ef42ec788cd7433ccc8bc1596848",
  );
});

test("builds a target-bound receipt for an arbitrary program", () => {
  const [programKeypair, authorityKeypair] = distinctKeypairs();
  try {
    const programId = programIdFromKeypairBytes(programKeypair);
    const upgradeAuthority = programIdFromKeypairBytes(authorityKeypair);
    const bufferAddress = upgradeAuthority;
    const deploySignature = signature("5");
    const expected = {
      network: "devnet",
      genesisHash: DEVNET_GENESIS_HASH,
      programId,
      upgradeAuthority,
      programSha256: "ab".repeat(32),
      programBytes: 1_024,
    };
    const response = {
      status: "finalized",
      network: expected.network,
      genesis_hash: expected.genesisHash,
      program_id: expected.programId,
      programdata_address: programId,
      authority: expected.upgradeAuthority,
      program_sha256: expected.programSha256,
      program_bytes: expected.programBytes,
      max_data_len: 2_048,
      buffer_address: bufferAddress,
      create_buffer_signature: signature("2"),
      write_signatures: [signature("3"), signature("4")],
      deploy_signature: deploySignature,
      finalized_slot: 200,
      deployed_slot: 199,
      readback_verified: true,
      journal_revision: 7,
      attempt_evidence_version: 1,
      deployment_attempts: [
        {
          genesis_hash: expected.genesisHash,
          program_id: expected.programId,
          stage: "deploy",
          buffer_address: bufferAddress,
          chunk_index: null,
          signature: deploySignature,
          last_valid_block_height: 500,
          status: "finalized",
          created_at: 100,
          updated_at: 101,
        },
      ],
    };

    const receiptJson = buildProgramDeploymentReceiptJson(response, expected);
    const receipt = JSON.parse(receiptJson) as {
      receipt_type: string;
      schema_version: number;
      network: string;
      genesis_hash: string;
      program_id: string;
      programdata_address: string;
      upgrade_authority: string;
      buffer_address?: string;
      program_sha256: string;
      program_bytes: number;
      max_data_len: number;
      deploy_signature: string;
      readback_verified: boolean;
      deployed_slot: number;
      finalized_slot: number;
      status: string;
      journal?: unknown;
      transactions?: unknown;
      costs_lamports?: unknown;
    };
    assert.equal(receipt.network, expected.network);
    assert.equal(receipt.genesis_hash, expected.genesisHash);
    assert.equal(receipt.program_id, expected.programId);
    assert.equal(receipt.upgrade_authority, expected.upgradeAuthority);
    assert.equal(receipt.program_sha256, expected.programSha256);
    assert.equal(receipt.program_bytes, expected.programBytes);
    assert.equal(receipt.max_data_len, response.max_data_len);
    assert.equal(receipt.readback_verified, true);
    assert.equal(receipt.deploy_signature, deploySignature);
    assert.equal(receipt.status, "finalized");
    assert.equal(receipt.transactions, undefined);
    assert.equal(receipt.journal, undefined);
    assert.equal(receipt.costs_lamports, undefined);
    assert.equal(JSON.stringify(receipt).includes(signature("3")), false);
    assert.equal(receipt.receipt_type, "solana_program_deployment");
    assert.equal(receipt.schema_version, 3);
    assert.equal(receiptJson.endsWith("\n"), true);

    const tamperedResponses = [
      { ...response, network: "mainnet" },
      { ...response, genesis_hash: "11111111111111111111111111111111" },
      { ...response, program_id: upgradeAuthority },
      { ...response, authority: programId },
      { ...response, program_sha256: "cd".repeat(32) },
      { ...response, program_bytes: expected.programBytes + 1 },
      { ...response, programdata_address: "not-a-public-key" },
      { ...response, unexpected_policy: {} },
      { ...response, readback_verified: false },
      { ...response, deployed_slot: response.finalized_slot + 1 },
      { ...response, max_data_len: expected.programBytes - 1 },
      { ...response, deploy_signature: "invalid-signature" },
      { ...response, journal_revision: null },
      {
        ...response,
        deployment_attempts: [
          { ...response.deployment_attempts[0], program_id: upgradeAuthority },
        ],
      },
      {
        ...response,
        deployment_attempts: [
          { ...response.deployment_attempts[0], genesis_hash: upgradeAuthority },
        ],
      },
      {
        ...response,
        deployment_attempts: [
          { ...response.deployment_attempts[0], status: "unknown" },
        ],
      },
      {
        ...response,
        deployment_attempts: [
          { ...response.deployment_attempts[0], unexpected_field: true },
        ],
      },
    ];
    for (const tampered of tamperedResponses) {
      assert.throws(() => buildProgramDeploymentReceiptJson(tampered, expected));
    }

    const alreadyDeployedReceipt = JSON.parse(
      buildProgramDeploymentReceiptJson(
        {
          ...response,
          status: "already_deployed_verified",
          buffer_address: "",
          create_buffer_signature: null,
          write_signatures: [],
          deploy_signature: null,
          journal_revision: null,
          attempt_evidence_version: null,
          deployment_attempts: [],
        },
        expected,
      ),
    );
    assert.equal(alreadyDeployedReceipt.status, "already_deployed_verified");
    assert.equal(alreadyDeployedReceipt.buffer_address, undefined);
  } finally {
    programKeypair.fill(0);
    authorityKeypair.fill(0);
  }
});

test("compacts legacy deployment receipts before download", () => {
  const [programKeypair, authorityKeypair] = distinctKeypairs();
  try {
    const programId = programIdFromKeypairBytes(programKeypair);
    const upgradeAuthority = programIdFromKeypairBytes(authorityKeypair);
    const deploySignature = signature("5");
    const legacyReceipt = {
      schema_version: 1,
      receipt_type: "solana_program_deployment",
      cluster: {
        network: "devnet",
        genesis_hash: DEVNET_GENESIS_HASH,
      },
      program: {
        program_id: programId,
        programdata_address: programId,
        upgrade_authority: upgradeAuthority,
        buffer_address: upgradeAuthority,
      },
      artifact: {
        program_sha256: "ab".repeat(32),
        program_len: 1_024,
        max_data_len: 2_048,
      },
      transactions: {
        create_buffer: signature("2"),
        writes_this_request: [signature("3"), signature("4")],
        deploy: deploySignature,
      },
      costs_lamports: {
        rent: 1_000,
        estimated_transaction_fees: 2_000,
      },
      finalized_readback: {
        verified: true,
        finalized_slot: 200,
        deployed_slot: 199,
        status: "finalized",
      },
      journal: {
        attempts: new Array(100).fill({
          signature: signature("3"),
          status: "confirmed",
        }),
      },
    };

    const compactJson = compactProgramDeploymentReceiptJson(JSON.stringify(legacyReceipt));
    const compact = JSON.parse(compactJson) as Record<string, unknown>;
    assert.equal(compact.schema_version, 3);
    assert.equal(compact.network, "devnet");
    assert.equal(compact.program_id, programId);
    assert.equal(compact.program_sha256, "ab".repeat(32));
    assert.equal(compact.program_bytes, 1_024);
    assert.equal(compact.max_data_len, 2_048);
    assert.equal(compact.deploy_signature, deploySignature);
    assert.equal(compact.readback_verified, true);
    assert.equal(compact.transactions, undefined);
    assert.equal(compact.journal, undefined);
    assert.equal(compact.costs_lamports, undefined);
    assert.equal(compactJson.includes(signature("3")), false);
    assert.ok(compactJson.length < 1_500);
  } finally {
    programKeypair.fill(0);
    authorityKeypair.fill(0);
  }
});
