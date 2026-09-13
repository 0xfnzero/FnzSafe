import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';
import '../ui/wallet_ui.dart';

class DashboardScreen extends ConsumerStatefulWidget {
  const DashboardScreen({super.key});

  @override
  ConsumerState<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends ConsumerState<DashboardScreen> {
  AssetSnapshot? _solana;
  EvmAssetSnapshot? _evm;
  Object? _error;
  bool _loading = false;
  int _tab = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _refresh());
  }

  @override
  Widget build(BuildContext context) {
    final wallet = ref.watch(activeWalletProvider);
    final network = ref.watch(activeNetworkProvider);
    final evmChain = ref.watch(activeEvmChainProvider);

    ref.listen(activeWalletProvider, (previous, next) {
      if (previous?.id != next?.id) unawaited(_refresh());
    });
    ref.listen(activeNetworkProvider, (previous, next) {
      if (previous != next) unawaited(_refresh());
    });
    ref.listen(activeEvmChainProvider, (previous, next) {
      if (previous?.chainId != next?.chainId) unawaited(_refresh());
    });

    return WalletScaffold(
      currentIndex: 0,
      appBar: const WalletContextBar(),
      body: RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
          children: [
            if (wallet == null)
              _EmptyWallet(onCreate: () => context.go('/wallets'))
            else ...[
              _BalanceHeader(
                wallet: wallet,
                balance: _balanceLabel(wallet, evmChain),
                networkLabel: wallet.family == WalletFamily.evm
                    ? (evmChain?.name ?? 'Select an EVM network')
                    : 'Solana ${network.label}',
                loading: _loading,
                onReceive: () => showReceiveSheet(context, wallet),
              ),
              const SizedBox(height: 22),
              _ActionRow(
                onSend: () => context.go('/send'),
                onReceive: () => showReceiveSheet(context, wallet),
                onBrowser: () => context.go('/browser'),
                onMore: () => context.go('/wallets'),
              ),
              const SizedBox(height: 24),
              SegmentedButton<int>(
                showSelectedIcon: false,
                segments: const [
                  ButtonSegment(value: 0, label: Text('Tokens')),
                  ButtonSegment(value: 1, label: Text('Activity')),
                ],
                selected: {_tab},
                onSelectionChanged: (value) {
                  setState(() => _tab = value.first);
                },
              ),
              const SizedBox(height: 14),
              if (_error != null)
                _InlineError(error: _error!, onRetry: _refresh)
              else if (_tab == 0)
                _TokenList(solana: _solana, evm: _evm, loading: _loading)
              else
                _ActivityList(solana: _solana, evm: _evm, loading: _loading),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _refresh() async {
    final wallet = ref.read(activeWalletProvider);
    if (wallet == null || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      if (wallet.family == WalletFamily.evm) {
        final chain = ref.read(activeEvmChainProvider);
        if (chain == null) return;
        final contracts =
            await ref.read(mobileWalletStoreProvider).loadCustomEvmTokens(
                  chainId: chain.chainId,
                  walletAddress: wallet.publicKey,
                );
        final snapshot = await ref.read(mobileBridgeProvider).loadEvmAssets(
              chain: chain,
              walletAddress: wallet.publicKey,
              tokenContracts: contracts,
            );
        if (!mounted) return;
        setState(() {
          _evm = snapshot;
          _solana = null;
        });
      } else {
        final snapshot = await ref.read(mobileBridgeProvider).loadAssets(
              network: ref.read(activeNetworkProvider),
              walletPublicKey: wallet.publicKey,
            );
        if (!mounted) return;
        setState(() {
          _solana = snapshot;
          _evm = null;
        });
      }
    } catch (error) {
      if (mounted) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _balanceLabel(WalletSummary wallet, EvmChainConfig? chain) {
    if (wallet.family == WalletFamily.evm) {
      final wei = BigInt.tryParse(_evm?.nativeBalanceWei ?? '0') ?? BigInt.zero;
      return '${_formatUnits(wei, 18)} ${chain?.nativeSymbol ?? ''}'.trim();
    }
    final amount = (_solana?.solBalanceLamports ?? 0) / 1000000000;
    return '${NumberFormat('#,##0.#########').format(amount)} SOL';
  }

  String _formatUnits(BigInt value, int decimals) {
    final text = value.toString().padLeft(decimals + 1, '0');
    final whole = text.substring(0, text.length - decimals);
    final fraction =
        text.substring(text.length - decimals).replaceFirst(RegExp(r'0+$'), '');
    final visible = fraction.length > 8 ? fraction.substring(0, 8) : fraction;
    return visible.isEmpty ? whole : '$whole.$visible';
  }
}

class _EmptyWallet extends StatelessWidget {
  const _EmptyWallet({required this.onCreate});

  final VoidCallback onCreate;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 72),
      child: Column(
        children: [
          const CircleAvatar(
            radius: 38,
            backgroundColor: Color(0xffeef1ff),
            child: Icon(
              Icons.account_balance_wallet_outlined,
              size: 36,
              color: fnzBlue,
            ),
          ),
          const SizedBox(height: 18),
          Text(
            'Your wallet starts here',
            style: Theme.of(context).textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(
            'Create or import a Solana or EVM account. Bitcoin and TRON remain read-only until transaction support is available.',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          const SizedBox(height: 20),
          FilledButton.icon(
            onPressed: onCreate,
            icon: const Icon(Icons.add),
            label: const Text('Add wallet'),
          ),
        ],
      ),
    );
  }
}

class _BalanceHeader extends StatelessWidget {
  const _BalanceHeader({
    required this.wallet,
    required this.balance,
    required this.networkLabel,
    required this.loading,
    required this.onReceive,
  });

  final WalletSummary wallet;
  final String balance;
  final String networkLabel;
  final bool loading;
  final VoidCallback onReceive;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text(networkLabel, style: Theme.of(context).textTheme.labelLarge),
        const SizedBox(height: 8),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 180),
          child: Text(
            loading ? 'Refreshing...' : balance,
            key: ValueKey('$loading-$balance'),
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineMedium?.copyWith(
                  fontWeight: FontWeight.w800,
                ),
          ),
        ),
        const SizedBox(height: 8),
        TextButton.icon(
          onPressed: onReceive,
          icon: const Icon(Icons.copy_outlined, size: 16),
          label: Text(compactAddress(wallet.publicKey, edge: 8)),
        ),
      ],
    );
  }
}

class _ActionRow extends StatelessWidget {
  const _ActionRow({
    required this.onSend,
    required this.onReceive,
    required this.onBrowser,
    required this.onMore,
  });

  final VoidCallback onSend;
  final VoidCallback onReceive;
  final VoidCallback onBrowser;
  final VoidCallback onMore;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceAround,
      children: [
        _WalletAction(icon: Icons.north_east, label: 'Send', onTap: onSend),
        _WalletAction(
          icon: Icons.south_west,
          label: 'Receive',
          onTap: onReceive,
        ),
        _WalletAction(icon: Icons.language, label: 'DApps', onTap: onBrowser),
        _WalletAction(icon: Icons.more_horiz, label: 'More', onTap: onMore),
      ],
    );
  }
}

class _WalletAction extends StatelessWidget {
  const _WalletAction({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: 72,
      child: Column(
        children: [
          IconButton.filled(
            tooltip: label,
            onPressed: onTap,
            icon: Icon(icon),
          ),
          const SizedBox(height: 4),
          Text(label, style: Theme.of(context).textTheme.labelMedium),
        ],
      ),
    );
  }
}

class _TokenList extends StatelessWidget {
  const _TokenList({
    required this.solana,
    required this.evm,
    required this.loading,
  });

  final AssetSnapshot? solana;
  final EvmAssetSnapshot? evm;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    if (loading && solana == null && evm == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(28),
          child: CircularProgressIndicator(),
        ),
      );
    }
    if (solana == null && evm == null) {
      return const _EmptyList(
        icon: Icons.token_outlined,
        title: 'No asset data yet',
        message: 'Pull down to refresh your balances.',
      );
    }
    final evmItems = evm?.tokens ?? const <EvmTokenAsset>[];
    final solanaItems = solana?.tokens ?? const <TokenAsset>[];
    if (evmItems.isEmpty && solanaItems.isEmpty) {
      return const _EmptyList(
        icon: Icons.token_outlined,
        title: 'No tokens found',
        message:
            'Your native balance appears above. Add custom tokens from Assets.',
      );
    }
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(8),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          for (final token in solanaItems)
            ListTile(
              leading: _TokenAvatar(token.symbol),
              title: Text(token.symbol),
              subtitle: Text(token.name),
              trailing: Text(
                token.amount,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
          for (final token in evmItems)
            ListTile(
              leading: _TokenAvatar(token.symbol),
              title: Text(token.symbol),
              subtitle: Text(token.name),
              trailing: Text(
                token.balance,
                style: const TextStyle(fontWeight: FontWeight.w700),
              ),
            ),
        ],
      ),
    );
  }
}

class _TokenAvatar extends StatelessWidget {
  const _TokenAvatar(this.symbol);

  final String symbol;

  @override
  Widget build(BuildContext context) {
    final initial =
        symbol.trim().isEmpty ? '?' : symbol.trim()[0].toUpperCase();
    return CircleAvatar(child: Text(initial));
  }
}

class _ActivityList extends StatelessWidget {
  const _ActivityList({
    required this.solana,
    required this.evm,
    required this.loading,
  });

  final AssetSnapshot? solana;
  final EvmAssetSnapshot? evm;
  final bool loading;

  @override
  Widget build(BuildContext context) {
    final solanaItems =
        solana?.recentTransactions ?? const <TransactionHistoryEntry>[];
    final evmItems =
        evm?.recentTransactions ?? const <EvmTransactionHistoryEntry>[];
    if (loading && solana == null && evm == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(28),
          child: CircularProgressIndicator(),
        ),
      );
    }
    if (solanaItems.isEmpty && evmItems.isEmpty) {
      return const _EmptyList(
        icon: Icons.receipt_long_outlined,
        title: 'No activity yet',
        message: 'Confirmed transactions will appear here.',
      );
    }
    return Material(
      color: Theme.of(context).colorScheme.surface,
      borderRadius: BorderRadius.circular(8),
      clipBehavior: Clip.antiAlias,
      child: Column(
        children: [
          for (final entry in solanaItems)
            ListTile(
              leading: const CircleAvatar(child: Icon(Icons.swap_horiz)),
              title: Text(entry.status),
              subtitle: Text(compactAddress(entry.signature, edge: 8)),
              trailing: Text('Slot ${entry.slot}'),
            ),
          for (final entry in evmItems)
            ListTile(
              leading: const CircleAvatar(child: Icon(Icons.swap_horiz)),
              title: Text(entry.status),
              subtitle: Text(compactAddress(entry.hash, edge: 8)),
              trailing: Text(
                entry.blockNumber == null ? 'Pending' : '#${entry.blockNumber}',
              ),
            ),
        ],
      ),
    );
  }
}

class _EmptyList extends StatelessWidget {
  const _EmptyList({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 30, horizontal: 18),
      child: Column(
        children: [
          Icon(
            icon,
            size: 34,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
          const SizedBox(height: 10),
          Text(title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.error, required this.onRetry});

  final Object error;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Theme.of(context).colorScheme.errorContainer,
      borderRadius: BorderRadius.circular(8),
      child: ListTile(
        leading: const Icon(Icons.error_outline),
        title: const Text('Could not refresh wallet'),
        subtitle: Text(
          error.toString(),
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
        trailing: IconButton(
          tooltip: 'Retry',
          onPressed: onRetry,
          icon: const Icon(Icons.refresh),
        ),
      ),
    );
  }
}
