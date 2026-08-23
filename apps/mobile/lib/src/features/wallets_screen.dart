import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:share_plus/share_plus.dart';

import '../bridge/mobile_bridge.dart';
import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class WalletsScreen extends ConsumerStatefulWidget {
  const WalletsScreen({super.key});

  @override
  ConsumerState<WalletsScreen> createState() => _WalletsScreenState();
}

class _WalletsScreenState extends ConsumerState<WalletsScreen> {
  final _nameController = TextEditingController(text: 'Mobile Wallet');
  final _passwordController = TextEditingController();
  final _secretController = TextEditingController();
  final _derivationPathController =
      TextEditingController(text: "m/44'/501'/0'/0'");
  WalletFamily _family = WalletFamily.solana;
  String _mode = 'create';
  bool _busy = false;

  @override
  void dispose() {
    _nameController.dispose();
    _passwordController.dispose();
    _secretController.dispose();
    _derivationPathController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final wallets = ref.watch(storedWalletsProvider);
    final activeWallet = ref.watch(activeWalletProvider);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/'),
        ),
        title: const Text('Wallets'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(
                  value: 'create',
                  icon: Icon(Icons.add),
                  label: Text('Create')),
              ButtonSegment(
                  value: 'keystore',
                  icon: Icon(Icons.upload_file),
                  label: Text('Keystore')),
              ButtonSegment(
                  value: 'private_key',
                  icon: Icon(Icons.key),
                  label: Text('Private key')),
              ButtonSegment(
                  value: 'mnemonic',
                  icon: Icon(Icons.subject),
                  label: Text('Mnemonic')),
            ],
            selected: {_mode},
            onSelectionChanged: (value) => setState(() => _mode = value.first),
          ),
          const SizedBox(height: 12),
          SegmentedButton<WalletFamily>(
            segments: const [
              ButtonSegment(
                value: WalletFamily.solana,
                icon: Icon(Icons.token),
                label: Text('Solana'),
              ),
              ButtonSegment(
                value: WalletFamily.evm,
                icon: Icon(Icons.hexagon_outlined),
                label: Text('EVM'),
              ),
            ],
            selected: {_family},
            onSelectionChanged: (value) {
              final family = value.first;
              setState(() {
                _family = family;
                _derivationPathController.text = family == WalletFamily.evm
                    ? "m/44'/60'/0'/0/0"
                    : "m/44'/501'/0'/0'";
              });
            },
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _nameController,
            decoration: const InputDecoration(
                labelText: 'Wallet name', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _passwordController,
            obscureText: true,
            enableSuggestions: false,
            autocorrect: false,
            decoration: const InputDecoration(
                labelText: 'Password', border: OutlineInputBorder()),
          ),
          if (_mode != 'create') ...[
            const SizedBox(height: 12),
            TextField(
              controller: _secretController,
              minLines: _mode == 'private_key' ? 1 : 4,
              maxLines: _mode == 'private_key' ? 1 : 8,
              obscureText: _mode == 'private_key',
              enableSuggestions: false,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: switch (_mode) {
                  'keystore' => 'Keystore JSON',
                  'private_key' => _family == WalletFamily.evm
                      ? 'Private key hex'
                      : 'Private key base58',
                  _ => 'Mnemonic',
                },
                border: const OutlineInputBorder(),
              ),
            ),
          ],
          if (_mode == 'mnemonic') ...[
            const SizedBox(height: 12),
            TextField(
              controller: _derivationPathController,
              decoration: const InputDecoration(
                labelText: 'Derivation path',
                border: OutlineInputBorder(),
              ),
            ),
          ],
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              FilledButton.icon(
                onPressed: _busy ? null : _submit,
                icon: Icon(_mode == 'create' ? Icons.add : Icons.download),
                label: Text(_busy
                    ? 'Working'
                    : (_mode == 'create' ? 'Create wallet' : 'Import wallet')),
              ),
              if (_mode == 'keystore')
                OutlinedButton.icon(
                  onPressed: _busy ? null : _pickKeystore,
                  icon: const Icon(Icons.folder_open),
                  label: const Text('Choose file'),
                ),
              OutlinedButton.icon(
                onPressed: activeWallet == null || _busy
                    ? null
                    : () => _unlock(activeWallet),
                icon: const Icon(Icons.lock_open),
                label: const Text('Unlock active'),
              ),
              OutlinedButton.icon(
                onPressed: activeWallet == null || _busy
                    ? null
                    : () => _exportPrivateKey(activeWallet),
                icon: const Icon(Icons.ios_share),
                label: const Text('Export private key'),
              ),
            ],
          ),
          const SizedBox(height: 24),
          Text('Stored wallets',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          wallets.when(
            data: (items) {
              if (items.isEmpty) return const Text('No local wallets yet.');
              return Column(
                children: [
                  for (final wallet in items)
                    Card(
                      child: ListTile(
                        leading: Icon(
                          wallet.id == activeWallet?.id
                              ? Icons.radio_button_checked
                              : Icons.account_balance_wallet_outlined,
                        ),
                        title: Text(wallet.name),
                        subtitle: Text(
                          '${wallet.family.name.toUpperCase()}  ${wallet.publicKey}',
                        ),
                        onTap: () => _setActive(wallet),
                        trailing: IconButton(
                          tooltip: 'Delete',
                          icon: const Icon(Icons.delete_outline),
                          onPressed: _busy ? null : () => _delete(wallet),
                        ),
                      ),
                    ),
                ],
              );
            },
            error: (error, stackTrace) => Text(error.toString()),
            loading: () => const LinearProgressIndicator(),
          ),
        ],
      ),
    );
  }

  Future<void> _pickKeystore() async {
    final result = await FilePicker.platform.pickFiles(withData: true);
    final file = result?.files.single;
    final bytes = file?.bytes;
    if (bytes == null) return;
    _secretController.text = String.fromCharCodes(bytes);
  }

  Future<void> _submit() async {
    await _run(() async {
      final bridge = ref.read(mobileBridgeProvider);
      final password = _passwordController.text;
      final created = _family == WalletFamily.evm
          ? await _submitEvm(bridge, password)
          : await _submitSolana(bridge, password);
      await ref.read(mobileWalletStoreProvider).saveWalletKeystore(created);
      ref.read(activeWalletProvider.notifier).state = created.wallet;
      ref.invalidate(storedWalletsProvider);
      ref.invalidate(storedActiveWalletProvider);
      _secretController.clear();
      _passwordController.clear();
      _show('Active wallet: ${created.wallet.name}');
    });
  }

  Future<void> _unlock(WalletSummary wallet) async {
    await _run(() async {
      final keystoreJson =
          await ref.read(mobileWalletStoreProvider).readKeystoreJson(wallet.id);
      final unlocked = wallet.family == WalletFamily.evm
          ? await ref.read(mobileBridgeProvider).unlockEvmWallet(
              keystoreJson: keystoreJson, password: _passwordController.text)
          : await ref.read(mobileBridgeProvider).unlockWallet(
              keystoreJson: keystoreJson, password: _passwordController.text);
      ref.read(activeWalletProvider.notifier).state = WalletSummary(
        id: wallet.id,
        name: wallet.name,
        publicKey: unlocked.publicKey,
        family: wallet.family,
        derivationPath: unlocked.derivationPath ?? wallet.derivationPath,
      );
      _passwordController.clear();
      _show('Unlocked ${wallet.name}');
    });
  }

  Future<void> _exportPrivateKey(WalletSummary wallet) async {
    await _run(() async {
      final keystoreJson =
          await ref.read(mobileWalletStoreProvider).readKeystoreJson(wallet.id);
      final exportedText = wallet.family == WalletFamily.evm
          ? (await ref.read(mobileBridgeProvider).exportEvmPrivateKey(
                  keystoreJson: keystoreJson,
                  password: _passwordController.text))
              .privateKeyHex
          : (await ref.read(mobileBridgeProvider).exportPrivateKey(
                  keystoreJson: keystoreJson,
                  password: _passwordController.text))
              .privateKeyBase58;
      await SharePlus.instance.share(
        ShareParams(
          text: exportedText,
          subject: 'FnzSafe private key export',
        ),
      );
      _passwordController.clear();
    });
  }

  Future<void> _setActive(WalletSummary wallet) async {
    await ref.read(mobileWalletStoreProvider).setActiveWallet(wallet.id);
    ref.read(activeWalletProvider.notifier).state = wallet;
    ref.invalidate(storedActiveWalletProvider);
  }

  Future<WalletKeystore> _submitSolana(MobileBridge bridge, String password) {
    return switch (_mode) {
      'create' =>
        bridge.createWallet(name: _nameController.text, password: password),
      'keystore' => bridge.importKeystore(
          name: _nameController.text,
          keystoreJson: _secretController.text,
          password: password,
        ),
      'private_key' => bridge.importPrivateKey(
          name: _nameController.text,
          privateKeyBase58: _secretController.text,
          password: password,
        ),
      _ => bridge.importMnemonic(
          name: _nameController.text,
          mnemonic: _secretController.text,
          password: password,
          derivationPath: _derivationPathController.text,
        ),
    };
  }

  Future<WalletKeystore> _submitEvm(MobileBridge bridge, String password) {
    return switch (_mode) {
      'create' =>
        bridge.createEvmWallet(name: _nameController.text, password: password),
      'keystore' => bridge.importEvmKeystore(
          name: _nameController.text,
          keystoreJson: _secretController.text,
          password: password,
        ),
      'private_key' => bridge.importEvmPrivateKey(
          name: _nameController.text,
          privateKeyHex: _secretController.text,
          password: password,
        ),
      _ => bridge.importEvmMnemonic(
          name: _nameController.text,
          mnemonic: _secretController.text,
          password: password,
          derivationPath: _derivationPathController.text,
        ),
    };
  }

  Future<void> _delete(WalletSummary wallet) async {
    await _run(() async {
      await ref.read(mobileWalletStoreProvider).deleteWallet(wallet.id);
      if (ref.read(activeWalletProvider)?.id == wallet.id) {
        ref.read(activeWalletProvider.notifier).state =
            await ref.read(mobileWalletStoreProvider).loadActiveWallet();
      }
      ref.invalidate(storedWalletsProvider);
      ref.invalidate(storedActiveWalletProvider);
    });
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _busy = true);
    try {
      await action();
    } catch (error) {
      _show(error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _show(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }
}
