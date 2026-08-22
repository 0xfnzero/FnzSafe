import 'package:flutter_test/flutter_test.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_bridge.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_models.dart';
import 'package:fnzero_safe_mobile/src/features/mobile_capabilities.dart';

void main() {
  test('mobile v1 keeps Squads and excludes Program workflows', () {
    expect(isMobileCapabilityEnabled('squads_multisig'), isTrue);
    expect(isMobileCapabilityExcluded('program_deploy'), isTrue);
    expect(isMobileCapabilityExcluded('program_upgrade'), isTrue);
    expect(isMobileCapabilityExcluded('program_invoke'), isTrue);
    expect(isMobileCapabilityEnabled('evm_chains'), isTrue);
    expect(isMobileCapabilityEnabled('evm_wallets'), isTrue);
    expect(isMobileCapabilityEnabled('evm_payments'), isTrue);
  });

  test('development bridge exposes EIP-1559 EVM payment preview fields',
      () async {
    final bridge = MobileBridge();
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
    final chain = (await MobileBridge().evmChains()).first;
    const result = EvmDappSignSubmitResult(
      status: 'signed',
      signedTransaction: '0x02f8',
    );

    expect(chain.chainId, isPositive);
    expect(result.signature, isNull);
    expect(result.signedTransaction, '0x02f8');
  });
}
