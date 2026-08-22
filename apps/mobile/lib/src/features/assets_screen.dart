import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class AssetsScreen extends ConsumerStatefulWidget {
  const AssetsScreen({super.key});

  @override
  ConsumerState<AssetsScreen> createState() => _AssetsScreenState();
}

class _AssetsScreenState extends ConsumerState<AssetsScreen> {
  final _tokenController = TextEditingController();
  AssetSnapshot? _snapshot;
  EvmAssetSnapshot? _evmSnapshot;
  Object? _error;
  bool _loading = false;
  Set<int> _customEvmChainIds = const {};
  final _evmAddressPattern = RegExp(r'^0x[0-9a-fA-F]{40}$');

  @override
  void initState() {
    super.initState();
    _loadCustomEvmChainIds();
  }

  @override
  void dispose() {
    _tokenController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final wallet = ref.watch(activeWalletProvider);
    final network = ref.watch(activeNetworkProvider);
    final chains = ref.watch(evmChainsProvider);
    final evmChain = ref.watch(activeEvmChainProvider);
    final isEvm = wallet?.family == WalletFamily.evm;
    final customChainIds = chains.maybeWhen(
      data: (items) => items
          .where((chain) => _customEvmChainIds.contains(chain.chainId))
          .map((chain) => chain.chainId)
          .toSet(),
      orElse: () => _customEvmChainIds,
    );
    final canDeleteActiveChain =
        evmChain != null && customChainIds.contains(evmChain.chainId);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/'),
        ),
        title: const Text('Assets'),
        actions: [
          IconButton(
            tooltip: 'Refresh',
            icon: const Icon(Icons.refresh),
            onPressed: wallet == null || _loading
                ? null
                : () => isEvm
                    ? _refreshEvm(wallet, evmChain)
                    : _refresh(wallet, network),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (wallet == null)
            const Card(
              child: ListTile(
                leading: Icon(Icons.account_balance_wallet_outlined),
                title: Text('Select or create a wallet first'),
              ),
            )
          else
            Card(
              child: ListTile(
                leading: const Icon(Icons.account_balance_wallet_outlined),
                title: Text(wallet.name),
                subtitle: Text(
                    '${wallet.family.name.toUpperCase()}  ${wallet.publicKey}'),
              ),
            ),
          if (isEvm) ...[
            const SizedBox(height: 16),
            chains.when(
              data: (items) => DropdownButtonFormField<EvmChainConfig>(
                initialValue: evmChain,
                decoration: const InputDecoration(
                  labelText: 'EVM chain',
                  border: OutlineInputBorder(),
                ),
                items: [
                  for (final chain in items)
                    DropdownMenuItem(
                      value: chain,
                      child: Text(chain.label),
                    ),
                ],
                onChanged: (value) {
                  ref.read(activeEvmChainProvider.notifier).state = value;
                  _evmSnapshot = null;
                },
              ),
              error: (error, stackTrace) => Text(error.toString()),
              loading: () => const LinearProgressIndicator(),
            ),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                OutlinedButton.icon(
                  icon: const Icon(Icons.add_link),
                  label: const Text('Add chain'),
                  onPressed: _showAddChainDialog,
                ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.delete_outline),
                  label: const Text('Delete custom chain'),
                  onPressed: !canDeleteActiveChain
                      ? null
                      : () => _deleteCustomChain(evmChain.chainId),
                ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.add_circle_outline),
                  label: const Text('Add ERC-20'),
                  onPressed: wallet == null || evmChain == null
                      ? null
                      : () => _showAddTokenDialog(wallet, evmChain),
                ),
              ],
            ),
          ],
          const SizedBox(height: 16),
          if (_loading) const LinearProgressIndicator(),
          if (_error != null) ...[
            Card(
              child: ListTile(
                leading: const Icon(Icons.error_outline),
                title: const Text('Asset refresh failed'),
                subtitle: Text(_error.toString()),
              ),
            ),
            const SizedBox(height: 16),
          ],
          if (_evmSnapshot != null) ...[
            Text(_evmSnapshot!.chain.nativeSymbol,
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Card(
              child: ListTile(
                leading: const Icon(Icons.hexagon_outlined),
                title: Text('${_evmSnapshot!.nativeBalanceWei} wei'),
                subtitle: Text('${_evmSnapshot!.chain.label} balance'),
              ),
            ),
            const SizedBox(height: 20),
            Text('ERC-20 tokens',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (_evmSnapshot!.tokens.isEmpty)
              const Text('No ERC-20 token contracts configured for this chain.')
            else
              for (final token in _evmSnapshot!.tokens)
                Card(
                  child: ListTile(
                    title: Text('${token.symbol}  ${token.balance}'),
                    subtitle: Text(
                        '${token.name}\n${token.contractAddress}\n${token.decimals} decimals'),
                    isThreeLine: true,
                    trailing: IconButton(
                      tooltip: 'Remove token',
                      icon: const Icon(Icons.delete_outline),
                      onPressed: () => _deleteCustomToken(
                        _evmSnapshot!.walletAddress,
                        _evmSnapshot!.chain,
                        token.contractAddress,
                      ),
                    ),
                  ),
                ),
            const SizedBox(height: 20),
            Text('Recent transactions',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (_evmSnapshot!.historyStatus != 'ok')
              Text(_evmSnapshot!.historyMessage ??
                  'Current RPC or explorer does not support history queries.')
            else if (_evmSnapshot!.recentTransactions.isEmpty)
              const Text('No recent EVM transactions found.')
            else
              for (final entry in _evmSnapshot!.recentTransactions)
                Card(
                  child: ListTile(
                    title: Text(entry.status),
                    subtitle: Text(
                        '${entry.hash}\nblock ${entry.blockNumber ?? '-'}'),
                    isThreeLine: true,
                  ),
                ),
          ] else if (_snapshot != null) ...[
            Text('SOL', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            Card(
              child: ListTile(
                leading: const Icon(Icons.currency_exchange),
                title: Text(_formatSol(_snapshot!.solBalanceLamports)),
                subtitle: Text('${_snapshot!.network.label} balance'),
              ),
            ),
            const SizedBox(height: 20),
            Text('Tokens', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (_snapshot!.tokens.isEmpty)
              const Text('No SPL token accounts with non-zero balance.')
            else
              for (final token in _snapshot!.tokens)
                Card(
                  child: ListTile(
                    title: Text('${token.symbol}  ${token.amount}'),
                    subtitle: Text(
                        '${token.name}\n${token.mint}\nATA ${token.tokenAccount}'),
                    isThreeLine: true,
                  ),
                ),
            const SizedBox(height: 20),
            Text('Recent transactions',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (_snapshot!.recentTransactions.isEmpty)
              const Text('No recent signatures found.')
            else
              for (final entry in _snapshot!.recentTransactions)
                Card(
                  child: ListTile(
                    title: Text(entry.status),
                    subtitle: Text(
                        '${entry.signature}\nslot ${entry.slot}${_blockTime(entry)}'),
                    isThreeLine: true,
                  ),
                ),
          ],
        ],
      ),
    );
  }

  Future<void> _refresh(WalletSummary wallet, AppNetwork network) async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final snapshot = await ref
          .read(mobileBridgeProvider)
          .loadAssets(network: network, walletPublicKey: wallet.publicKey);
      if (!mounted) return;
      setState(() {
        _snapshot = snapshot;
        _evmSnapshot = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _refreshEvm(WalletSummary wallet, EvmChainConfig? chain) async {
    if (chain == null) {
      setState(() => _error = 'Select an EVM chain first');
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final tokenContracts = await ref
          .read(mobileWalletStoreProvider)
          .loadCustomEvmTokens(
              chainId: chain.chainId, walletAddress: wallet.publicKey);
      final snapshot = await ref.read(mobileBridgeProvider).loadEvmAssets(
            chain: chain,
            walletAddress: wallet.publicKey,
            tokenContracts: tokenContracts,
          );
      if (!mounted) return;
      setState(() {
        _evmSnapshot = snapshot;
        _snapshot = null;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _formatSol(int lamports) {
    final sol = lamports / 1000000000;
    return '${NumberFormat('#,##0.#########').format(sol)} SOL';
  }

  String _blockTime(TransactionHistoryEntry entry) {
    final blockTime = entry.blockTime;
    if (blockTime == null) return '';
    final time =
        DateTime.fromMillisecondsSinceEpoch(blockTime * 1000, isUtc: true);
    return ' - ${DateFormat.yMd().add_Hm().format(time.toLocal())}';
  }

  Future<void> _showAddTokenDialog(
    WalletSummary wallet,
    EvmChainConfig chain,
  ) async {
    _tokenController.clear();
    final contract = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Add ERC-20 token'),
        content: TextField(
          controller: _tokenController,
          decoration: const InputDecoration(
            labelText: 'Contract address',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () =>
                Navigator.of(context).pop(_tokenController.text.trim()),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (contract == null || contract.isEmpty) return;
    if (!_evmAddressPattern.hasMatch(contract)) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('ERC-20 contract must be a 20-byte 0x EVM address'),
        ),
      );
      return;
    }
    await ref.read(mobileWalletStoreProvider).saveCustomEvmToken(
          chainId: chain.chainId,
          walletAddress: wallet.publicKey,
          contractAddress: contract,
        );
    if (mounted) await _refreshEvm(wallet, chain);
  }

  Future<void> _showAddChainDialog() async {
    final chainIdController = TextEditingController();
    final nameController = TextEditingController();
    final symbolController = TextEditingController();
    final rpcController = TextEditingController();
    final explorerController = TextEditingController();
    var testnet = true;

    try {
      final chain = await showDialog<EvmChainConfig>(
        context: context,
        builder: (context) => StatefulBuilder(
          builder: (context, setDialogState) => AlertDialog(
            title: const Text('Add EVM chain'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  TextField(
                    controller: chainIdController,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(
                      labelText: 'Chain ID',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: nameController,
                    decoration: const InputDecoration(
                      labelText: 'Name',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: symbolController,
                    decoration: const InputDecoration(
                      labelText: 'Native symbol',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: rpcController,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(
                      labelText: 'RPC URL',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 10),
                  TextField(
                    controller: explorerController,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(
                      labelText: 'Explorer URL (optional)',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Testnet'),
                    value: testnet,
                    onChanged: (value) => setDialogState(() => testnet = value),
                  ),
                ],
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () {
                  final chainId = int.tryParse(chainIdController.text.trim());
                  final name = nameController.text.trim();
                  final symbol = symbolController.text.trim();
                  final rpc = rpcController.text.trim();
                  final explorer = explorerController.text.trim();
                  if (chainId == null ||
                      chainId <= 0 ||
                      name.isEmpty ||
                      symbol.isEmpty ||
                      !rpc.startsWith(RegExp(r'https?://')) ||
                      (explorer.isNotEmpty &&
                          !explorer.startsWith(RegExp(r'https?://')))) {
                    return;
                  }
                  Navigator.of(context).pop(EvmChainConfig(
                    chainId: chainId,
                    name: name,
                    nativeSymbol: symbol,
                    rpcUrl: rpc,
                    explorerUrl: explorer.isEmpty ? null : explorer,
                    testnet: testnet,
                  ));
                },
                child: const Text('Save'),
              ),
            ],
          ),
        ),
      );
      if (chain == null) return;
      await ref.read(mobileWalletStoreProvider).saveCustomEvmChain(chain);
      await _loadCustomEvmChainIds();
      ref.invalidate(evmChainsProvider);
      ref.read(activeEvmChainProvider.notifier).state = chain;
      if (mounted) setState(() => _evmSnapshot = null);
    } finally {
      chainIdController.dispose();
      nameController.dispose();
      symbolController.dispose();
      rpcController.dispose();
      explorerController.dispose();
    }
  }

  Future<void> _deleteCustomChain(int chainId) async {
    await ref.read(mobileWalletStoreProvider).deleteCustomEvmChain(chainId);
    await _loadCustomEvmChainIds();
    ref.invalidate(evmChainsProvider);
    ref.read(activeEvmChainProvider.notifier).state = null;
    if (mounted) setState(() => _evmSnapshot = null);
  }

  Future<void> _loadCustomEvmChainIds() async {
    final chains =
        await ref.read(mobileWalletStoreProvider).loadCustomEvmChains();
    if (!mounted) return;
    setState(() {
      _customEvmChainIds = {for (final chain in chains) chain.chainId};
    });
  }

  Future<void> _deleteCustomToken(
    String walletAddress,
    EvmChainConfig chain,
    String contractAddress,
  ) async {
    await ref.read(mobileWalletStoreProvider).deleteCustomEvmToken(
          chainId: chain.chainId,
          walletAddress: walletAddress,
          contractAddress: contractAddress,
        );
    final wallet = ref.read(activeWalletProvider);
    if (mounted && wallet != null) await _refreshEvm(wallet, chain);
  }
}
