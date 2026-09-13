import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../bridge/mobile_bridge_provider.dart';

class AppScope extends ConsumerStatefulWidget {
  const AppScope({required this.child, super.key});

  final Widget child;

  @override
  ConsumerState<AppScope> createState() => _AppScopeState();
}

class _AppScopeState extends ConsumerState<AppScope>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive ||
        state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused ||
        state == AppLifecycleState.detached) {
      ref.read(mobileWalletSessionProvider).lock();
      ref.read(sensitiveClipboardProvider).clear();
    }
  }

  @override
  Widget build(BuildContext context) {
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

    return SafeArea(child: widget.child);
  }
}
