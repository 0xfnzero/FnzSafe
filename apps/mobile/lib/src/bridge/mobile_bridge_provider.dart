import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../storage/mobile_wallet_store.dart';
import '../security/biometric_gate.dart';
import '../security/mobile_wallet_session.dart';
import '../security/sensitive_clipboard.dart';
import 'mobile_bridge.dart';
import 'mobile_models.dart';

final mobileBridgeProvider = Provider<MobileBridge>((ref) => MobileBridge());

final mobileCapabilitiesProvider = FutureProvider<MobileCapabilities>((ref) {
  return ref.watch(mobileBridgeProvider).capabilities();
});

final mobileWalletStoreProvider = Provider<MobileWalletStore>((ref) {
  return MobileWalletStore();
});

final biometricGateProvider = Provider<BiometricGate>((ref) {
  return BiometricGate(ref.watch(mobileWalletStoreProvider));
});

final mobileWalletSessionProvider =
    ChangeNotifierProvider<MobileWalletSession>((ref) {
  return MobileWalletSession();
});

final sensitiveClipboardProvider = Provider<SensitiveClipboard>((ref) {
  final clipboard = SensitiveClipboard();
  ref.onDispose(clipboard.dispose);
  return clipboard;
});

final storedWalletsProvider = FutureProvider<List<WalletSummary>>((ref) {
  return ref.watch(mobileWalletStoreProvider).loadWallets();
});

final storedActiveWalletProvider = FutureProvider<WalletSummary?>((ref) {
  return ref.watch(mobileWalletStoreProvider).loadActiveWallet();
});

final activeNetworkProvider =
    StateProvider<AppNetwork>((ref) => AppNetwork.devnet);

List<EvmChainConfig> mergeEvmChains(
  List<EvmChainConfig> builtins,
  List<EvmChainConfig> custom,
) {
  final merged = <int, EvmChainConfig>{
    for (final chain in custom) chain.chainId: chain,
    for (final chain in builtins) chain.chainId: chain,
  };
  return merged.values.toList(growable: false)
    ..sort((a, b) {
      if (a.testnet != b.testnet) return a.testnet ? 1 : -1;
      return a.chainId.compareTo(b.chainId);
    });
}

final evmChainsProvider = FutureProvider<List<EvmChainConfig>>((ref) async {
  final builtins = await ref.watch(mobileBridgeProvider).evmChains();
  final custom =
      await ref.watch(mobileWalletStoreProvider).loadCustomEvmChains();
  return mergeEvmChains(builtins, custom);
});

final multichainCatalogProvider =
    FutureProvider<List<MultiChainDescriptor>>((ref) {
  return ref.watch(mobileBridgeProvider).multichainCatalog();
});

final activeEvmChainProvider = StateProvider<EvmChainConfig?>((ref) => null);

final activeWalletProvider = StateProvider<WalletSummary?>((ref) => null);

final signingPreviewProvider = StateProvider<SigningPreview?>((ref) => null);

final paymentSigningDraftProvider =
    StateProvider<PaymentSigningDraft?>((ref) => null);

final evmPaymentSigningDraftProvider =
    StateProvider<EvmPaymentSigningDraft?>((ref) => null);

final dappSigningDraftProvider =
    StateProvider<DappSigningDraft?>((ref) => null);

final evmDappSigningDraftProvider =
    StateProvider<EvmDappSigningDraft?>((ref) => null);

final dappSignResponseProvider =
    StateProvider<DappSignResponse?>((ref) => null);

final dappPageContextProvider = StateProvider<DappPageContext?>((ref) => null);

final squadsSigningDraftProvider =
    StateProvider<SquadsSigningDraft?>((ref) => null);

final scannedValueProvider = StateProvider<String?>((ref) => null);
