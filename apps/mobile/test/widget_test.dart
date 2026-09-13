import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:fnzero_safe_mobile/src/app.dart';
import 'package:fnzero_safe_mobile/src/features/wallets_screen.dart';

void main() {
  testWidgets('mobile app dashboard smoke test', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(const ProviderScope(child: FnzSafeMobileApp()));
    await tester.pumpAndSettle();

    expect(find.text('Select wallet'), findsOneWidget);
    expect(find.text('Your wallet starts here'), findsOneWidget);
    expect(find.text('Add wallet'), findsOneWidget);
    expect(find.text('Assets'), findsOneWidget);
    expect(find.text('Browser'), findsOneWidget);
    expect(find.text('Settings'), findsOneWidget);
  });

  testWidgets('wallet management fits a phone viewport and shows all chains',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(home: WalletsScreen()),
      ),
    );
    await tester.pump(const Duration(milliseconds: 500));

    expect(find.text('Select chain'), findsOneWidget);
    expect(find.text('Solana'), findsOneWidget);
    expect(find.text('EVM'), findsOneWidget);
    expect(find.text('BTC'), findsOneWidget);
    expect(find.text('TRON'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
