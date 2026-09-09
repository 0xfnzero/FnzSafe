import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:fnzero_safe_mobile/src/app.dart';

void main() {
  testWidgets('mobile app dashboard smoke test', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: FnzSafeMobileApp()));
    await tester.pumpAndSettle();

    expect(find.text('FnzSafe'), findsOneWidget);
    expect(find.text('Mobile Wallet'), findsOneWidget);
    await tester.scrollUntilVisible(find.text('Squads'), 200);
    expect(find.text('Squads'), findsOneWidget);
  });
}
