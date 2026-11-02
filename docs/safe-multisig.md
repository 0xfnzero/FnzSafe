# Safe EVM multisig (desktop)

The desktop sidebar’s **Safe EVM Multisig / Safe EVM 多签** page supports creating Safe 1.4.1 accounts, loading existing accounts, creating transaction proposals, collecting EOA owner signatures, and executing threshold-approved transactions. The mobile and extension interfaces are unchanged.

## Desktop navigation

The sidebar has a dedicated Safe EVM Multisig entry. Its landing view contains only saved Safe cards and entry actions. Each Safe opens an account summary and its own transaction list; selecting a transaction opens a separate detail view for signing, execution and export. Creating a Safe, adding an existing Safe, composing a transaction, and importing signatures each have a separate form view. Breadcrumbs and Back preserve the account/transaction hierarchy, including returning from signature import.

Native transfers hide calldata. Contract calls default to ABI-generated typed forms, with raw calldata available in advanced mode, while nonce overrides live under advanced settings. Transfer drafts are isolated by chain and Safe while the workspace is mounted. Network changes return to the account list. Input errors and disabled-action reasons are visible before submission. Signing and execution use a modal dialog with cancellation focused by default and Escape support. Safe creation uses a three-step wizard: basics, signers/threshold, and a full review page with deployment fee estimation and an explicit final create action.

Submitted receipts are checked every three seconds for up to twenty attempts while their view is active. These are read-only checks; signing and broadcasting are never automatically retried. Confirmation refreshes the account nonce so the next queued proposal can become executable. Manual refresh remains available after timeout or a network error. Reloading restores public records and broadcast hashes; opening a pending record resumes receipt checks.

The creation wizard follows Safe’s step-by-step interaction pattern, with a live account summary beside the form. Each signer has an optional local name, a saved-wallet selector and an editable address. Duplicate or invalid addresses prevent proceeding. Removing a signer clamps the threshold to the remaining signer count, with a minimum of two. Back preserves draft values; returning from review discards the old fee approval, and changing the configuration requires a new estimate. Signer names stay in local account metadata and are never included in proposal exports or onchain calls. Deployment currently pays gas immediately on one selected network; deferred activation and deployment to several networks in one operation are not implemented.

## Using the desktop page

1. Choose an EVM network and an unlocked saved EVM signer wallet. BNB Chain (56), BNB testnet (97), Ethereum (1), Sepolia (11155111), and other configured EVM networks use the same flow. Each network must have the supported canonical deployment; the backend checks chain ID and exact deployed code before use. Networks with different deployment bytecode, including zkSync-specific deployments, are rejected rather than silently treated as compatible.
2. Create a new Safe with 2–50 distinct EOA owners and a threshold of at least two. Review the predicted address, owners, threshold and execution gas fee cap, then confirm. The creator pays gas; creation does not transfer assets into the Safe. Check the receipt to confirm deployment. Alternatively load an existing Safe 1.4.1 address.
3. The account list is scoped to the network and selected wallet’s recorded creator/owner associations. “Show all saved Safes” includes other locally saved accounts. Loading an account refreshes owners, threshold, nonce and balance. Each Safe has its own list of proposals, signature counts, broadcast hashes and receipt status.
4. Choose native transfer and enter the recipient and native amount; calldata is set to `0x`. For ERC-20 transfers or contract calls, supply the target contract and import its ABI to select a method and fill typed arguments, or use advanced raw calldata; native value is usually zero. This version supports CALL with zero Safe gas/refund fields, not delegatecall, batching, contract-owner signatures, or arbitrary imported Safe Transaction Service formats. Standard Safe Transaction Builder 1.0 files are supported by the transaction import screen. Inspect calldata independently when its meaning is not known. New proposals default to the earliest nonce at or after the current onchain nonce not reserved by a local proposal; the nonce field can be overridden. Future-nonce proposals may be signed and listed, but only the current onchain nonce can execute. Coordinate nonce allocation across installations.
5. Review and sign using an unlocked owner wallet. Export the proposal JSON. Other owners import that file, review/sign, then return their updated JSON. Import each file to merge signatures. The backend recomputes the EIP-712 hash, compares it to the real Safe’s `getTransactionHash`, recovers signers, rejects duplicate/non-owner signatures and checks the current Safe nonce. Imports must match the selected network.
6. At threshold, preview execution, approve the gas fee cap and execute. The gas-paying EOA need not be an owner. Execution is simulated before sending. A fee increase above the approved execution gas cap requires a new preview; rollup data fees are outside this cap. Check the receipt: only the matching Safe `ExecutionSuccess` event confirms execution. Reverts and `ExecutionFailure` are failures; broadcasting alone is never success.

## Import a Safe transaction file

Choose **Import Safe transaction**, select or paste a standard Safe Transaction Builder
1.0 JSON file, then choose **Read and review file**. Confirm the network, Safe address,
target, native value and calldata before creating an unsigned proposal. The selected
network must match the file. When the file does not name a Safe, enter the Safe address;
a file-bound address cannot be substituted. Values remain integer wei strings. Encoded
calldata is authoritative; ABI-only exports are encoded from their method and inputs.

The application obtains the onchain Safe nonce and reserves an available local nonce,
then asks the existing backend to prepare and verify the Safe transaction hash. Importing
does not sign or broadcast. Continue with owner signatures and execution in the normal
proposal screen. X404 scheduling and delayed execution files are imported separately.

A file with multiple transactions displays a transaction selector: each selected entry
is imported as an independent CALL proposal, not an atomic batch. Delegatecall and custom
Safe gas/refund fields are rejected. Complete FnzSafe proposal exports remain accepted
by the same screen for signature exchange and merging.

## Persistence and scope

Accounts and proposals (including collected signatures and broadcast hashes) live in desktop webview local storage, under `fnzsafe.safe-multisig.v1`. Private keys and passwords are never stored in these records or exported. Keys stay in the existing Rust wallet session and are loaded only after validation and explicit approval. API calls use the existing local API authentication/encrypted transport.

There is no hosted relay or account/transaction indexer. Lists contain locally created/loaded/imported records, not automatically discovered historical transactions. Back up proposal exports; on another installation, load Safe addresses and import the files. Sharing a threshold-signed proposal gives its recipient the ability to execute that exact transaction. Competing proposals with the same nonce can coexist, but after one executes the others become stale and cannot execute. Owner associations and signature counts reflect the latest successful validation, not continuous background indexing.

Created Safes use the unmodified Safe 1.4.1 singleton, no setup delegatecall, no modules, no fallback handler and no setup payment. Existing accounts must use the exact SafeProxy runtime and Safe or SafeL2 1.4.1 singleton runtime. This is not a production deployment of an X404 governance configuration; time locks are configured separately.

## Validation

Normal checks:

```sh
cargo test -p fnzero-safe-evm-services --lib
cargo check -p fnzero-safe-desktop-api
cd apps/desktop
npm run test:unit
npx tsc --noEmit
npx eslint src/components/SafeMultisigPanel.tsx src/components/SafeCreateWizard.tsx src/lib/safeMultisig.ts
node scripts/check-sensitive-inputs.cjs
```

On a macOS host whose default OpenSSL is incompatible with curl-sys, set `OPENSSL_DIR` to the local OpenSSL 3 prefix for the desktop API check. This is a build environment setting, not a source change.

Real-contract integration test (no public-network transaction or real wallet required):

```sh
safe_test_dir=$(mktemp -d)
npm pack @safe-global/safe-contracts@1.4.1 --pack-destination "$safe_test_dir"
tar -xzf "$safe_test_dir/safe-global-safe-contracts-1.4.1.tgz" -C "$safe_test_dir"
SAFE_ARTIFACTS_DIR="$safe_test_dir/package/build/artifacts/contracts" \
ANVIL_BIN=/absolute/path/to/anvil \
cargo test -p fnzero-safe-evm-services safe::tests -- --include-ignored
```

The test starts an isolated loopback Anvil, installs the official singleton and factory runtimes at canonical addresses, and creates a real SafeProxy through the factory. It verifies a 2/2 lifecycle, recipient balances, contract calldata, owner/non-owner signing, insufficient signatures, duplicate signatures, tampering, replay rejection, reverting targets and unsupported deployments. Pinned runtime hashes are from the published `@safe-global/safe-contracts@1.4.1` artifacts and agree with [Safe’s deployment registry](https://github.com/safe-global/safe-deployments/tree/main/src/assets/v1.4.1).

## Repeatable UI verification

`apps/desktop/test-fixtures/SafeMultisigHarness.tsx` supplies synthetic accounts and proposals through an injected service. It never calls an RPC, uses wallet keys, or broadcasts transactions. It is not exposed by a production route. For manual verification, temporarily create `apps/desktop/src/app/[locale]/safe-verification/page.tsx` containing:

```tsx
export { default } from "../../../../test-fixtures/SafeMultisigHarness";
```

Run Next on a dedicated unused origin (`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:39999 npx next dev -H 127.0.0.1 -p 3865` from `apps/desktop`) and open `/zh/safe-verification/`. Do not use a real wallet application's origin: the fixture seeds local storage on its own origin. Use Reset fixture for a fresh scenario; the simulated chain is held in memory. Remove the temporary route before building and stop that test server.

Verified through the UI at desktop size: separate account/form/detail views; duplicate-owner validation; cancellation and Escape; 2/2 signing and non-owner execution; automatic receipt confirmation and nonce advancement; independent drafts for two Safes; invalid JSON and wrong-network imports; successful import without duplicate proposals; Back navigation through import, transaction and account; request error recovery; mainnet/testnet list isolation; and newly created accounts entering their own transaction list. These simulated UI checks complement the real-contract integration test above; they do not replace public-network or packaged Tauri testing.

Creation wizard regression checks: required account name; saved/manual signer selection; per-row duplicate validation; add/remove and threshold clamping; Back preserving drafts; estimate failure and retry; review values and predicted-address warning; simulated submission/receipt; and local signer-name persistence. Also visually checked inside the running FnzSafe Dev desktop shell with the real BSC testnet wallet selected, without broadcasting a creation transaction.


### ABI 合约调用表单（桌面端）

在 Safe 交易列表进入「创建交易提案」，选择「合约调用 / ERC-20 转账」。默认使用 ABI 表单：

1. 填写目标合约地址，选择 `.json` / `.abi` 文件（最大 2 MB），或粘贴 ABI JSON。支持原始 ABI 数组及 Hardhat / Foundry 等编译产物；也可选用当前网络已保存的 ABI 项目。
2. 选择完整方法签名。同名重载方法分别列出，view / pure 查询方法不列入多签提案。
3. 按类型填写参数。地址、整数、布尔值、字符串、bytes、定长/动态数组及 tuple 均有相应控件；数组支持增删元素，tuple 按成员展开。整数使用原始单位和字符串精度，不自动推断 token decimals。bytes 必须是完整的 0x 十六进制字节。表单限制每个数组最多 64 项、类型嵌套最多 8 层、单参数类型展开最多 256 个节点；更复杂类型可使用高级 calldata 模式。
4. payable 方法可附带原生币；nonpayable 方法固定为零。编码成功后可展开只读 calldata，创建提案，再沿用原有多签签名和执行流程。

ABI 及参数不会提交给第三方解析服务。切换 ABI 或方法会清除旧方法参数；返回页面及失败重试保留当前 Safe / 网络的内存草稿。原始 calldata 输入放在「高级」模式。

提案详情、签名及执行确认均显示本地 ABI 调用摘要，显示前重新编码并与提案 calldata 逐字节核对。摘要只证明参数编码一致，不证明 ABI 与目标合约源码一致。摘要保存在本地提案记录中；公开提案 JSON 格式保持不变，不携带 ABI 元数据，因此在另一设备导入后若无本地匹配摘要，仍展示原始 calldata。

本次验证包括 ABI 文件选择、同名重载、错误参数拦截、数组 / tuple 表单、返回保留草稿、请求失败恢复、payable 金额及两签后执行的隔离模拟 UI 流程；未广播真实网络交易。


### Parameter correctness regression (2026-11-02)

Fixed and covered by regression tests:

- Malformed function inputs or nested tuple members previously could be silently omitted, changing the encoded method signature. ABI parsing now rejects those definitions, invalid mutability values and excessive nesting.
- Mixed-case addresses inside contract arguments now undergo EIP-55 validation, including nested arrays/tuples. Creation owners and recipient forms use the same validation rule as the backend.
- Unpaired Unicode surrogates are rejected instead of silently converting contract strings to replacement characters. Noncanonical integer type widths and oversized UTF-8 ABI files are rejected.
- Long signing/execution dialogs open at the transaction details instead of scrolling to the bottom when Cancel receives focus.
- Proposal creation, import, review, refresh and signing responses must preserve the requested chain, Safe, target, value, calldata, nonce and (when already known) transaction hash. A substituted response cannot become a reviewed/signed local record.

Independent encoding verification runs 1,273 comparisons against ethers v6: all Solidity integer widths at signed/unsigned boundaries; bytes1–bytes32; dynamic byte/string word boundaries; UTF-8 and NUL strings; and 1,000 deterministic nested tuple/array combinations. Separate rejection tests cover out-of-range values. No new application dependency is required; point the optional command to an existing ethers v6 installation:

```sh
cd apps/desktop
ABI_REFERENCE_MODULE=/absolute/path/to/node_modules/ethers npm run test:safe-abi-reference
```

The Solidity receiver fixture independently decodes the actual frontend-generated calldata. Generate it with an existing ethers v6 and solc 0.8.24+ installation, then run the real Safe integration test from the repository root:

```sh
ABI_REFERENCE_MODULE=/absolute/path/to/node_modules/ethers \
SOLC_MODULE=/absolute/path/to/node_modules/solc \
node --experimental-strip-types apps/desktop/test-fixtures/safe-abi/generate.mjs /tmp/fnzsafe-safe-abi-fixture.json

SAFE_ABI_FIXTURE=/tmp/fnzsafe-safe-abi-fixture.json \
SAFE_ARTIFACTS_DIR=/absolute/path/to/safe-contracts/build/artifacts/contracts \
ANVIL_BIN=/absolute/path/to/anvil \
cargo test -p fnzero-safe-evm-services --lib -- --include-ignored --nocapture
```

Verified 12 fresh local-chain Safe 2/2 executions with nested tuples, signed limits, maximum uint256, arrays, UTF-8, empty data and payable values. After each call, the receiver's decoded parameter hash matches ethers' independent expected hash, `msg.sender` is the Safe, `msg.value` matches the proposal, the call counter increments once and the Safe nonce advances once. Nonpayable calls with value, truncated arguments and tampered signed transaction fields fail without loading keys or consuming a Safe nonce. All 63 Rust tests pass, including the normally ignored real-contract integration test.

UI regression on a separate synthetic origin verified malformed tuple-file rejection, wrong checksum rejection, maximum uint256 and false preservation through the signing dialog, mismatched backend calldata rejection, successful retry without losing arguments, and separate drafts for different Safes and for the same address on different networks. No public-network transaction or user key was used. These checks establish encoding/flow correctness for the exercised cases; the user must still supply the correct target ABI, address, token units and business arguments. Execution simulation cannot predict later contract state changes.


Safe address copying is available in saved-account cards, the pending-creation view, the account detail, the proposal form, transaction details and creation review. Each control copies the full address, reports success or failure, and offers selectable text for manual copying. Clipboard fallback remains inside the active modal. Copying from a list card does not open the account. Verified in the native FnzSafe Dev shell by copying the saved BSC testnet Safe and pasting into the address field to check an exact match.
