import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

const fnzBlue = Color(0xff3154d5);
const fnzOrange = Color(0xfff6851b);
const fnzInk = Color(0xff16181d);
const fnzCanvas = Color(0xfff6f7f9);

String compactAddress(String value, {int edge = 6}) {
  if (value.length <= edge * 2 + 3) return value;
  return '${value.substring(0, edge)}...${value.substring(value.length - edge)}';
}

IconData walletFamilyIcon(WalletFamily family) => switch (family) {
      WalletFamily.solana => Icons.blur_on_rounded,
      WalletFamily.evm => Icons.hexagon_outlined,
    };

class WalletScaffold extends StatelessWidget {
  const WalletScaffold({
    required this.currentIndex,
    required this.body,
    this.appBar,
    super.key,
  });

  final int currentIndex;
  final Widget body;
  final PreferredSizeWidget? appBar;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: appBar,
      body: body,
      bottomNavigationBar: NavigationBar(
        height: 68,
        selectedIndex: currentIndex,
        onDestinationSelected: (index) {
          const destinations = ['/', '/assets', '/browser', '/settings'];
          if (index != currentIndex) context.go(destinations[index]);
        },
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.account_balance_wallet_outlined),
            selectedIcon: Icon(Icons.account_balance_wallet),
            label: 'Wallet',
          ),
          NavigationDestination(
            icon: Icon(Icons.pie_chart_outline),
            selectedIcon: Icon(Icons.pie_chart),
            label: 'Assets',
          ),
          NavigationDestination(
            icon: Icon(Icons.language_outlined),
            selectedIcon: Icon(Icons.language),
            label: 'Browser',
          ),
          NavigationDestination(
            icon: Icon(Icons.settings_outlined),
            selectedIcon: Icon(Icons.settings),
            label: 'Settings',
          ),
        ],
      ),
    );
  }
}

class WalletContextBar extends ConsumerWidget implements PreferredSizeWidget {
  const WalletContextBar({super.key});

  @override
  Size get preferredSize => const Size.fromHeight(64);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final wallet = ref.watch(activeWalletProvider);
    final evmChain = ref.watch(activeEvmChainProvider);
    final network = ref.watch(activeNetworkProvider);

    return AppBar(
      automaticallyImplyLeading: false,
      titleSpacing: 16,
      title: Row(
        children: [
          const _BrandMark(),
          const SizedBox(width: 10),
          Expanded(
            child: InkWell(
              borderRadius: BorderRadius.circular(8),
              onTap: () => showWalletPicker(context, ref),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
                child: Row(
                  children: [
                    Icon(
                      wallet == null
                          ? Icons.account_balance_wallet_outlined
                          : walletFamilyIcon(wallet.family),
                      size: 22,
                    ),
                    const SizedBox(width: 8),
                    Flexible(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            wallet?.name ?? 'Select wallet',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          if (wallet != null)
                            Text(
                              compactAddress(wallet.publicKey),
                              maxLines: 1,
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                        ],
                      ),
                    ),
                    const Icon(Icons.keyboard_arrow_down, size: 18),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(width: 8),
          _NetworkButton(
            label: wallet?.family == WalletFamily.evm
                ? (evmChain?.name ?? 'Network')
                : network.label,
            family: wallet?.family ?? WalletFamily.solana,
            onTap: () => showNetworkPicker(context, ref),
          ),
        ],
      ),
    );
  }
}

class _BrandMark extends StatelessWidget {
  const _BrandMark();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 34,
      alignment: Alignment.center,
      decoration: const BoxDecoration(color: fnzInk, shape: BoxShape.circle),
      child: const Text(
        'F',
        style: TextStyle(
          color: Colors.white,
          fontSize: 17,
          fontWeight: FontWeight.w800,
        ),
      ),
    );
  }
}

class _NetworkButton extends StatelessWidget {
  const _NetworkButton({
    required this.label,
    required this.family,
    required this.onTap,
  });

  final String label;
  final WalletFamily family;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Switch network',
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(maxWidth: 120),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          decoration: BoxDecoration(
            border: Border.all(color: Theme.of(context).dividerColor),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: family == WalletFamily.evm ? fnzBlue : fnzOrange,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                      fontSize: 12, fontWeight: FontWeight.w700),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

Future<void> showWalletPicker(BuildContext context, WidgetRef ref) async {
  final wallets = await ref.read(storedWalletsProvider.future);
  if (!context.mounted) return;
  final active = ref.read(activeWalletProvider);

  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Accounts',
                style: Theme.of(sheetContext).textTheme.titleLarge),
            const SizedBox(height: 6),
            Text(
              'Choose the account used for assets, transfers and dApps.',
              style: Theme.of(sheetContext).textTheme.bodyMedium,
            ),
            const SizedBox(height: 12),
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 360),
              child: wallets.isEmpty
                  ? const ListTile(
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(Icons.account_balance_wallet_outlined),
                      title: Text('No wallet yet'),
                      subtitle:
                          Text('Create or import an account to continue.'),
                    )
                  : ListView.builder(
                      shrinkWrap: true,
                      itemCount: wallets.length,
                      itemBuilder: (sheetContext, index) {
                        final wallet = wallets[index];
                        final selected = wallet.id == active?.id;
                        return ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: CircleAvatar(
                            backgroundColor: selected
                                ? fnzBlue.withValues(alpha: 0.12)
                                : Theme.of(sheetContext)
                                    .colorScheme
                                    .surfaceContainerHighest,
                            child: Icon(
                              walletFamilyIcon(wallet.family),
                              color: selected ? fnzBlue : null,
                            ),
                          ),
                          title: Text(wallet.name),
                          subtitle: Text(
                            '${wallet.family.name.toUpperCase()}  ${compactAddress(wallet.publicKey)}',
                          ),
                          trailing: selected
                              ? const Icon(Icons.check_circle, color: fnzBlue)
                              : null,
                          onTap: () async {
                            await ref
                                .read(mobileWalletStoreProvider)
                                .setActiveWallet(wallet.id);
                            ref.read(activeWalletProvider.notifier).state =
                                wallet;
                            ref.invalidate(storedActiveWalletProvider);
                            if (sheetContext.mounted) {
                              Navigator.of(sheetContext).pop();
                            }
                          },
                        );
                      },
                    ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  context.go('/wallets');
                },
                icon: const Icon(Icons.settings_outlined),
                label: const Text('Manage accounts'),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

Future<void> showNetworkPicker(BuildContext context, WidgetRef ref) async {
  final wallet = ref.read(activeWalletProvider);
  if (wallet?.family == WalletFamily.evm) {
    final chains = await ref.read(evmChainsProvider.future);
    if (!context.mounted) return;
    final active = ref.read(activeEvmChainProvider);
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Select network',
                  style: Theme.of(sheetContext).textTheme.titleLarge),
              const SizedBox(height: 10),
              ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 440),
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final chain in chains)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        leading: const CircleAvatar(
                          backgroundColor: Color(0xffeef1ff),
                          child: Icon(Icons.hexagon_outlined, color: fnzBlue),
                        ),
                        title: Text(chain.name),
                        subtitle: Text(
                          '${chain.nativeSymbol} - Chain ID ${chain.chainId}${chain.testnet ? ' - Testnet' : ''}',
                        ),
                        trailing: active?.chainId == chain.chainId
                            ? const Icon(Icons.check_circle, color: fnzBlue)
                            : null,
                        onTap: () {
                          ref.read(activeEvmChainProvider.notifier).state =
                              chain;
                          Navigator.of(sheetContext).pop();
                        },
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
    return;
  }

  if (!context.mounted) return;
  final active = ref.read(activeNetworkProvider);
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Select network',
                style: Theme.of(sheetContext).textTheme.titleLarge),
            const SizedBox(height: 10),
            for (final network in AppNetwork.values)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const CircleAvatar(
                  backgroundColor: Color(0xfffff2e7),
                  child: Icon(Icons.blur_on_rounded, color: fnzOrange),
                ),
                title: Text('Solana ${network.label}'),
                trailing: active == network
                    ? const Icon(Icons.check_circle, color: fnzBlue)
                    : null,
                onTap: () {
                  ref.read(activeNetworkProvider.notifier).state = network;
                  Navigator.of(sheetContext).pop();
                },
              ),
          ],
        ),
      ),
    ),
  );
}

Future<void> showReceiveSheet(
  BuildContext context,
  WalletSummary wallet,
) async {
  await showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircleAvatar(
              radius: 28,
              backgroundColor: const Color(0xffeef1ff),
              child: Icon(
                walletFamilyIcon(wallet.family),
                size: 28,
                color: fnzBlue,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              'Receive to ${wallet.name}',
              style: Theme.of(sheetContext).textTheme.titleLarge,
            ),
            const SizedBox(height: 6),
            Text(
              wallet.family == WalletFamily.evm
                  ? 'Only send assets supported by the selected EVM network.'
                  : 'Only send Solana assets to this address.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 18),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Theme.of(sheetContext).colorScheme.surfaceContainerLow,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Theme.of(sheetContext).dividerColor),
              ),
              child: SelectableText(
                wallet.publicKey,
                textAlign: TextAlign.center,
                style:
                    const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
              ),
            ),
            const SizedBox(height: 14),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: () async {
                      await Clipboard.setData(
                        ClipboardData(text: wallet.publicKey),
                      );
                      if (sheetContext.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(content: Text('Address copied')),
                        );
                      }
                    },
                    icon: const Icon(Icons.copy_outlined),
                    label: const Text('Copy'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: () => SharePlus.instance.share(
                      ShareParams(
                        text: wallet.publicKey,
                        subject: 'FnzSafe receive address',
                      ),
                    ),
                    icon: const Icon(Icons.ios_share),
                    label: const Text('Share'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    ),
  );
}
