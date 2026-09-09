import 'package:flutter_test/flutter_test.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_bridge.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_models.dart';
import 'package:fnzero_safe_mobile/src/features/mobile_capabilities.dart';

void main() {
  test('mobile v1 keeps Squads and excludes Program workflows', () {
    expect(isMobileCapabilityEnabled('chain_catalog'), isTrue);
    expect(isMobileCapabilityEnabled('squads_multisig'), isTrue);
    expect(isMobileCapabilityExcluded('program_deploy'), isTrue);
    expect(isMobileCapabilityExcluded('program_upgrade'), isTrue);
    expect(isMobileCapabilityExcluded('program_invoke'), isTrue);
    expect(isMobileCapabilityEnabled('evm_chains'), isTrue);
    expect(isMobileCapabilityEnabled('evm_wallets'), isTrue);
    expect(isMobileCapabilityEnabled('evm_payments'), isTrue);
  });

  test('development bridge exposes capability-aware chain families', () async {
    final bridge = MobileBridge(
      backend: const DevelopmentMobileBridgeBackend(),
    );
    final capabilities = await bridge.capabilities();
    final catalog = await bridge.multichainCatalog();

    expect(capabilities.enabled, mobileEnabledCapabilities);
    expect(capabilities.excluded, mobileExcludedCapabilities);
    expect(catalog.map((chain) => chain.family).toSet(),
        containsAll(['solana', 'evm', 'bitcoin', 'tron']));
    expect(
      () => catalog.add(catalog.first),
      throwsUnsupportedError,
    );
    expect(
      () => catalog.first.capabilities.add('transactions:bypass'),
      throwsUnsupportedError,
    );
    expect(
      catalog
          .where((chain) => chain.family == 'bitcoin' || chain.family == 'tron')
          .every((chain) =>
              !chain.supports('assets:native_balance') &&
              !chain.supports('transactions:transfer')),
      isTrue,
    );
    expect(
      catalog.every((chain) =>
          !chain.supports('accounts:derive') &&
          !chain.supports('accounts:validate')),
      isTrue,
    );
  });

  test('development bridge never fakes chain identity operations', () async {
    final bridge = MobileBridge(
      backend: const DevelopmentMobileBridgeBackend(),
    );

    await expectLater(
      bridge.normalizeMultichainAddress(
        chainId: 'tron:728126428',
        address: 'TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC',
      ),
      throwsA(
        isA<MobileBridgeException>().having(
          (error) => error.code,
          'code',
          'unsupported',
        ),
      ),
    );
    await expectLater(
      bridge.deriveMultichainAccount(
        chainId: 'bip122:000000000019d6689c085ae165831e93',
        mnemonic: 'development mnemonic must not be accepted',
      ),
      throwsA(isA<MobileBridgeException>()),
    );
  });

  test('development bridge exposes EIP-1559 EVM payment preview fields',
      () async {
    final bridge = MobileBridge(
      backend: const DevelopmentMobileBridgeBackend(),
    );
    final chain = (await bridge.evmChains()).first;
    final preview = await bridge.previewEvmPayment(
      chain: chain,
      walletAddress: '0x0000000000000000000000000000000000000001',
      recipient: '0x000000000000000000000000000000000000dead',
      amountWeiOrUnits: '1',
    );

    expect(preview.feeModel, 'eip1559');
    expect(preview.maxFeePerGasWei, isNotEmpty);
    expect(preview.maxPriorityFeePerGasWei, isNotEmpty);
  });

  test('development bridge can return an EVM dApp signed transaction',
      () async {
    final bridge = MobileBridge(
      backend: const DevelopmentMobileBridgeBackend(),
    );
    final chain = (await bridge.evmChains()).first;
    const result = EvmDappSignSubmitResult(
      status: 'signed',
      signedTransaction: '0x02f8',
    );

    expect(chain.chainId, isPositive);
    expect(result.signature, isNull);
    expect(result.signedTransaction, '0x02f8');
  });
}
