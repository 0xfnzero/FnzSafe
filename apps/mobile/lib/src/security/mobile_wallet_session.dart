import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/foundation.dart';

class MobileWalletSession extends ChangeNotifier {
  MobileWalletSession({this.timeout = const Duration(minutes: 5)});

  final Duration timeout;
  final AesGcm _cipher = AesGcm.with256bits();

  SecretKey? _memoryKey;
  Uint8List? _cipherText;
  Uint8List? _nonce;
  Uint8List? _mac;
  DateTime? _expiresAt;
  Timer? _timer;

  bool get isUnlocked {
    final expiresAt = _expiresAt;
    if (_memoryKey == null || expiresAt == null) return false;
    if (DateTime.now().isAfter(expiresAt)) {
      lock(notify: false);
      return false;
    }
    return true;
  }

  DateTime? get expiresAt => isUnlocked ? _expiresAt : null;

  Future<void> unlock(String password) async {
    if (password.isEmpty) {
      throw ArgumentError.value(password, 'password', 'Password is required');
    }
    if (password.length > 1024) {
      throw ArgumentError.value(
          password.length, 'password', 'Password is too long');
    }
    lock(notify: false);

    final clearText = Uint8List.fromList(utf8.encode(password));
    try {
      final key = await _cipher.newSecretKey();
      final nonce = _cipher.newNonce();
      final box = await _cipher.encrypt(
        clearText,
        secretKey: key,
        nonce: nonce,
      );
      _memoryKey = key;
      _cipherText = Uint8List.fromList(box.cipherText);
      _nonce = Uint8List.fromList(box.nonce);
      _mac = Uint8List.fromList(box.mac.bytes);
      _touch();
      notifyListeners();
    } finally {
      clearText.fillRange(0, clearText.length, 0);
    }
  }

  Future<String> revealPassword() async {
    if (!isUnlocked) {
      throw StateError('Wallet session is locked');
    }
    final key = _memoryKey!;
    final box = SecretBox(
      _cipherText!,
      nonce: _nonce!,
      mac: Mac(_mac!),
    );
    final clearText = Uint8List.fromList(
      await _cipher.decrypt(box, secretKey: key),
    );
    try {
      _touch();
      return utf8.decode(clearText);
    } finally {
      clearText.fillRange(0, clearText.length, 0);
    }
  }

  void _touch() {
    _expiresAt = DateTime.now().add(timeout);
    _timer?.cancel();
    _timer = Timer(timeout, lock);
  }

  void lock({bool notify = true}) {
    _timer?.cancel();
    _timer = null;
    _cipherText?.fillRange(0, _cipherText!.length, 0);
    _nonce?.fillRange(0, _nonce!.length, 0);
    _mac?.fillRange(0, _mac!.length, 0);
    _memoryKey = null;
    _cipherText = null;
    _nonce = null;
    _mac = null;
    _expiresAt = null;
    if (notify) notifyListeners();
  }

  @override
  void dispose() {
    lock(notify: false);
    super.dispose();
  }
}
