import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class SendScreen extends ConsumerStatefulWidget {
  const SendScreen({super.key});

  @override
  ConsumerState<SendScreen> createState() => _SendScreenState();
}

class _SendScreenState extends ConsumerState<SendScreen> {
  final _recipientController = TextEditingController();
  final _amountController = TextEditingController();
  final _mintController = TextEditingController();
  final _memoController = TextEditingController();
  PaymentOperation _operation = PaymentOperation.solTransfer;
  bool _busy = false;

  @override
  void dispose() {
    _recipientController.dispose();
    _amountController.dispose();
    _mintController.dispose();
    _memoController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scanned = ref.watch(scannedValueProvider);
    if (scanned != null && scanned.trim().isNotEmpty) {
      _recipientController.text = scanned.trim();
      ref.read(scannedValueProvider.notifier).state = null;
    }

    final wallet = ref.watch(activeWalletProvider);
    final network = ref.watch(activeNetworkProvider);
    final chains = ref.watch(evmChainsProvider);
    final evmChain = ref.watch(activeEvmChainProvider);
    final isEvm = wallet?.family == WalletFamily.evm;
    final needsRecipient = _operation == PaymentOperation.solTransfer ||
        _operation == PaymentOperation.splTokenTransfer;
    final needsMint = _operation == PaymentOperation.splTokenTransfer;
    final needsAmount = _operation != PaymentOperation.wsolUnwrap &&
        _operation != PaymentOperation.wsolCloseAta;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/'),
        ),
        title: const Text('Send'),
        actions: [
          IconButton(
            tooltip: 'Scan',
            icon: const Icon(Icons.qr_code_scanner),
            onPressed: () => context.go('/scan'),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: const Icon(Icons.account_balance_wallet_outlined),
              title: Text(wallet?.name ?? 'No active wallet'),
              subtitle: Text(wallet?.publicKey ??
                  'Create or select a wallet before signing'),
            ),
          ),
          const SizedBox(height: 16),
          if (isEvm) ...[
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
                onChanged: (value) =>
                    ref.read(activeEvmChainProvider.notifier).state = value,
              ),
              error: (error, stackTrace) => Text(error.toString()),
              loading: () => const LinearProgressIndicator(),
            ),
          ] else ...[
            DropdownButtonFormField<PaymentOperation>(
              initialValue: _operation,
              decoration: const InputDecoration(
                  labelText: 'Operation', border: OutlineInputBorder()),
              items: const [
                DropdownMenuItem(
                    value: PaymentOperation.solTransfer,
                    child: Text('SOL transfer')),
                DropdownMenuItem(
                    value: PaymentOperation.splTokenTransfer,
                    child: Text('SPL token transfer')),
                DropdownMenuItem(
                    value: PaymentOperation.wsolWrap, child: Text('Wrap SOL')),
                DropdownMenuItem(
                    value: PaymentOperation.wsolUnwrap,
                    child: Text('Unwrap WSOL')),
                DropdownMenuItem(
                    value: PaymentOperation.wsolCloseAta,
                    child: Text('Close WSOL ATA')),
              ],
              onChanged: (value) {
                if (value != null) setState(() => _operation = value);
              },
            ),
          ],
          if (isEvm || needsRecipient) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _recipientController,
              decoration: const InputDecoration(
                  labelText: 'Recipient', border: OutlineInputBorder()),
            ),
          ],
          if (isEvm || needsMint) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _mintController,
              decoration: InputDecoration(
                labelText: isEvm ? 'ERC-20 contract (optional)' : 'Token mint',
                border: const OutlineInputBorder(),
              ),
            ),
          ],
          if (isEvm || needsAmount) ...[
            const SizedBox(height: 12),
            TextField(
              controller: _amountController,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: InputDecoration(
                labelText: isEvm
                    ? 'Amount in wei or token base units'
                    : _operation == PaymentOperation.splTokenTransfer
                        ? 'Amount in token base units'
                        : 'Amount in SOL',
                border: const OutlineInputBorder(),
              ),
            ),
          ],
          const SizedBox(height: 12),
          TextField(
            controller: _memoController,
            decoration: const InputDecoration(
                labelText: 'Memo', border: OutlineInputBorder()),
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: wallet == null || _busy
                ? null
                : () => isEvm
                    ? _previewEvm(wallet, evmChain)
                    : _preview(wallet, network),
            icon: const Icon(Icons.fact_check_outlined),
            label: Text(_busy ? 'Preparing' : 'Preview'),
          ),
        ],
      ),
    );
  }

  Future<void> _previewEvm(WalletSummary wallet, EvmChainConfig? chain) async {
    if (chain == null) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Select an EVM chain')));
      return;
    }
    setState(() => _busy = true);
    try {
      final recipient = _recipientController.text.trim();
      final tokenContract = _mintController.text.trim();
      final preview = await ref.read(mobileBridgeProvider).previewEvmPayment(
            chain: chain,
            walletAddress: wallet.publicKey,
            recipient: recipient,
            amountWeiOrUnits: _amountController.text.trim(),
            tokenContract: tokenContract.isEmpty ? null : tokenContract,
            memo: _memoController.text.trim().isEmpty
                ? null
                : _memoController.text.trim(),
          );
      ref.read(signingPreviewProvider.notifier).state = SigningPreview(
        id: preview.previewId,
        title: tokenContract.isEmpty ? 'EVM Payment' : 'ERC-20 Payment',
        network: AppNetwork.mainnet,
        walletPublicKey: wallet.publicKey,
        summary: preview.summary,
        warnings: preview.warnings,
      );
      ref.read(evmPaymentSigningDraftProvider.notifier).state =
          EvmPaymentSigningDraft(
        preview: preview,
        recipient: recipient,
        amountWeiOrUnits: _amountController.text.trim(),
        tokenContract: tokenContract.isEmpty ? null : tokenContract,
      );
      ref.read(paymentSigningDraftProvider.notifier).state = null;
      ref.read(dappSigningDraftProvider.notifier).state = null;
      ref.read(evmDappSigningDraftProvider.notifier).state = null;
      ref.read(squadsSigningDraftProvider.notifier).state = null;
      if (mounted) context.go('/confirm');
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _preview(WalletSummary wallet, AppNetwork network) async {
    setState(() => _busy = true);
    try {
      final recipient = _recipientController.text.trim();
      final mint = _mintController.text.trim();
      final amountBaseUnits = _amountBaseUnits();
      final previewRecipient = switch (_operation) {
        PaymentOperation.solTransfer ||
        PaymentOperation.splTokenTransfer =>
          recipient,
        PaymentOperation.wsolWrap ||
        PaymentOperation.wsolUnwrap ||
        PaymentOperation.wsolCloseAta =>
          wallet.publicKey,
      };
      final preview = await ref.read(mobileBridgeProvider).previewPayment(
            network: network,
            walletPublicKey: wallet.publicKey,
            recipient: previewRecipient,
            amount: _amountLabel(amountBaseUnits),
            operation: _operation,
            amountBaseUnits: amountBaseUnits,
            mint: mint.isEmpty ? null : mint,
            memo: _memoController.text.trim().isEmpty
                ? null
                : _memoController.text.trim(),
          );
      ref.read(signingPreviewProvider.notifier).state = preview;
      ref.read(paymentSigningDraftProvider.notifier).state =
          PaymentSigningDraft(
        preview: preview,
        recipient: previewRecipient,
        amountBaseUnits: amountBaseUnits,
        operation: _operation,
        mint: mint.isEmpty ? null : mint,
      );
      ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
      ref.read(dappSigningDraftProvider.notifier).state = null;
      ref.read(evmDappSigningDraftProvider.notifier).state = null;
      ref.read(squadsSigningDraftProvider.notifier).state = null;
      if (mounted) context.go('/confirm');
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(error.toString())));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  int _amountBaseUnits() {
    if (_operation == PaymentOperation.wsolUnwrap ||
        _operation == PaymentOperation.wsolCloseAta) {
      return 0;
    }
    final text = _amountController.text.trim();
    if (text.isEmpty) {
      throw const MobileBridgeException('invalid_input', 'Amount is required');
    }
    if (_operation == PaymentOperation.splTokenTransfer) {
      return _positiveBaseUnits(text);
    }
    return _decimalToBaseUnits(text, 9);
  }

  String _amountLabel(int amountBaseUnits) {
    return switch (_operation) {
      PaymentOperation.solTransfer => '${_amountController.text.trim()} SOL',
      PaymentOperation.splTokenTransfer => '$amountBaseUnits base units',
      PaymentOperation.wsolWrap => '${_amountController.text.trim()} SOL',
      PaymentOperation.wsolUnwrap => 'all WSOL',
      PaymentOperation.wsolCloseAta => 'close WSOL ATA',
    };
  }

  int _decimalToBaseUnits(String value, int decimals) {
    final parts = value.split('.');
    if (parts.length > 2 ||
        parts.first.isEmpty ||
        !RegExp(r'^[0-9]+$').hasMatch(parts.first)) {
      throw const MobileBridgeException('invalid_input', 'Invalid amount');
    }
    final whole = BigInt.parse(parts.first);
    final fraction = parts.length == 1 ? '' : parts[1];
    if (fraction.isNotEmpty && !RegExp(r'^[0-9]+$').hasMatch(fraction)) {
      throw const MobileBridgeException('invalid_input', 'Invalid amount');
    }
    if (fraction.length > decimals) {
      throw MobileBridgeException(
          'invalid_input', 'Amount supports up to $decimals decimals');
    }
    final paddedFraction = fraction.padRight(decimals, '0');
    final scale = BigInt.from(10).pow(decimals);
    final units = whole * scale +
        BigInt.parse(paddedFraction.isEmpty ? '0' : paddedFraction);
    if (units > BigInt.from(0x7fffffffffffffff)) {
      throw const MobileBridgeException('invalid_input', 'Amount is too large');
    }
    if (units <= BigInt.zero) {
      throw const MobileBridgeException(
          'invalid_input', 'Amount must be greater than zero');
    }
    return units.toInt();
  }

  int _positiveBaseUnits(String value) {
    if (!RegExp(r'^[0-9]+$').hasMatch(value)) {
      throw const MobileBridgeException('invalid_input', 'Invalid amount');
    }
    final units = BigInt.parse(value);
    if (units > BigInt.from(0x7fffffffffffffff)) {
      throw const MobileBridgeException('invalid_input', 'Amount is too large');
    }
    if (units <= BigInt.zero) {
      throw const MobileBridgeException(
          'invalid_input', 'Amount must be greater than zero');
    }
    return units.toInt();
  }
}
