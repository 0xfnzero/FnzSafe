import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../bridge/mobile_bridge.dart';
import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class FeatureScreen extends ConsumerWidget {
  const FeatureScreen({
    required this.title,
    required this.description,
    required this.actions,
    super.key,
  });

  final String title;
  final String description;
  final List<FeatureAction> actions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final wallet = ref.watch(activeWalletProvider);
    final network = ref.watch(activeNetworkProvider);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/'),
        ),
        title: Text(title),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          Text(description),
          const SizedBox(height: 16),
          _ContextPanel(wallet: wallet, network: network),
          const SizedBox(height: 16),
          for (final action in actions) ...[
            FilledButton.icon(
              onPressed: () => _runAction(context, ref, action),
              icon: Icon(action.icon),
              label: Text(action.label),
            ),
            const SizedBox(height: 10),
          ],
        ],
      ),
    );
  }

  Future<void> _runAction(
      BuildContext context, WidgetRef ref, FeatureAction action) async {
    final bridge = ref.read(mobileBridgeProvider);
    final network = ref.read(activeNetworkProvider);
    final wallet = ref.read(activeWalletProvider);

    try {
      final result = await action.run(bridge, network, wallet);
      if (result is WalletSummary) {
        ref.read(activeWalletProvider.notifier).state = result;
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Active wallet: ${result.name}')),
          );
        }
        return;
      }
      if (result is WalletKeystore) {
        await ref.read(mobileWalletStoreProvider).saveWalletKeystore(result);
        ref.read(activeWalletProvider.notifier).state = result.wallet;
        ref.invalidate(storedWalletsProvider);
        ref.invalidate(storedActiveWalletProvider);
        if (context.mounted) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('Saved wallet: ${result.wallet.name}')),
          );
        }
        return;
      }
      if (result is SigningPreview) {
        ref.read(signingPreviewProvider.notifier).state = result;
        ref.read(paymentSigningDraftProvider.notifier).state = null;
        ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
        ref.read(dappSigningDraftProvider.notifier).state = null;
        ref.read(evmDappSigningDraftProvider.notifier).state = null;
        ref.read(squadsSigningDraftProvider.notifier).state = null;
        if (context.mounted) context.go('/confirm');
        return;
      }
      if (result is NavigationTarget) {
        if (context.mounted) context.go(result.path);
        return;
      }
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(result?.toString() ?? 'Action completed')),
        );
      }
    } catch (error) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString())),
      );
    }
  }
}

class NavigationTarget {
  const NavigationTarget(this.path);

  final String path;
}

class FeatureAction {
  const FeatureAction({
    required this.label,
    required this.icon,
    required this.run,
  });

  final String label;
  final IconData icon;
  final Future<Object?> Function(
      MobileBridge bridge, AppNetwork network, WalletSummary? wallet) run;
}

class _ContextPanel extends StatelessWidget {
  const _ContextPanel({
    required this.wallet,
    required this.network,
  });

  final WalletSummary? wallet;
  final AppNetwork network;

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Network: ${network.label}'),
            const SizedBox(height: 6),
            Text(wallet == null
                ? 'No active wallet'
                : 'Wallet: ${wallet!.publicKey}'),
          ],
        ),
      ),
    );
  }
}
