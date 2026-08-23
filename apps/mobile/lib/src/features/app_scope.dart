import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bridge/mobile_bridge_provider.dart';

class AppScope extends ConsumerWidget {
  const AppScope({required this.child, super.key});

  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen(storedActiveWalletProvider, (previous, next) {
      next.whenData((wallet) {
        final active = ref.read(activeWalletProvider);
        if (active == null && wallet != null) {
          ref.read(activeWalletProvider.notifier).state = wallet;
        }
      });
    });

    ref.listen(evmChainsProvider, (previous, next) {
      next.whenData((chains) {
        final active = ref.read(activeEvmChainProvider);
        if (active == null && chains.isNotEmpty) {
          ref.read(activeEvmChainProvider.notifier).state = chains
              .firstWhere((chain) => chain.testnet, orElse: () => chains.first);
        }
      });
    });

    return SafeArea(child: child);
  }
}
