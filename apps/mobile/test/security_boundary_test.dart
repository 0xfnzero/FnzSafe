import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_models.dart';
import 'package:fnzero_safe_mobile/src/bridge/mobile_bridge_provider.dart';
import 'package:fnzero_safe_mobile/src/security/sensitive_clipboard.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('dApp page context binds both origin and navigation generation', () {
    const request = DappPageContext(
      origin: 'https://app.uniswap.org',
      navigationGeneration: 7,
    );

    expect(
      request.matches(const DappPageContext(
        origin: 'https://app.uniswap.org',
        navigationGeneration: 7,
      )),
      isTrue,
    );
    expect(
      request.matches(const DappPageContext(
        origin: 'https://evil.example',
        navigationGeneration: 7,
      )),
      isFalse,
    );
    expect(
      request.matches(const DappPageContext(
        origin: 'https://app.uniswap.org',
        navigationGeneration: 8,
      )),
      isFalse,
    );
  });

  test('built-in EVM chains cannot be replaced by custom RPC entries', () {
    const builtin = EvmChainConfig(
      chainId: 1,
      name: 'Ethereum',
      nativeSymbol: 'ETH',
      rpcUrl: 'https://ethereum-rpc.publicnode.com',
      testnet: false,
    );
    const hostile = EvmChainConfig(
      chainId: 1,
      name: 'Fake Ethereum',
      nativeSymbol: 'ETH',
      rpcUrl: 'https://rpc.attacker.example',
      testnet: false,
    );

    final merged = mergeEvmChains([builtin], [hostile]);
    expect(merged, hasLength(1));
    expect(merged.single.rpcUrl, builtin.rpcUrl);
  });

  testWidgets('sensitive clipboard expires without overwriting newer content',
      (tester) async {
    String clipboard = '';
    var denyRead = false;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        clipboard = (call.arguments as Map<Object?, Object?>)['text'] as String;
        return null;
      }
      if (call.method == 'Clipboard.getData') {
        if (denyRead) throw PlatformException(code: 'denied');
        return {'text': clipboard};
      }
      return null;
    });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null);
    });

    final sensitiveClipboard = SensitiveClipboard();
    await sensitiveClipboard.copy('private-key');
    expect(clipboard, 'private-key');
    clipboard = 'new user content';
    await tester.pump(const Duration(seconds: 16));
    expect(clipboard, 'new user content');

    await sensitiveClipboard.copy('private-key');
    await tester.pump(const Duration(seconds: 16));
    expect(clipboard, isEmpty);

    await sensitiveClipboard.copy('private-key');
    denyRead = true;
    await tester.pump(const Duration(seconds: 16));
    expect(clipboard, isEmpty);
    sensitiveClipboard.dispose();
  });
}
