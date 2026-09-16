import 'package:flutter_test/flutter_test.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_bridge.dart';
import 'package:fnzero_safe_mobile/src/ui/wallet_ui.dart';

void main() {
  test('Arc development networks match production metadata and fee units',
      () async {
    final bridge =
        MobileBridge(backend: const DevelopmentMobileBridgeBackend());
    final chains = await bridge.evmChains();
    for (final id in [5042, 5042002]) {
      final chain = chains.singleWhere((chain) => chain.chainId == id);
      expect(chain.nativeSymbol, 'USDC');
      expect(chain.testnet, id == 5042002);
      expect(evmFeeLabel(chain, '20000000000'), '0.00000002 USDC');
      expect(evmFeeLabel(chain, '1000000000000000001'),
          '1.000000000000000001 USDC');
      expect(
          chain
              .isNativeTokenAlias('0x3600000000000000000000000000000000000000'),
          isTrue);
      final assets = await bridge.loadEvmAssets(
          chain: chain,
          walletAddress: '0x1111111111111111111111111111111111111111',
          tokenContracts: ['0x3600000000000000000000000000000000000000']);
      expect(assets.tokens, isEmpty);
    }
    final ethereum = chains.singleWhere((chain) => chain.chainId == 1);
    expect(evmFeeLabel(ethereum, '1'), '1 wei');
    expect(
        ethereum
            .isNativeTokenAlias('0x3600000000000000000000000000000000000000'),
        isFalse);
    final catalog = await bridge.multichainCatalog();
    final arc =
        catalog.singleWhere((chain) => chain.chainId == 'eip155:5042002');
    expect(arc.nativeAsset.decimals, 18);
    expect(arc.nativeAsset.symbol, 'USDC');
    expect(arc.supports('transactions:history'), isFalse);
  });
}
