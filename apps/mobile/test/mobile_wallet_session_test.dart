import 'package:flutter_test/flutter_test.dart';
import 'package:fnzero_safe_mobile/src/security/mobile_wallet_session.dart';

void main() {
  test('password session encrypts, reveals and locks', () async {
    final session = MobileWalletSession();
    addTearDown(session.dispose);

    await session.unlock('correct horse battery staple');

    expect(session.isUnlocked, isTrue);
    expect(await session.revealPassword(), 'correct horse battery staple');

    session.lock();
    expect(session.isUnlocked, isFalse);
    expect(session.revealPassword(), throwsStateError);
  });

  test('password session expires automatically', () async {
    final session = MobileWalletSession(
      timeout: const Duration(milliseconds: 20),
    );
    addTearDown(session.dispose);

    await session.unlock('temporary password');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(session.isUnlocked, isFalse);
    expect(session.revealPassword(), throwsStateError);
  });

  test('empty passwords are rejected', () async {
    final session = MobileWalletSession();
    addTearDown(session.dispose);

    expect(session.unlock(''), throwsArgumentError);
  });

  test('oversized passwords are rejected', () async {
    final session = MobileWalletSession();
    addTearDown(session.dispose);

    expect(session.unlock('x' * 1025), throwsArgumentError);
  });
}
