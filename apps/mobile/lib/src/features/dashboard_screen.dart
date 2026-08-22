import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../bridge/mobile_bridge_provider.dart';

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  static const _items = [
    _DashboardItem('Lock', '/lock', Icons.lock_outline),
    _DashboardItem(
        'Wallets', '/wallets', Icons.account_balance_wallet_outlined),
    _DashboardItem('Assets', '/assets', Icons.pie_chart_outline),
    _DashboardItem('Send', '/send', Icons.swap_horiz),
    _DashboardItem('Security', '/security', Icons.verified_user_outlined),
    _DashboardItem('Pump Trading', '/trading', Icons.show_chart),
    _DashboardItem('dApps', '/dapps', Icons.public),
    _DashboardItem('Squads', '/squads', Icons.groups_2_outlined),
    _DashboardItem('Settings', '/settings', Icons.settings_outlined),
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final capabilities = ref.watch(mobileCapabilitiesProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('FnzSafe'),
        centerTitle: false,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Mobile Wallet',
              style: Theme.of(context).textTheme.headlineMedium),
          const SizedBox(height: 8),
          Text(
            'iOS and Android wallet surface powered by Flutter and the shared Rust core.',
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 16),
          capabilities.when(
            data: (value) => Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final capability in value.enabled)
                  Chip(label: Text(capability.replaceAll('_', ' '))),
              ],
            ),
            error: (error, stackTrace) => Text(error.toString()),
            loading: () => const LinearProgressIndicator(),
          ),
          const SizedBox(height: 20),
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 220,
              mainAxisSpacing: 12,
              crossAxisSpacing: 12,
              childAspectRatio: 1.35,
            ),
            itemCount: _items.length,
            itemBuilder: (context, index) {
              final item = _items[index];
              return Card(
                child: InkWell(
                  borderRadius: BorderRadius.circular(8),
                  onTap: () => context.go(item.path),
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Icon(item.icon),
                        const Spacer(),
                        Text(item.title,
                            style: Theme.of(context).textTheme.titleMedium),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
          const SizedBox(height: 20),
          Text('Excluded from mobile v1',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          capabilities.maybeWhen(
            data: (value) => Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final capability in value.excluded)
                  Chip(label: Text(capability.replaceAll('_', ' '))),
              ],
            ),
            orElse: () => const SizedBox.shrink(),
          ),
        ],
      ),
    );
  }
}

class _DashboardItem {
  const _DashboardItem(this.title, this.path, this.icon);

  final String title;
  final String path;
  final IconData icon;
}
