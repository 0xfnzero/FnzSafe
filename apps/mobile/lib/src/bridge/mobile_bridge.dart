import 'mobile_bridge_backend.dart';
import 'mobile_bridge_generated.dart';
import 'mobile_models.dart';

class MobileBridge {
  MobileBridge({MobileBridgeBackend? backend})
      : _backend = backend ?? _defaultBackend();

  final MobileBridgeBackend _backend;

  Future<String> health() => _backend.health();

  Future<MobileCapabilities> capabilities() => _backend.capabilities();

  Future<WalletKeystore> createWallet({
    required String name,
    required String password,
  }) {
    return _backend.createWallet(name: name, password: password);
  }

  Future<WalletKeystore> importKeystore({
    required String name,
    required String keystoreJson,
    required String password,
  }) {
    return _backend.importKeystore(
      name: name,
      keystoreJson: keystoreJson,
      password: password,
    );
  }

  Future<WalletKeystore> importPrivateKey({
    required String name,
    required String privateKeyBase58,
    required String password,
  }) {
    return _backend.importPrivateKey(
      name: name,
      privateKeyBase58: privateKeyBase58,
      password: password,
    );
  }

  Future<WalletKeystore> importMnemonic({
    required String name,
    required String mnemonic,
    required String password,
    String? derivationPath,
  }) {
    return _backend.importMnemonic(
      name: name,
      mnemonic: mnemonic,
      password: password,
      derivationPath: derivationPath,
    );
  }

  Future<WalletSummary> unlockWallet({
    required String keystoreJson,
    required String password,
  }) {
    return _backend.unlockWallet(
        keystoreJson: keystoreJson, password: password);
  }

  Future<ExportPrivateKeyResponse> exportPrivateKey({
    required String keystoreJson,
    required String password,
  }) {
    return _backend.exportPrivateKey(
        keystoreJson: keystoreJson, password: password);
  }

  Future<List<EvmChainConfig>> evmChains() => _backend.evmChains();

  Future<WalletKeystore> createEvmWallet({
    required String name,
    required String password,
  }) {
    return _backend.createEvmWallet(name: name, password: password);
  }

  Future<WalletKeystore> importEvmPrivateKey({
    required String name,
    required String privateKeyHex,
    required String password,
  }) {
    return _backend.importEvmPrivateKey(
      name: name,
      privateKeyHex: privateKeyHex,
      password: password,
    );
  }

  Future<WalletKeystore> importEvmMnemonic({
    required String name,
    required String mnemonic,
    required String password,
    String? derivationPath,
  }) {
    return _backend.importEvmMnemonic(
      name: name,
      mnemonic: mnemonic,
      password: password,
      derivationPath: derivationPath,
    );
  }

  Future<WalletKeystore> importEvmKeystore({
    required String name,
    required String keystoreJson,
    required String password,
  }) {
    return _backend.importEvmKeystore(
      name: name,
      keystoreJson: keystoreJson,
      password: password,
    );
  }

  Future<WalletSummary> unlockEvmWallet({
    required String keystoreJson,
    required String password,
  }) {
    return _backend.unlockEvmWallet(
        keystoreJson: keystoreJson, password: password);
  }

  Future<EvmExportPrivateKeyResponse> exportEvmPrivateKey({
    required String keystoreJson,
    required String password,
  }) {
    return _backend.exportEvmPrivateKey(
        keystoreJson: keystoreJson, password: password);
  }

  Future<AssetSnapshot> loadAssets({
    required AppNetwork network,
    required String walletPublicKey,
  }) {
    return _backend.loadAssets(
        network: network, walletPublicKey: walletPublicKey);
  }

  Future<EvmAssetSnapshot> loadEvmAssets({
    required EvmChainConfig chain,
    required String walletAddress,
    List<String> tokenContracts = const [],
  }) {
    return _backend.loadEvmAssets(
      chain: chain,
      walletAddress: walletAddress,
      tokenContracts: tokenContracts,
    );
  }

  Future<SigningPreview> previewPayment({
    required AppNetwork network,
    required String walletPublicKey,
    required String recipient,
    required String amount,
    String? mint,
    String? memo,
  }) {
    return _backend.previewPayment(
      network: network,
      walletPublicKey: walletPublicKey,
      recipient: recipient,
      amount: amount,
      mint: mint,
      memo: memo,
    );
  }

  Future<TransactionSubmitResult> confirmPayment({
    required SigningPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String recipient,
    required int amountBaseUnits,
    PaymentOperation operation = PaymentOperation.solTransfer,
    String? mint,
  }) {
    return _backend.confirmPayment(
      preview: preview,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      recipient: recipient,
      amountBaseUnits: amountBaseUnits,
      operation: operation,
      mint: mint,
    );
  }

  Future<EvmPaymentPreview> previewEvmPayment({
    required EvmChainConfig chain,
    required String walletAddress,
    required String recipient,
    required String amountWeiOrUnits,
    String? tokenContract,
    String? memo,
  }) {
    return _backend.previewEvmPayment(
      chain: chain,
      walletAddress: walletAddress,
      recipient: recipient,
      amountWeiOrUnits: amountWeiOrUnits,
      tokenContract: tokenContract,
      memo: memo,
    );
  }

  Future<EvmTransactionSubmitResult> confirmEvmPayment({
    required EvmPaymentPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
  }) {
    return _backend.confirmEvmPayment(
      preview: preview,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
    );
  }

  Future<EvmTransactionStatus> evmTransactionStatus({
    required EvmChainConfig chain,
    required String transactionHash,
  }) {
    return _backend.evmTransactionStatus(
      chain: chain,
      transactionHash: transactionHash,
    );
  }

  Future<TotpSetup> setupTotp(String account) => _backend.setupTotp(account);

  Future<bool> verifyTotp({
    required String secret,
    required String code,
  }) {
    return _backend.verifyTotp(secret: secret, code: code);
  }

  Future<BiometricPolicy> biometricPolicy() => _backend.biometricPolicy();

  Future<SigningPreview> previewPumpSell({
    required AppNetwork network,
    required String walletPublicKey,
    required String mint,
  }) {
    return _backend.previewPumpSell(
      network: network,
      walletPublicKey: walletPublicKey,
      mint: mint,
    );
  }

  Future<SigningPreview> previewDappSign({
    required AppNetwork network,
    required String walletPublicKey,
    required String appName,
    String appUrl = 'https://example.invalid',
    String method = 'signTransaction',
    String payloadBase64 = 'AA==',
  }) {
    return _backend.previewDappSign(
      network: network,
      walletPublicKey: walletPublicKey,
      appName: appName,
      appUrl: appUrl,
      method: method,
      payloadBase64: payloadBase64,
    );
  }

  Future<DappSignSubmitResult> confirmDappSign({
    required SigningPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String method,
    required String payloadBase64,
    String? transactionFormat,
  }) {
    return _backend.confirmDappSign(
      preview: preview,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      method: method,
      payloadBase64: payloadBase64,
      transactionFormat: transactionFormat,
    );
  }

  Future<EvmDappSignPreview> previewEvmDappSign({
    required EvmChainConfig chain,
    required String walletAddress,
    required String appName,
    required String appUrl,
    required String method,
    required String payloadJson,
  }) {
    return _backend.previewEvmDappSign(
      chain: chain,
      walletAddress: walletAddress,
      appName: appName,
      appUrl: appUrl,
      method: method,
      payloadJson: payloadJson,
    );
  }

  Future<EvmDappSignSubmitResult> confirmEvmDappSign({
    required EvmDappSignPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String method,
    required String payloadJson,
  }) {
    return _backend.confirmEvmDappSign(
      preview: preview,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      method: method,
      payloadJson: payloadJson,
    );
  }

  Future<SigningPreview> previewSquadsAction({
    required AppNetwork network,
    required String walletPublicKey,
    required String multisig,
    required String action,
  }) {
    return _backend.previewSquadsAction(
      network: network,
      walletPublicKey: walletPublicKey,
      multisig: multisig,
      action: action,
    );
  }

  Future<SquadsInfo> loadSquadsInfo({
    required AppNetwork network,
    required String multisig,
    String? proposal,
  }) {
    return _backend.loadSquadsInfo(
      network: network,
      multisig: multisig,
      proposal: proposal,
    );
  }

  Future<SquadsProposals> loadSquadsProposals({
    required AppNetwork network,
    required String multisig,
    int? limit,
  }) {
    return _backend.loadSquadsProposals(
      network: network,
      multisig: multisig,
      limit: limit,
    );
  }

  Future<SquadsCreateResult> confirmSquadsCreate({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required List<String> members,
    required int threshold,
    int? timeLock,
    String? memo,
  }) {
    return _backend.confirmSquadsCreate(
      network: network,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      members: members,
      threshold: threshold,
      timeLock: timeLock,
      memo: memo,
    );
  }

  Future<SquadsProposalCreateResult> confirmSquadsTransferProposal({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required SquadsTransferKind kind,
    String? recipient,
    String? destinationTokenAccount,
    String? sourceTokenAccount,
    String? mint,
    required int amountBaseUnits,
    int? decimals,
    String? memo,
  }) {
    return _backend.confirmSquadsTransferProposal(
      network: network,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      multisig: multisig,
      kind: kind,
      recipient: recipient,
      destinationTokenAccount: destinationTokenAccount,
      sourceTokenAccount: sourceTokenAccount,
      mint: mint,
      amountBaseUnits: amountBaseUnits,
      decimals: decimals,
      memo: memo,
    );
  }

  Future<TransactionSubmitResult> confirmSquadsApprove({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    String? memo,
  }) {
    return _backend.confirmSquadsApprove(
      network: network,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      multisig: multisig,
      proposal: proposal,
      memo: memo,
    );
  }

  Future<TransactionSubmitResult> confirmSquadsReject({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    String? memo,
  }) {
    return _backend.confirmSquadsReject(
      network: network,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      multisig: multisig,
      proposal: proposal,
      memo: memo,
    );
  }

  Future<TransactionSubmitResult> confirmSquadsExecute({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    required int transactionIndex,
  }) {
    return _backend.confirmSquadsExecute(
      network: network,
      approved: approved,
      keystoreJson: keystoreJson,
      password: password,
      multisig: multisig,
      proposal: proposal,
      transactionIndex: transactionIndex,
    );
  }
}

MobileBridgeBackend _defaultBackend() {
  const useDevelopmentFallback =
      bool.fromEnvironment('FNZERO_MOBILE_DEV_BRIDGE');
  if (useDevelopmentFallback) return const DevelopmentMobileBridgeBackend();
  return GeneratedMobileBridgeBackend();
}

class DevelopmentMobileBridgeBackend implements MobileBridgeBackend {
  const DevelopmentMobileBridgeBackend();

  @override
  Future<String> health() async =>
      'fnzero-safe-mobile-bridge:development-fallback';

  @override
  Future<MobileCapabilities> capabilities() async {
    return const MobileCapabilities(
      enabled: [
        'wallet_management',
        'assets',
        'payments',
        'two_factor',
        'pump_trading',
        'dapp_signing',
        'squads_multisig',
        'evm_chains',
        'evm_wallets',
        'evm_assets',
        'evm_payments',
        'evm_dapp_signing',
      ],
      excluded: [
        'program_deploy',
        'program_upgrade',
        'program_source_build',
        'program_invoke',
      ],
    );
  }

  @override
  Future<WalletKeystore> createWallet({
    required String name,
    required String password,
  }) async {
    final suffix = DateTime.now().millisecondsSinceEpoch.toRadixString(16);
    return WalletKeystore(
      wallet: WalletSummary(
        id: 'wallet-$suffix',
        name: name.trim().isEmpty ? 'Mobile Wallet' : name.trim(),
        publicKey: 'FnzMobile$suffix',
      ),
      keystoreJson: '{"version":2,"mobile_stub":true}',
    );
  }

  @override
  Future<WalletKeystore> importKeystore({
    required String name,
    required String keystoreJson,
    required String password,
  }) async {
    final wallet =
        await unlockWallet(keystoreJson: keystoreJson, password: password);
    return WalletKeystore(
      wallet: WalletSummary(
        id: wallet.id,
        name: name.trim().isEmpty ? wallet.name : name.trim(),
        publicKey: wallet.publicKey,
      ),
      keystoreJson: keystoreJson,
    );
  }

  @override
  Future<WalletKeystore> importPrivateKey({
    required String name,
    required String privateKeyBase58,
    required String password,
  }) async {
    if (privateKeyBase58.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Private key and password are required');
    }
    final suffix = DateTime.now().millisecondsSinceEpoch.toRadixString(16);
    return WalletKeystore(
      wallet: WalletSummary(
        id: 'wallet-imported-$suffix',
        name: name.trim().isEmpty ? 'Imported Wallet' : name.trim(),
        publicKey: 'FnzImported$suffix',
      ),
      keystoreJson: '{"version":2,"mobile_stub":true,"source":"private_key"}',
    );
  }

  @override
  Future<WalletKeystore> importMnemonic({
    required String name,
    required String mnemonic,
    required String password,
    String? derivationPath,
  }) async {
    if (mnemonic.trim().split(RegExp(r'\s+')).length < 12 || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Mnemonic and password are required');
    }
    final suffix = DateTime.now().millisecondsSinceEpoch.toRadixString(16);
    return WalletKeystore(
      wallet: WalletSummary(
        id: 'wallet-mnemonic-$suffix',
        name: name.trim().isEmpty ? 'Mnemonic Wallet' : name.trim(),
        publicKey: 'FnzMnemonic$suffix',
      ),
      keystoreJson: '{"version":2,"mobile_stub":true,"source":"mnemonic"}',
    );
  }

  @override
  Future<WalletSummary> unlockWallet({
    required String keystoreJson,
    required String password,
  }) async {
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw StateError('Keystore and password are required');
    }
    return const WalletSummary(
      id: 'wallet-unlocked',
      name: 'Unlocked Wallet',
      publicKey: 'FnzUnlocked111111111111111111111111111111',
    );
  }

  @override
  Future<ExportPrivateKeyResponse> exportPrivateKey({
    required String keystoreJson,
    required String password,
  }) async {
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
    return const ExportPrivateKeyResponse(
      publicKey: 'FnzUnlocked111111111111111111111111111111',
      privateKeyBase58: 'development-private-key-placeholder',
    );
  }

  @override
  Future<List<EvmChainConfig>> evmChains() async => _developmentEvmChains;

  @override
  Future<WalletKeystore> createEvmWallet({
    required String name,
    required String password,
  }) async {
    if (password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Password is required');
    }
    final suffix = DateTime.now().millisecondsSinceEpoch.toRadixString(16);
    return WalletKeystore(
      wallet: WalletSummary(
        id: 'evm-development-$suffix',
        name: name.trim().isEmpty ? 'EVM Wallet' : name.trim(),
        publicKey: '0x${suffix.padLeft(40, '0').substring(0, 40)}',
        family: WalletFamily.evm,
        derivationPath: "m/44'/60'/0'/0/0",
      ),
      keystoreJson: '{"version":1,"wallet_family":"evm","mobile_stub":true}',
    );
  }

  @override
  Future<WalletKeystore> importEvmPrivateKey({
    required String name,
    required String privateKeyHex,
    required String password,
  }) async {
    if (privateKeyHex.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Private key and password are required');
    }
    return createEvmWallet(name: name, password: password);
  }

  @override
  Future<WalletKeystore> importEvmMnemonic({
    required String name,
    required String mnemonic,
    required String password,
    String? derivationPath,
  }) async {
    if (mnemonic.trim().split(RegExp(r'\s+')).length < 12 || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Mnemonic and password are required');
    }
    final created = await createEvmWallet(name: name, password: password);
    return WalletKeystore(
      wallet: WalletSummary(
        id: created.wallet.id,
        name: created.wallet.name,
        publicKey: created.wallet.publicKey,
        family: WalletFamily.evm,
        derivationPath: derivationPath ?? "m/44'/60'/0'/0/0",
      ),
      keystoreJson: created.keystoreJson,
    );
  }

  @override
  Future<WalletKeystore> importEvmKeystore({
    required String name,
    required String keystoreJson,
    required String password,
  }) async {
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
    return createEvmWallet(name: name, password: password);
  }

  @override
  Future<WalletSummary> unlockEvmWallet({
    required String keystoreJson,
    required String password,
  }) async {
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
    return const WalletSummary(
      id: 'evm-development-unlocked',
      name: 'Unlocked EVM Wallet',
      publicKey: '0x0000000000000000000000000000000000000001',
      family: WalletFamily.evm,
      derivationPath: "m/44'/60'/0'/0/0",
    );
  }

  @override
  Future<EvmExportPrivateKeyResponse> exportEvmPrivateKey({
    required String keystoreJson,
    required String password,
  }) async {
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
    return const EvmExportPrivateKeyResponse(
      address: '0x0000000000000000000000000000000000000001',
      privateKeyHex:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
    );
  }

  @override
  Future<AssetSnapshot> loadAssets({
    required AppNetwork network,
    required String walletPublicKey,
  }) async {
    return AssetSnapshot(
      network: network,
      walletPublicKey: walletPublicKey,
      solBalanceLamports: 0,
      tokens: const [],
      recentTransactions: const [],
      refreshedAtMs: 0,
    );
  }

  @override
  Future<EvmAssetSnapshot> loadEvmAssets({
    required EvmChainConfig chain,
    required String walletAddress,
    List<String> tokenContracts = const [],
  }) async {
    return EvmAssetSnapshot(
      chain: chain,
      walletAddress: walletAddress,
      nativeBalanceWei: '0',
      tokens: [
        for (final contract in tokenContracts)
          EvmTokenAsset(
            contractAddress: contract,
            symbol: 'ERC20',
            name: 'Development Token',
            balance: '0',
            decimals: 18,
          ),
      ],
      recentTransactions: const [],
      historyStatus: 'unsupported',
      historyMessage: 'Development bridge does not query explorer history.',
      refreshedAtMs: 0,
    );
  }

  @override
  Future<SigningPreview> previewPayment({
    required AppNetwork network,
    required String walletPublicKey,
    required String recipient,
    required String amount,
    String? mint,
    String? memo,
  }) async {
    return SigningPreview(
      id: 'payment-${DateTime.now().millisecondsSinceEpoch}',
      title: mint == null || mint.isEmpty ? 'SOL Payment' : 'SPL Token Payment',
      network: network,
      walletPublicKey: walletPublicKey,
      summary:
          'Send $amount to $recipient${memo == null || memo.isEmpty ? '' : ' memo $memo'}',
      warnings: const ['Review the recipient and network before signing.'],
    );
  }

  @override
  Future<TransactionSubmitResult> confirmPayment({
    required SigningPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String recipient,
    required int amountBaseUnits,
    required PaymentOperation operation,
    String? mint,
  }) async {
    if (!approved) {
      throw const MobileBridgeException(
          'user_rejected', 'User rejected the signing request');
    }
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
    return TransactionSubmitResult(
      signature:
          'development-signature-${DateTime.now().millisecondsSinceEpoch}',
      network: preview.network,
      submittedAt: DateTime.now().toUtc().toIso8601String(),
      status: 'development_fallback',
    );
  }

  @override
  Future<EvmPaymentPreview> previewEvmPayment({
    required EvmChainConfig chain,
    required String walletAddress,
    required String recipient,
    required String amountWeiOrUnits,
    String? tokenContract,
    String? memo,
  }) async {
    return EvmPaymentPreview(
      previewId: 'evm-payment-${DateTime.now().millisecondsSinceEpoch}',
      chain: chain,
      walletAddress: walletAddress,
      recipient: recipient,
      tokenContract: tokenContract,
      amountWeiOrUnits: amountWeiOrUnits,
      gasLimit:
          tokenContract == null || tokenContract.isEmpty ? '21000' : '65000',
      gasPriceWei: '1000000000',
      maxFeePerGasWei: '2000000000',
      maxPriorityFeePerGasWei: '1000000000',
      feeModel: 'eip1559',
      nonce: '0',
      estimatedFeeWei: tokenContract == null || tokenContract.isEmpty
          ? '21000000000000'
          : '65000000000000',
      summary: 'Prepare EVM transfer on ${chain.name}',
      warnings: const [
        'Review chain id, recipient, token, and gas before signing.'
      ],
    );
  }

  @override
  Future<EvmTransactionSubmitResult> confirmEvmPayment({
    required EvmPaymentPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    return EvmTransactionSubmitResult(
      transactionHash: '0xdevelopment${DateTime.now().millisecondsSinceEpoch}',
      chain: preview.chain,
      submittedAt: DateTime.now().toUtc().toIso8601String(),
      status: 'development_fallback',
      blockNumber: null,
    );
  }

  @override
  Future<EvmTransactionStatus> evmTransactionStatus({
    required EvmChainConfig chain,
    required String transactionHash,
  }) async {
    return EvmTransactionStatus(
      transactionHash: transactionHash,
      chain: chain,
      status: 'development_fallback',
    );
  }

  @override
  Future<TotpSetup> setupTotp(String account) async {
    return TotpSetup(
      secret: 'DEVELOPMENTTOTPSECRET',
      issuer: 'FnzeroSafe',
      account: account,
    );
  }

  @override
  Future<bool> verifyTotp({
    required String secret,
    required String code,
  }) async {
    if (secret.trim().isEmpty || code.length != 6) {
      throw const MobileBridgeException('totp_invalid', 'Invalid TOTP code');
    }
    return true;
  }

  @override
  Future<BiometricPolicy> biometricPolicy() async {
    return const BiometricPolicy(
      supported: false,
      configured: false,
      reason: 'Native platform channel not configured yet',
    );
  }

  @override
  Future<SigningPreview> previewPumpSell({
    required AppNetwork network,
    required String walletPublicKey,
    required String mint,
  }) async {
    return SigningPreview(
      id: 'pump-${DateTime.now().millisecondsSinceEpoch}',
      title: 'Pump Sell',
      network: network,
      walletPublicKey: walletPublicKey,
      summary: 'Prepare Pump sell for $mint',
      warnings: const ['Confirm slippage before signing.'],
    );
  }

  @override
  Future<SigningPreview> previewDappSign({
    required AppNetwork network,
    required String walletPublicKey,
    required String appName,
    required String appUrl,
    required String method,
    required String payloadBase64,
  }) async {
    return SigningPreview(
      id: 'dapp-${DateTime.now().millisecondsSinceEpoch}',
      title: '$appName Request',
      network: network,
      walletPublicKey: walletPublicKey,
      summary: '$appName requested $method from $appUrl',
      warnings: const ['Only approve dApp requests from sites you trust.'],
    );
  }

  @override
  Future<DappSignSubmitResult> confirmDappSign({
    required SigningPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String method,
    required String payloadBase64,
    String? transactionFormat,
  }) async {
    if (!approved) {
      throw const MobileBridgeException(
          'user_rejected', 'User rejected the dApp signing request');
    }
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
    return DappSignSubmitResult(
      status: 'development_fallback',
      signature: 'development-dapp-signature',
      signatureBase64: 'ZGV2ZWxvcG1lbnQtc2lnbmF0dXJl',
      signedPayloadBase64: payloadBase64,
      signedPayloadsBase64:
          method == 'signAllTransactions' ? [payloadBase64] : const [],
    );
  }

  @override
  Future<EvmDappSignPreview> previewEvmDappSign({
    required EvmChainConfig chain,
    required String walletAddress,
    required String appName,
    required String appUrl,
    required String method,
    required String payloadJson,
  }) async {
    return EvmDappSignPreview(
      previewId: 'evm-dapp-${DateTime.now().millisecondsSinceEpoch}',
      chain: chain,
      walletAddress: walletAddress,
      appName: appName,
      appUrl: appUrl,
      method: method,
      summary: '$appName requested $method from $appUrl',
      warnings: const ['Only approve EVM dApp requests from sites you trust.'],
    );
  }

  @override
  Future<EvmDappSignSubmitResult> confirmEvmDappSign({
    required EvmDappSignPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String method,
    required String payloadJson,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    return const EvmDappSignSubmitResult(
      status: 'development_fallback',
      signature: '0xdevelopment-evm-signature',
      signedTransaction: null,
    );
  }

  @override
  Future<SigningPreview> previewSquadsAction({
    required AppNetwork network,
    required String walletPublicKey,
    required String multisig,
    required String action,
  }) async {
    return SigningPreview(
      id: 'squads-${DateTime.now().millisecondsSinceEpoch}',
      title: 'Squads Multisig Action',
      network: network,
      walletPublicKey: walletPublicKey,
      summary: '$action on multisig $multisig',
      warnings: const ['Confirm proposal state and threshold before signing.'],
    );
  }

  @override
  Future<SquadsInfo> loadSquadsInfo({
    required AppNetwork network,
    required String multisig,
    String? proposal,
  }) async {
    return SquadsInfo(
      multisig: multisig,
      vault: 'development-vault',
      createKey: 'development-create-key',
      threshold: 1,
      timeLock: 0,
      transactionIndex: 0,
      staleTransactionIndex: 0,
      members: const [
        SquadsMemberSummary(key: 'development-member', permissions: 7),
      ],
      proposal: proposal == null || proposal.isEmpty
          ? null
          : SquadsProposalSummary(
              address: proposal,
              transactionIndex: 0,
              status: 'development_fallback',
              approved: const [],
              rejected: const [],
              cancelled: const [],
            ),
      network: network,
    );
  }

  @override
  Future<SquadsProposals> loadSquadsProposals({
    required AppNetwork network,
    required String multisig,
    int? limit,
  }) async {
    return SquadsProposals(
      multisig: multisig,
      vault: 'development-vault',
      proposals: const [],
      latestTransactionIndex: 0,
      network: network,
    );
  }

  void _requireDevSigning(bool approved, String keystoreJson, String password) {
    if (!approved) {
      throw const MobileBridgeException(
          'user_rejected', 'User rejected the signing request');
    }
    if (keystoreJson.trim().isEmpty || password.isEmpty) {
      throw const MobileBridgeException(
          'invalid_input', 'Keystore and password are required');
    }
  }

  @override
  Future<SquadsCreateResult> confirmSquadsCreate({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required List<String> members,
    required int threshold,
    int? timeLock,
    String? memo,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    final suffix = DateTime.now().millisecondsSinceEpoch;
    return SquadsCreateResult(
      multisig: 'development-multisig-$suffix',
      vault: 'development-vault-$suffix',
      createKey: 'development-create-key-$suffix',
      signature: 'development-squads-create-$suffix',
      threshold: threshold,
      members: [
        for (final member in members)
          SquadsMemberSummary(key: member, permissions: 7),
      ],
      creationFeeLamports: 0,
      network: network,
      status: 'development_fallback',
    );
  }

  @override
  Future<SquadsProposalCreateResult> confirmSquadsTransferProposal({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required SquadsTransferKind kind,
    String? recipient,
    String? destinationTokenAccount,
    String? sourceTokenAccount,
    String? mint,
    required int amountBaseUnits,
    int? decimals,
    String? memo,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    final suffix = DateTime.now().millisecondsSinceEpoch;
    return SquadsProposalCreateResult(
      multisig: multisig,
      vault: 'development-vault',
      transaction: 'development-transaction-$suffix',
      proposal: 'development-proposal-$suffix',
      transactionIndex: suffix,
      signature: 'development-squads-proposal-$suffix',
      network: network,
      status: 'development_fallback',
    );
  }

  @override
  Future<TransactionSubmitResult> confirmSquadsApprove({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    String? memo,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    return TransactionSubmitResult(
      signature:
          'development-squads-approve-${DateTime.now().millisecondsSinceEpoch}',
      network: network,
      submittedAt: DateTime.now().toUtc().toIso8601String(),
      status: 'development_fallback',
    );
  }

  @override
  Future<TransactionSubmitResult> confirmSquadsReject({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    String? memo,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    return TransactionSubmitResult(
      signature:
          'development-squads-reject-${DateTime.now().millisecondsSinceEpoch}',
      network: network,
      submittedAt: DateTime.now().toUtc().toIso8601String(),
      status: 'development_fallback',
    );
  }

  @override
  Future<TransactionSubmitResult> confirmSquadsExecute({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    required int transactionIndex,
  }) async {
    _requireDevSigning(approved, keystoreJson, password);
    return TransactionSubmitResult(
      signature:
          'development-squads-execute-${DateTime.now().millisecondsSinceEpoch}',
      network: network,
      submittedAt: DateTime.now().toUtc().toIso8601String(),
      status: 'development_fallback',
    );
  }
}

const _developmentEvmChains = [
  EvmChainConfig(
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    nativeSymbol: 'ETH',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    explorerUrl: 'https://sepolia.etherscan.io',
    testnet: true,
  ),
  EvmChainConfig(
    chainId: 84532,
    name: 'Base Sepolia',
    nativeSymbol: 'ETH',
    rpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    testnet: true,
  ),
  EvmChainConfig(
    chainId: 1,
    name: 'Ethereum',
    nativeSymbol: 'ETH',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    explorerUrl: 'https://etherscan.io',
    testnet: false,
  ),
];
