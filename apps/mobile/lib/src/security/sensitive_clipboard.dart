import 'dart:async';

import 'package:flutter/services.dart';

class SensitiveClipboard {
  Timer? _clearTimer;
  String? _copiedValue;

  Future<void> copy(String value) async {
    _clearTimer?.cancel();
    _copiedValue = value;
    await Clipboard.setData(ClipboardData(text: value));
    _clearTimer = Timer(const Duration(seconds: 15), () {
      unawaited(clear());
    });
  }

  Future<void> clear() async {
    _clearTimer?.cancel();
    _clearTimer = null;
    final expected = _copiedValue;
    _copiedValue = null;
    if (expected == null) return;
    try {
      final current = await Clipboard.getData(Clipboard.kTextPlain);
      if (current?.text != expected) return;
    } catch (_) {
      // When clipboard reads are restricted, clearing is safer than retaining a key.
    }
    try {
      await Clipboard.setData(const ClipboardData(text: ''));
    } catch (_) {
      // The operating system may reject clipboard access while suspending.
    }
  }

  void dispose() {
    unawaited(clear());
  }
}
