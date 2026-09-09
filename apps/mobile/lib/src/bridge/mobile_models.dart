enum AppNetwork { mainnet, devnet, testnet }

enum WalletFamily { solana, evm }

extension AppNetworkLabel on AppNetwork {
  String get label => switch (this) {
        AppNetwork.mainnet => 'Mainnet',
        AppNetwork.devnet => 'Devnet',
        AppNetwork.testnet => 'Testnet',
      };
}

class EvmChainConfig {
  const EvmChainConfig({
    required this.chainId,
    required this.name,
    required this.nativeSymbol,
    required this.rpcUrl,
    required this.testnet,
    this.explorerUrl,
  });

  factory EvmChainConfig.fromJson(Map<String, Object?> json) {
    return EvmChainConfig(
      chainId: json['chainId'] as int,
      name: json['name'] as String,
      nativeSymbol: json['nativeSymbol'] as String,
      rpcUrl: json['rpcUrl'] as String,
      explorerUrl: json['explorerUrl'] as String?,
      testnet: json['testnet'] as bool? ?? false,
    );
  }

  final int chainId;
  final String name;
  final String nativeSymbol;
  final String rpcUrl;
  final String? explorerUrl;
  final bool testnet;

  String get label => '$name ($chainId)';

  Map<String, Object?> toJson() => {
        'chainId': chainId,
        'name': name,
        'nativeSymbol': nativeSymbol,
        'rpcUrl': rpcUrl,
        if (explorerUrl != null) 'explorerUrl': explorerUrl,
        'testnet': testnet,
      };
}

class MultiChainNativeAsset {
  const MultiChainNativeAsset({
    required this.symbol,
    required this.name,
    required this.decimals,
  });

  final String symbol;
  final String name;
  final int decimals;
}

class MultiChainEndpoint {
  const MultiChainEndpoint({required this.kind, required this.url});

  final String kind;
  final String url;
}

class MultiChainDescriptor {
  MultiChainDescriptor({
    required this.chainId,
    required this.family,
    required this.name,
    required this.network,
    required this.testnet,
    required this.nativeAsset,
    required this.defaultDerivationPath,
    required List<String> addressFormats,
    required List<String> capabilities,
    required List<MultiChainEndpoint> endpoints,
    required this.supportLevel,
    this.explorerUrl,
  })  : addressFormats = List.unmodifiable(addressFormats),
        capabilities = List.unmodifiable(capabilities),
        endpoints = List.unmodifiable(endpoints);

  final String chainId;
  final String family;
  final String name;
  final String network;
  final bool testnet;
  final MultiChainNativeAsset nativeAsset;
  final String defaultDerivationPath;
  final List<String> addressFormats;
  final List<String> capabilities;
  final List<MultiChainEndpoint> endpoints;
  final String? explorerUrl;
  final String supportLevel;

  bool supports(String capability) => capabilities.contains(capability);
}

class MultiChainNormalizedAddress {
  const MultiChainNormalizedAddress({
    required this.chainId,
    required this.accountId,
    required this.address,
  });

  final String chainId;
  final String accountId;
  final String address;
}

class MultiChainDerivedAccount {
  const MultiChainDerivedAccount({
    required this.chainId,
    required this.accountId,
    required this.address,
    required this.derivationPath,
    this.publicKeyHex,
  });

  final String chainId;
  final String accountId;
  final String address;
  final String derivationPath;
  final String? publicKeyHex;
}

class WalletSummary {
  const WalletSummary({
    required this.id,
    required this.name,
    required this.publicKey,
    this.family = WalletFamily.solana,
    this.derivationPath,
  });

  factory WalletSummary.fromJson(Map<String, Object?> json) {
    return WalletSummary(
      id: json['id'] as String,
      name: json['name'] as String,
      publicKey: json['publicKey'] as String,
      family: switch (json['family']) {
        'evm' => WalletFamily.evm,
        _ => WalletFamily.solana,
      },
      derivationPath: json['derivationPath'] as String?,
    );
  }

  final String id;
  final String name;
  final String publicKey;
  final WalletFamily family;
  final String? derivationPath;

  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        'publicKey': publicKey,
        'family': family.name,
        if (derivationPath != null) 'derivationPath': derivationPath,
      };
}

class WalletKeystore {
  const WalletKeystore({
    required this.wallet,
    required this.keystoreJson,
  });

  final WalletSummary wallet;
  final String keystoreJson;
}

class AssetSnapshot {
  const AssetSnapshot({
    required this.network,
    required this.walletPublicKey,
    required this.solBalanceLamports,
    required this.tokens,
    this.recentTransactions = const [],
    this.refreshedAtMs,
  });

  final AppNetwork network;
  final String walletPublicKey;
  final int solBalanceLamports;
  final List<TokenAsset> tokens;
  final List<TransactionHistoryEntry> recentTransactions;
  final int? refreshedAtMs;
}

class EvmAssetSnapshot {
  const EvmAssetSnapshot({
    required this.chain,
    required this.walletAddress,
    required this.nativeBalanceWei,
    required this.tokens,
    required this.recentTransactions,
    required this.historyStatus,
    this.historyMessage,
    this.refreshedAtMs,
  });

  final EvmChainConfig chain;
  final String walletAddress;
  final String nativeBalanceWei;
  final List<EvmTokenAsset> tokens;
  final List<EvmTransactionHistoryEntry> recentTransactions;
  final String historyStatus;
  final String? historyMessage;
  final int? refreshedAtMs;
}

class EvmTokenAsset {
  const EvmTokenAsset({
    required this.contractAddress,
    required this.symbol,
    required this.name,
    required this.balance,
    required this.decimals,
  });

  final String contractAddress;
  final String symbol;
  final String name;
  final String balance;
  final int decimals;
}

class EvmTransactionHistoryEntry {
  const EvmTransactionHistoryEntry({
    required this.hash,
    required this.status,
    this.blockNumber,
  });

  final String hash;
  final int? blockNumber;
  final String status;
}

class TokenAsset {
  const TokenAsset({
    required this.tokenAccount,
    required this.mint,
    required this.symbol,
    required this.name,
    required this.amount,
    required this.rawAmount,
    required this.decimals,
    this.logoUri,
  });

  final String tokenAccount;
  final String mint;
  final String symbol;
  final String name;
  final String amount;
  final String rawAmount;
  final int decimals;
  final String? logoUri;
}

class TransactionHistoryEntry {
  const TransactionHistoryEntry({
    required this.signature,
    required this.slot,
    required this.status,
    this.blockTime,
  });

  final String signature;
  final int slot;
  final int? blockTime;
  final String status;
}

class ExportPrivateKeyResponse {
  const ExportPrivateKeyResponse({
    required this.publicKey,
    required this.privateKeyBase58,
  });

  final String publicKey;
  final String privateKeyBase58;
}

class EvmExportPrivateKeyResponse {
  const EvmExportPrivateKeyResponse({
    required this.address,
    required this.privateKeyHex,
  });

  final String address;
  final String privateKeyHex;
}

class SigningPreview {
  const SigningPreview({
    required this.id,
    required this.title,
    required this.network,
    required this.walletPublicKey,
    required this.summary,
    required this.warnings,
    this.requiresUserConfirmation = true,
  });

  final String id;
  final String title;
  final AppNetwork network;
  final String walletPublicKey;
  final String summary;
  final List<String> warnings;
  final bool requiresUserConfirmation;
}

class PaymentSigningDraft {
  const PaymentSigningDraft({
    required this.preview,
    required this.recipient,
    required this.amountBaseUnits,
    this.operation = PaymentOperation.solTransfer,
    this.mint,
  });

  final SigningPreview preview;
  final String recipient;
  final int amountBaseUnits;
  final PaymentOperation operation;
  final String? mint;
}

class EvmPaymentSigningDraft {
  const EvmPaymentSigningDraft({
    required this.preview,
    required this.recipient,
    required this.amountWeiOrUnits,
    this.tokenContract,
  });

  final EvmPaymentPreview preview;
  final String recipient;
  final String amountWeiOrUnits;
  final String? tokenContract;
}

class EvmPaymentPreview {
  const EvmPaymentPreview({
    required this.previewId,
    required this.chain,
    required this.walletAddress,
    required this.recipient,
    required this.amountWeiOrUnits,
    required this.gasLimit,
    required this.gasPriceWei,
    this.maxFeePerGasWei,
    this.maxPriorityFeePerGasWei,
    required this.feeModel,
    required this.nonce,
    required this.estimatedFeeWei,
    required this.summary,
    required this.warnings,
    this.tokenContract,
  });

  final String previewId;
  final EvmChainConfig chain;
  final String walletAddress;
  final String recipient;
  final String? tokenContract;
  final String amountWeiOrUnits;
  final String gasLimit;
  final String gasPriceWei;
  final String? maxFeePerGasWei;
  final String? maxPriorityFeePerGasWei;
  final String feeModel;
  final String nonce;
  final String estimatedFeeWei;
  final String summary;
  final List<String> warnings;
}

class DappSigningDraft {
  const DappSigningDraft({
    required this.preview,
    required this.appName,
    required this.appUrl,
    required this.method,
    required this.payloadBase64,
    this.requestId,
    this.transactionFormat,
  });

  final SigningPreview preview;
  final String appName;
  final String appUrl;
  final String method;
  final String payloadBase64;
  final String? requestId;
  final String? transactionFormat;
}

class EvmDappSigningDraft {
  const EvmDappSigningDraft({
    required this.preview,
    required this.method,
    required this.payloadJson,
    this.requestId,
  });

  final EvmDappSignPreview preview;
  final String method;
  final String payloadJson;
  final String? requestId;
}

class EvmDappSignPreview {
  const EvmDappSignPreview({
    required this.previewId,
    required this.chain,
    required this.walletAddress,
    required this.appName,
    required this.appUrl,
    required this.method,
    required this.summary,
    required this.warnings,
  });

  final String previewId;
  final EvmChainConfig chain;
  final String walletAddress;
  final String appName;
  final String appUrl;
  final String method;
  final String summary;
  final List<String> warnings;
}

class DappSignResponse {
  const DappSignResponse({
    required this.requestId,
    required this.approved,
    this.signature,
    this.signatureBase64,
    this.signedPayloadBase64,
    this.signedTransaction,
    this.signedPayloadsBase64 = const [],
    this.transactionSignature,
    this.error,
  });

  final String requestId;
  final bool approved;
  final String? signature;
  final String? signatureBase64;
  final String? signedPayloadBase64;
  final String? signedTransaction;
  final List<String> signedPayloadsBase64;
  final String? transactionSignature;
  final String? error;
}

enum SquadsDraftKind {
  create,
  solTransferProposal,
  tokenTransferProposal,
  approve,
  reject,
  execute,
}

class SquadsSigningDraft {
  const SquadsSigningDraft({
    required this.preview,
    required this.kind,
    this.members = const [],
    this.threshold = 1,
    this.timeLock,
    this.multisig,
    this.proposal,
    this.transactionIndex,
    this.recipient,
    this.destinationTokenAccount,
    this.sourceTokenAccount,
    this.mint,
    this.amountBaseUnits = 0,
    this.decimals,
    this.memo,
  });

  final SigningPreview preview;
  final SquadsDraftKind kind;
  final List<String> members;
  final int threshold;
  final int? timeLock;
  final String? multisig;
  final String? proposal;
  final int? transactionIndex;
  final String? recipient;
  final String? destinationTokenAccount;
  final String? sourceTokenAccount;
  final String? mint;
  final int amountBaseUnits;
  final int? decimals;
  final String? memo;
}

enum PaymentOperation {
  solTransfer,
  splTokenTransfer,
  wsolWrap,
  wsolUnwrap,
  wsolCloseAta,
}

class TransactionSubmitResult {
  const TransactionSubmitResult({
    required this.signature,
    required this.network,
    required this.submittedAt,
    required this.status,
    this.slot,
  });

  final String signature;
  final int? slot;
  final AppNetwork network;
  final String submittedAt;
  final String status;
}

class EvmTransactionSubmitResult {
  const EvmTransactionSubmitResult({
    required this.transactionHash,
    required this.chain,
    required this.submittedAt,
    required this.status,
    this.blockNumber,
  });

  final String transactionHash;
  final EvmChainConfig chain;
  final String submittedAt;
  final String status;
  final int? blockNumber;
}

class EvmTransactionStatus {
  const EvmTransactionStatus({
    required this.transactionHash,
    required this.chain,
    required this.status,
    this.blockNumber,
    this.gasUsed,
    this.effectiveGasPriceWei,
  });

  final String transactionHash;
  final EvmChainConfig chain;
  final int? blockNumber;
  final String status;
  final String? gasUsed;
  final String? effectiveGasPriceWei;
}

class DappSignSubmitResult {
  const DappSignSubmitResult({
    required this.status,
    this.signature,
    this.signatureBase64,
    this.signedPayloadBase64,
    this.signedPayloadsBase64 = const [],
    this.transaction,
  });

  final String status;
  final String? signature;
  final String? signatureBase64;
  final String? signedPayloadBase64;
  final List<String> signedPayloadsBase64;
  final TransactionSubmitResult? transaction;
}

class EvmDappSignSubmitResult {
  const EvmDappSignSubmitResult({
    required this.status,
    this.signature,
    this.signedTransaction,
    this.transaction,
  });

  final String status;
  final String? signature;
  final String? signedTransaction;
  final EvmTransactionSubmitResult? transaction;
}

class SquadsMemberSummary {
  const SquadsMemberSummary({
    required this.key,
    required this.permissions,
  });

  final String key;
  final int permissions;
}

class SquadsProposalSummary {
  const SquadsProposalSummary({
    required this.address,
    required this.transactionIndex,
    required this.status,
    required this.approved,
    required this.rejected,
    required this.cancelled,
  });

  final String address;
  final int transactionIndex;
  final String status;
  final List<String> approved;
  final List<String> rejected;
  final List<String> cancelled;
}

class SquadsInfo {
  const SquadsInfo({
    required this.multisig,
    required this.vault,
    required this.createKey,
    required this.threshold,
    required this.timeLock,
    required this.transactionIndex,
    required this.staleTransactionIndex,
    required this.members,
    required this.network,
    this.proposal,
  });

  final String multisig;
  final String vault;
  final String createKey;
  final int threshold;
  final int timeLock;
  final int transactionIndex;
  final int staleTransactionIndex;
  final List<SquadsMemberSummary> members;
  final SquadsProposalSummary? proposal;
  final AppNetwork network;
}

class SquadsProposals {
  const SquadsProposals({
    required this.multisig,
    required this.vault,
    required this.proposals,
    required this.latestTransactionIndex,
    required this.network,
  });

  final String multisig;
  final String vault;
  final List<SquadsProposalSummary> proposals;
  final int latestTransactionIndex;
  final AppNetwork network;
}

class SquadsCreateResult {
  const SquadsCreateResult({
    required this.multisig,
    required this.vault,
    required this.createKey,
    required this.signature,
    required this.threshold,
    required this.members,
    required this.creationFeeLamports,
    required this.network,
    required this.status,
  });

  final String multisig;
  final String vault;
  final String createKey;
  final String signature;
  final int threshold;
  final List<SquadsMemberSummary> members;
  final int creationFeeLamports;
  final AppNetwork network;
  final String status;
}

class SquadsProposalCreateResult {
  const SquadsProposalCreateResult({
    required this.multisig,
    required this.vault,
    required this.transaction,
    required this.proposal,
    required this.transactionIndex,
    required this.signature,
    required this.network,
    required this.status,
  });

  final String multisig;
  final String vault;
  final String transaction;
  final String proposal;
  final int transactionIndex;
  final String signature;
  final AppNetwork network;
  final String status;
}

enum SquadsTransferKind { sol, splToken }

class SigningDecision {
  const SigningDecision({
    required this.previewId,
    required this.approved,
    required this.status,
  });

  final String previewId;
  final bool approved;
  final String status;
}

class MobileCapabilities {
  const MobileCapabilities({
    required this.enabled,
    required this.excluded,
  });

  final List<String> enabled;
  final List<String> excluded;
}

class TotpSetup {
  const TotpSetup({
    required this.secret,
    required this.issuer,
    required this.account,
  });

  final String secret;
  final String issuer;
  final String account;
}

class BiometricPolicy {
  const BiometricPolicy({
    required this.supported,
    required this.configured,
    this.reason,
  });

  final bool supported;
  final bool configured;
  final String? reason;
}

class MobileBridgeException implements Exception {
  const MobileBridgeException(this.code, this.message);

  final String code;
  final String message;

  @override
  String toString() => message;
}
