import 'mobile_models.dart';

abstract interface class MobileBridgeBackend {
  Future<String> health();

  Future<MobileCapabilities> capabilities();

  Future<WalletKeystore> createWallet({
    required String name,
    required String password,
  });

  Future<WalletKeystore> importKeystore({
    required String name,
    required String keystoreJson,
    required String password,
  });

  Future<WalletKeystore> importPrivateKey({
    required String name,
    required String privateKeyBase58,
    required String password,
  });

  Future<WalletKeystore> importMnemonic({
    required String name,
    required String mnemonic,
    required String password,
    String? derivationPath,
  });

  Future<WalletSummary> unlockWallet({
    required String keystoreJson,
    required String password,
  });

  Future<ExportPrivateKeyResponse> exportPrivateKey({
    required String keystoreJson,
    required String password,
  });

  Future<List<EvmChainConfig>> evmChains();

  Future<WalletKeystore> createEvmWallet({
    required String name,
    required String password,
  });

  Future<WalletKeystore> importEvmPrivateKey({
    required String name,
    required String privateKeyHex,
    required String password,
  });

  Future<WalletKeystore> importEvmMnemonic({
    required String name,
    required String mnemonic,
    required String password,
    String? derivationPath,
  });

  Future<WalletKeystore> importEvmKeystore({
    required String name,
    required String keystoreJson,
    required String password,
  });

  Future<WalletSummary> unlockEvmWallet({
    required String keystoreJson,
    required String password,
  });

  Future<EvmExportPrivateKeyResponse> exportEvmPrivateKey({
    required String keystoreJson,
    required String password,
  });

  Future<AssetSnapshot> loadAssets({
    required AppNetwork network,
    required String walletPublicKey,
  });

  Future<EvmAssetSnapshot> loadEvmAssets({
    required EvmChainConfig chain,
    required String walletAddress,
    List<String> tokenContracts = const [],
  });

  Future<SigningPreview> previewPayment({
    required AppNetwork network,
    required String walletPublicKey,
    required String recipient,
    required String amount,
    required PaymentOperation operation,
    required int amountBaseUnits,
    String? mint,
    String? memo,
  });

  Future<TransactionSubmitResult> confirmPayment({
    required SigningPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String recipient,
    required int amountBaseUnits,
    required PaymentOperation operation,
    String? mint,
  });

  Future<EvmPaymentPreview> previewEvmPayment({
    required EvmChainConfig chain,
    required String walletAddress,
    required String recipient,
    required String amountWeiOrUnits,
    String? tokenContract,
    String? memo,
  });

  Future<EvmTransactionSubmitResult> confirmEvmPayment({
    required EvmPaymentPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
  });

  Future<EvmTransactionStatus> evmTransactionStatus({
    required EvmChainConfig chain,
    required String transactionHash,
  });

  Future<TotpSetup> setupTotp(String account);

  Future<bool> verifyTotp({
    required String secret,
    required String code,
  });

  Future<BiometricPolicy> biometricPolicy();

  Future<SigningPreview> previewPumpSell({
    required AppNetwork network,
    required String walletPublicKey,
    required String mint,
  });

  Future<SigningPreview> previewDappSign({
    required AppNetwork network,
    required String walletPublicKey,
    required String appName,
    required String appUrl,
    required String method,
    required String payloadBase64,
    String? transactionFormat,
  });

  Future<DappSignSubmitResult> confirmDappSign({
    required SigningPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String appName,
    required String appUrl,
    required String method,
    required String payloadBase64,
    String? transactionFormat,
  });

  Future<EvmDappSignPreview> previewEvmDappSign({
    required EvmChainConfig chain,
    required String walletAddress,
    required String appName,
    required String appUrl,
    required String method,
    required String payloadJson,
  });

  Future<EvmDappSignSubmitResult> confirmEvmDappSign({
    required EvmDappSignPreview preview,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String method,
    required String payloadJson,
  });

  Future<SigningPreview> previewSquadsAction({
    required AppNetwork network,
    required String walletPublicKey,
    required String multisig,
    required String action,
  });

  Future<SquadsInfo> loadSquadsInfo({
    required AppNetwork network,
    required String multisig,
    String? proposal,
  });

  Future<SquadsProposals> loadSquadsProposals({
    required AppNetwork network,
    required String multisig,
    int? limit,
  });

  Future<SquadsCreateResult> confirmSquadsCreate({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required List<String> members,
    required int threshold,
    int? timeLock,
    String? memo,
  });

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
  });

  Future<TransactionSubmitResult> confirmSquadsApprove({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    String? memo,
  });

  Future<TransactionSubmitResult> confirmSquadsReject({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    String? memo,
  });

  Future<TransactionSubmitResult> confirmSquadsExecute({
    required AppNetwork network,
    required bool approved,
    required String keystoreJson,
    required String password,
    required String multisig,
    required String proposal,
    required int transactionIndex,
  });
}
