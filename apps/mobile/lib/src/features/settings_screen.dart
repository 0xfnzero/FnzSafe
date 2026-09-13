import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../ui/wallet_ui.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final capabilities = ref.watch(mobileCapabilitiesProvider);
    final session = ref.watch(mobileWalletSessionProvider);

    return WalletScaffold(
      currentIndex: 3,
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
        children: [
          _SettingsSection(
            title: 'Wallet',
            children: [
              ListTile(
                leading: const Icon(Icons.account_balance_wallet_outlined),
                title: const Text('Manage accounts'),
                subtitle:
                    const Text('Create, import, export and remove wallets'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.go('/wallets'),
              ),
              ListTile(
                leading: const Icon(Icons.security_outlined),
                title: const Text('Security & privacy'),
                subtitle: const Text('Biometrics, TOTP and signing controls'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.go('/security'),
              ),
              ListTile(
                leading: Icon(session.isUnlocked
                    ? Icons.lock_outline
                    : Icons.lock_clock_outlined),
                title:
                    Text(session.isUnlocked ? 'Lock wallet' : 'Wallet locked'),
                subtitle: Text(session.isUnlocked
                    ? 'Clear the encrypted password session now'
                    : 'Unlock an account to start a five-minute session'),
                onTap: session.isUnlocked
                    ? () {
                        ref.read(mobileWalletSessionProvider).lock();
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Wallet locked')),
                        );
                      }
                    : null,
              ),
            ],
          ),
          const SizedBox(height: 20),
          _SettingsSection(
            title: 'Connections',
            children: [
              ListTile(
                leading: const Icon(Icons.language_outlined),
                title: const Text('DApp browser'),
                subtitle: const Text('Review sites and wallet connections'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.go('/browser'),
              ),
              ListTile(
                leading: const Icon(Icons.hub_outlined),
                title: const Text('Networks'),
                subtitle: const Text('Solana clusters and custom EVM networks'),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => context.go('/assets'),
              ),
            ],
          ),
          const SizedBox(height: 20),
          const _SettingsSection(
            title: 'Recovery',
            children: [
              ListTile(
                leading: Icon(Icons.cloud_off_outlined),
                title: Text('Social recovery'),
                subtitle: Text(
                  'Off by default - requires an approved MPC provider configuration',
                ),
                trailing: Icon(Icons.lock_outline),
              ),
              ListTile(
                leading: Icon(Icons.key_outlined),
                title: Text('Local recovery phrase'),
                subtitle:
                    Text('Remains under your control and is never uploaded'),
              ),
            ],
          ),
          const SizedBox(height: 20),
          _SettingsSection(
            title: 'About',
            children: [
              ListTile(
                leading: const Icon(Icons.health_and_safety_outlined),
                title: const Text('Native bridge'),
                subtitle: capabilities.when(
                  data: (value) =>
                      Text('${value.enabled.length} capabilities available'),
                  error: (error, stackTrace) =>
                      const Text('Bridge unavailable'),
                  loading: () => const Text('Checking...'),
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () async {
                  final result = await ref.read(mobileBridgeProvider).health();
                  if (!context.mounted) return;
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text(result.toString())),
                  );
                },
              ),
              const ListTile(
                leading: Icon(Icons.info_outline),
                title: Text('FnzSafe Mobile'),
                subtitle: Text('Self-custody multichain wallet'),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SettingsSection extends StatelessWidget {
  const _SettingsSection({required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 8),
          child: Text(
            title,
            style: Theme.of(context).textTheme.labelLarge?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
        ),
        Material(
          color: Theme.of(context).colorScheme.surface,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(8),
            side: BorderSide(color: Theme.of(context).dividerColor),
          ),
          clipBehavior: Clip.antiAlias,
          child: Column(children: children),
        ),
      ],
    );
  }
}
