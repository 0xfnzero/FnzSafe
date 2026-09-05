# FnzeroSafe UI Wallet User Guide

[中文](UI_USER_GUIDE_CN.md) | [Project README](README.md)

FnzeroSafe UI is a local wallet interface backed by the `fnzero-safe` Rust library. It supports encrypted Keystore wallets, asset and transaction views, SOL and token transfers, WSOL operations, Pump.fun and PumpSwap sells, durable nonce accounts, program deployment, and Squads v4 multisig workflows.

## Before you start

- Use the UI only on a device you trust.
- Back up every encrypted `keystore.json` before depositing funds.
- Keep the Keystore password separately. There is no password recovery.
- Start on Devnet when learning a transaction workflow.
- Confirm the network, RPC, recipient, mint, amount, and fee before signing.

The default configuration accepts saved Keystore wallets only. Direct private-key input and plaintext private-key export are disabled unless a developer explicitly enables the corresponding local debugging options.

## Start the UI

From the repository root:

```bash
make dev
```

Open one of these addresses:

- English: `http://127.0.0.1:3840/en/`
- Chinese: `http://127.0.0.1:3840/zh/`

`make dev` stops stale local development processes, starts the desktop app, starts the Next.js interface on port `3840`, and starts the local Rust API on port `3841`.

## Create a wallet

1. Open **Wallet** and select **Create New Wallet**. The same action is available under **Settings > Wallet Tools**.
2. Enter a recognizable wallet name.
3. Enter a password containing 10-20 characters.
4. Select **Create Keystore File**.
5. Record the displayed public key and download the generated Keystore.
6. Store the Keystore and password in separate secure locations before sending assets to the wallet.

The wallet is saved locally after creation. The UI stores the encrypted Keystore, not the password.

New wallets created or imported from a mnemonic use a v3 mnemonic Keystore: its primary ciphertext contains the mnemonic, allowing Solana and EVM accounts to be derived again after import. Wallets created or imported from a private key use a private-key Keystore and restore only that account. The wallet list identifies the Keystore type.

## Import a wallet

1. Select **Import Wallet**.
2. Choose a Keystore JSON file or paste the complete Keystore JSON.
3. Enter the password used to encrypt that Keystore.
4. Optionally choose a local display name.
5. Select **Import Keystore**.

An import validates the password and saves the encrypted wallet locally. Importing does not move funds or create an on-chain transaction.

Importing a mnemonic Keystore restores and verifies its Solana address and restores the default EVM-derived account from the same mnemonic. Importing a private-key Keystore restores only the account recorded in that file; a mnemonic cannot be reconstructed from a private key.

## Wallet page

Use the wallet picker to change the active wallet. New operations default to the currently selected wallet.

The wallet page provides:

- **SOL balance** and SPL Token / Token-2022 balances.
- **Refresh Assets** to reload balances and token metadata from the selected RPC.
- **Transactions** in batches of 20, up to the latest 100 transactions shown by the UI.
- **Receive** to view or copy the wallet address.
- **Send** for SOL or token transfers.
- **Trade** for Pump.fun and PumpSwap sell workflows.

If assets are missing, verify the selected network and RPC first, then refresh assets.

## Manage saved wallets

Open **Settings > Wallet Accounts** to manage local wallet records:

- Rename a wallet without changing its public key.
- Export an encrypted `keystore.json` after entering the wallet password.
- Delete the local wallet record after confirming that a backup exists.

Deleting a wallet does not delete its Solana account or move its funds. It removes only the local encrypted record. Restore access by importing a backed-up Keystore with the correct password.

Plaintext private-key export is intentionally disabled by default. An encrypted Keystore is the recommended backup format.

## Network and RPC

Open **Settings > Solana RPC** to select Mainnet, Devnet, Testnet, or a custom RPC endpoint.

- Mainnet operations use real assets and fees.
- Devnet and Testnet use their corresponding test assets.
- A custom RPC URL must use `http` or `https`.
- Existing multisig and program records keep the network on which they were created.

Always confirm the active network immediately before a transfer, trade, deployment, or multisig action.

## Send SOL

1. Select the active wallet and open **Send > SOL**.
2. Confirm the network.
3. Enter the recipient address and SOL amount.
4. Enter the current wallet's Keystore password when prompted.
5. Review the result and save the transaction signature when needed.

Keep enough SOL for transaction fees. Solana transactions are irreversible after confirmation.

## Send a token

1. Open **Send > Token** or select a token from the asset list.
2. Enter the recipient address and Token Mint address.
3. Wait for the UI to load mint decimals from RPC.
4. Enter the human-readable token amount and confirm the network.
5. Enter the wallet password and submit.

Verify the mint address, not only the token name or symbol. Different tokens can use the same display name.

## WSOL operations

Open **Trading Tools > WSOL** to:

- Create the wallet's WSOL associated token account.
- Wrap SOL into WSOL.
- Unwrap WSOL back into SOL.
- Close an empty WSOL account.

Confirm balances after each operation. Closing a non-empty token account is not a substitute for unwrapping its WSOL balance first.

## Pump.fun and PumpSwap sells

1. Select **Trade** from a token or open the Pump trading workspace.
2. Confirm the Token Mint and current wallet balance.
3. Enter an amount or use a balance-percentage shortcut.
4. Review the slippage setting and selected network.
5. Enter the wallet password and submit the sell.

Pump.fun tokens may be routed to PumpSwap when the token has migrated. Price movement, slippage, priority fees, and RPC conditions can change the final result. Test with a small amount first.

## Durable nonce accounts

Open the nonce workspace to create one or more durable nonce accounts for the active wallet. The UI displays the created nonce addresses and transaction signatures and stores the addresses locally for the wallet and network.

Creating nonce accounts costs rent and transaction fees. Back up any external signing workflow separately; the local nonce list is not a replacement for a Keystore backup.

## Programs and Squads multisig

The advanced workspaces support:

- Querying and deploying Solana programs.
- Creating Squads v4 multisigs.
- Creating SOL and token transfer proposals.
- Preparing program upgrade buffers and upgrade proposals.
- Approving, rejecting, and executing proposals.
- Changing program or buffer authority through a multisig workflow.

These operations can permanently affect programs or treasury assets. Confirm the program ID, multisig address, vault, members, threshold, proposal index, network, and upgrade authority before signing. Use a test environment first.

## Local data and security

The default wallet database is:

```text
apps/desktop/data/fnzero-safe.sqlite3
```

It contains encrypted wallet records and local metadata and is ignored by Git. Passwords are not persisted by the frontend. Sensitive request bodies are encrypted between the local UI or Tauri bridge and the local Rust API.

Security boundaries to remember:

- The database is not a substitute for an exported Keystore backup.
- Anyone with a Keystore and its password can access the wallet.
- Anyone with a plaintext private key can spend all wallet assets.
- Do not commit `apps/desktop/data/`, Keystores, passwords, environment files, or exported private keys.
- The API binds to `127.0.0.1` by default. Do not expose it to an untrusted network.

## Troubleshooting

### The page opens but wallet actions fail

Start the full stack with `make dev`. Check the API at `http://127.0.0.1:3841/api/health`.

### The wallet or assets are missing

Confirm the active wallet, network, and RPC. Select **Refresh Assets**. If the local database was moved or deleted, import the backed-up Keystore again.

### The password is rejected

Use the password that encrypted this specific Keystore. Passwords are case-sensitive and cannot be recovered by the application.

### A transaction fails

Check the network, RPC health, wallet balance, fee balance, recipient or mint address, and any slippage setting. Retrying can create another transaction, so check the first signature before submitting again.

### Ports 3840 or 3841 are already in use

Run `make dev` again. It stops stale local development processes before starting the app.
