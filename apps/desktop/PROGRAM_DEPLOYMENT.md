# Solana Program Deployment with FnzSafe

This guide covers the first deployment of an arbitrary Solana SBF program through the FnzSafe UI. It is for new upgradeable-loader Program IDs, not upgrades to an existing program.

FnzSafe is a general-purpose wallet and program operations tool. It does not audit a contract, approve a release, or make an untrusted binary safe. Complete the program's security review, reproducible build, local-validator tests, and release approval before using this workflow.

Every deployment spends SOL and may submit many transactions. Use the local desktop application or a UI and API bound only to loopback. Never expose the local API through a public proxy, tunnel, or port forward.

## Inputs and trust boundaries

Prepare these inputs before opening the deployment form:

- The final SBF `.so` produced from the approved source revision.
- The Program keypair JSON for the new Program ID.
- A saved payer wallet that will remain the ProgramData Upgrade Authority.
- The target RPC profile and independently confirmed cluster genesis hash.
- The independently approved SHA-256 of the exact `.so` file.
- An optional `max_data_len` decision and, only when recovering, the recorded Buffer address.

The UI and local API validate consistency between these values, but they cannot establish that the program's business logic is correct.

## Protect the Program keypair

The Program keypair determines the Program ID and signs creation of the new Program account. Treat the JSON file as secret key material:

- Keep it outside the repository, downloads folder, shared drives, cloud sync, shell history, logs, tickets, and chat.
- Do not print the JSON with `cat`, paste it into a terminal, or include it in screenshots or screen sharing.
- Store an encrypted, access-controlled backup before deployment. Verify the backup without displaying its contents.
- Upload it only to the trusted local FnzSafe UI for the deployment request. Clear the form and close unneeded browser windows afterward.
- Stop if the Program ID derived by the UI differs from the approved Program ID.

The Program keypair and Upgrade Authority are different roles. The Program keypair fixes the program address. After deployment, upgrades are controlled by the ProgramData Upgrade Authority, which is the selected deployment wallet in this workflow. Protect both credentials independently.

If the Program keypair may have been exposed, do not deploy it. Generate a new Program keypair, update the approved Program ID, and repeat all address-dependent review.

## Independent artifact confirmation

The browser computes and displays the SHA-256 and byte length of the uploaded `.so`. A second operator must calculate the digest from the approved artifact independently, for example:

```bash
shasum -a 256 /absolute/path/to/program.so
wc -c < /absolute/path/to/program.so
```

On Linux, `sha256sum` may be used instead. Enter the independently approved 64-character lowercase SHA-256 in the deployment form. The entered digest, browser digest, and release record must match exactly. A matching hash proves file identity, not contract safety.

Do not replace or rebuild the `.so` after approval. Any byte change requires a new digest and a new release review.

## Network and genesis confirmation

Select the intended RPC profile before loading deployment material. Confirm all of the following:

- The UI network and RPC endpoint are the intended target.
- The expected genesis hash displayed by the deployment form matches the approved release target.
- An independent read-only check against the target RPC returns the same genesis hash.
- The payer wallet is funded on that exact cluster.

An RPC profile label such as `devnet` is not proof of cluster identity. FnzSafe reads the RPC's actual genesis hash before unlocking the wallet or spending SOL and rejects a mismatch. For a custom RPC, confirm that it serves the intended cluster and that its genesis hash is supported by the deployment form.

Do not work around a mismatch by changing the network label or expected hash. Stop and identify whether the RPC profile or release target is wrong.

## `max_data_len`

`max_data_len` is the allocated ProgramData capacity, not the current `.so` length.

- Leave it empty to allocate the current artifact length.
- Set it only when the release plan explicitly reserves space for a larger future version.
- It must be at least the uploaded `.so` byte length and no greater than the limit shown by the UI.
- A larger value increases rent. A value equal to the current file may prevent a later upgrade to a larger binary.
- Once a deployment journal exists, the value is part of the deployment intent. Never change it during recovery.

Record the approved value with the release evidence before signing.

## First deployment through the UI

1. Start FnzSafe locally and open the UI. Confirm the local API health endpoint before loading any key material.
2. Select the target RPC profile, then open **Program Workspace** and **Deploy Program**.
3. Select the saved deployment wallet. Verify that its public key is the intended payer and Upgrade Authority.
4. Upload the approved `.so`. Compare the displayed filename, byte length, and SHA-256 with the release record.
5. Enter the independently approved `.so` SHA-256.
6. Upload the Program keypair JSON. Compare the Program ID derived by the UI with the approved Program ID.
7. Confirm the expected Upgrade Authority, target network, RPC endpoint, and genesis hash.
8. Leave `max_data_len` empty or enter the approved capacity. For a fresh attempt, leave the recovery Buffer field empty.
9. Review the cost estimate. Ensure the payer has enough SOL for Buffer, Program, ProgramData rent, transaction fees, and the displayed reserves.
10. Confirm that no other operator, browser window, CLI process, or deployment tool is deploying the same Program ID.
11. Click **Deploy Program**, unlock the saved wallet in the password prompt, and confirm once. Do not repeatedly click, close the API, or start a parallel deployment while transactions are pending.

The backend verifies the SBF binary before signing, checks the Program ID derived from the keypair, compares the artifact hash, validates the actual genesis hash, and requires the payer to match the expected Upgrade Authority. These checks are deployment safeguards, not a substitute for contract review.

## Interrupted deployment and Buffer recovery

A first deployment may require create-buffer, multiple write, and deploy transactions. A timeout or lost response does not prove that a transaction failed. Never blindly retry.

Use the persisted deployment record shown by FnzSafe to determine the next action. Recovery must retain the exact same intent:

- cluster genesis hash and Program ID;
- `.so` bytes, SHA-256, and byte length;
- Program keypair and Upgrade Authority;
- `max_data_len`;
- recorded Buffer address and completed write evidence.

Use **Resume Buffer** only with the Buffer recorded for that deployment intent. The backend must verify its finalized owner, authority, allocated length, and existing bytes before planning missing writes. Do not paste an unrelated Buffer, delete or edit journal data, rotate the payer, or switch RPC profiles to force progress.

If a transaction status is uncertain, reconcile its recorded signature and last-valid-block-height first. A safe retry requires evidence that the earlier signed effect is absent or that the workflow is resuming the exact same finalized state. Keep only one recovery operator and one active UI session.

## Finalized readback and receipt

Do not consider deployment complete merely because a transaction signature exists. Completion requires the UI to report a successful finalized readback that binds:

- network and actual genesis hash;
- Program ID and ProgramData address;
- Upgrade Authority;
- `.so` SHA-256, deployed byte length, and `max_data_len`;
- deployment signatures and finalized/deployed slots;
- `readback_verified = true`.

Download the deployment receipt immediately. Independently compute its SHA-256, archive it with the source revision, build metadata, artifact digest, Program ID approval, and operator review, and verify the Program on-chain through a separate read-only method.

A receipt records what FnzSafe observed and submitted. It is not a contract audit, source-to-binary proof, or external attestation. Any required reviewer signatures or deployment attestations must be created separately after checking the finalized readback.

## Stop conditions

Stop without signing if any of these conditions occurs:

- artifact hash, length, Program ID, authority, network, or genesis hash differs from the release record;
- the target Program or ProgramData already exists unexpectedly;
- the Program keypair or wallet credential may have been exposed;
- the deployment record refers to a different intent or an unknown Buffer;
- the RPC result is incomplete, inconsistent, or cannot reach finalized commitment;
- another deployment or recovery attempt may still be active;
- the payer balance or cost estimate is uncertain.

An existing Program must be handled as an explicit inspection, recovery, or upgrade workflow. A first-deployment form must never be used to overwrite it.
