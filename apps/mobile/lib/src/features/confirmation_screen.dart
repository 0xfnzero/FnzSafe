import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class ConfirmationScreen extends ConsumerStatefulWidget {
  const ConfirmationScreen({super.key});

  @override
  ConsumerState<ConfirmationScreen> createState() => _ConfirmationScreenState();
}

class _ConfirmationScreenState extends ConsumerState<ConfirmationScreen> {
  final _passwordController = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _passwordController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final preview = ref.watch(signingPreviewProvider);
    final paymentDraft = ref.watch(paymentSigningDraftProvider);
    final evmPaymentDraft = ref.watch(evmPaymentSigningDraftProvider);
    final dappDraft = ref.watch(dappSigningDraftProvider);
    final evmDappDraft = ref.watch(evmDappSigningDraftProvider);
    final squadsDraft = ref.watch(squadsSigningDraftProvider);

    if (preview == null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Confirm')),
        body: const Center(child: Text('No signing request')),
      );
    }

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/'),
        ),
        title: const Text('Confirm'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(preview.title, style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 12),
          _Detail(label: 'Network', value: preview.network.label),
          _Detail(label: 'Wallet', value: preview.walletPublicKey),
          if (paymentDraft != null) ...[
            _Detail(label: 'Recipient', value: paymentDraft.recipient),
            if (paymentDraft.mint != null)
              _Detail(label: 'Mint', value: paymentDraft.mint!),
            _Detail(
                label: 'Amount',
                value: paymentDraft.amountBaseUnits.toString()),
            _Detail(label: 'Operation', value: paymentDraft.operation.name),
          ],
          if (evmPaymentDraft != null) ...[
            _Detail(label: 'Chain', value: evmPaymentDraft.preview.chain.label),
            _Detail(
                label: 'Chain ID',
                value: evmPaymentDraft.preview.chain.chainId.toString()),
            _Detail(label: 'Recipient', value: evmPaymentDraft.recipient),
            if (evmPaymentDraft.tokenContract != null)
              _Detail(label: 'Token', value: evmPaymentDraft.tokenContract!),
            _Detail(label: 'Amount', value: evmPaymentDraft.amountWeiOrUnits),
            _Detail(
                label: 'Gas limit', value: evmPaymentDraft.preview.gasLimit),
            _Detail(
                label: 'Fee model', value: evmPaymentDraft.preview.feeModel),
            _Detail(
                label: 'Gas price',
                value: '${evmPaymentDraft.preview.gasPriceWei} wei'),
            if (evmPaymentDraft.preview.maxFeePerGasWei != null)
              _Detail(
                  label: 'Max fee',
                  value: '${evmPaymentDraft.preview.maxFeePerGasWei} wei'),
            if (evmPaymentDraft.preview.maxPriorityFeePerGasWei != null)
              _Detail(
                  label: 'Priority fee',
                  value:
                      '${evmPaymentDraft.preview.maxPriorityFeePerGasWei} wei'),
            _Detail(label: 'Nonce', value: evmPaymentDraft.preview.nonce),
            _Detail(
                label: 'Estimated fee',
                value: '${evmPaymentDraft.preview.estimatedFeeWei} wei'),
          ],
          if (dappDraft != null) ...[
            _Detail(label: 'dApp method', value: dappDraft.method),
          ],
          if (evmDappDraft != null) ...[
            _Detail(label: 'EVM dApp', value: evmDappDraft.preview.appName),
            _Detail(label: 'Origin', value: evmDappDraft.preview.appUrl),
            _Detail(label: 'Method', value: evmDappDraft.method),
            _Detail(label: 'Chain', value: evmDappDraft.preview.chain.label),
          ],
          if (squadsDraft != null) ...[
            _Detail(label: 'Squads action', value: squadsDraft.kind.name),
            if (squadsDraft.multisig != null)
              _Detail(label: 'Multisig', value: squadsDraft.multisig!),
            if (squadsDraft.proposal != null)
              _Detail(label: 'Proposal', value: squadsDraft.proposal!),
            if (squadsDraft.recipient != null)
              _Detail(label: 'Recipient', value: squadsDraft.recipient!),
            if (squadsDraft.mint != null)
              _Detail(label: 'Mint', value: squadsDraft.mint!),
            if (squadsDraft.amountBaseUnits > 0)
              _Detail(
                  label: 'Amount',
                  value: squadsDraft.amountBaseUnits.toString()),
          ],
          _Detail(label: 'Summary', value: preview.summary),
          const SizedBox(height: 16),
          for (final warning in preview.warnings)
            Card(
              child: ListTile(
                leading: const Icon(Icons.warning_amber),
                title: Text(warning),
              ),
            ),
          const SizedBox(height: 16),
          if (_requiresWalletPassword(preview)) ...[
            TextField(
              controller: _passwordController,
              obscureText: true,
              enableSuggestions: false,
              autocorrect: false,
              decoration: const InputDecoration(
                labelText: 'Wallet password',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 16),
          ],
          FilledButton.icon(
            onPressed: _submitting ? null : () => _approve(preview),
            icon: const Icon(Icons.check),
            label: Text(_submitting ? 'Submitting' : 'Approve'),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: _submitting ? null : () => _reject(preview),
            icon: const Icon(Icons.close),
            label: const Text('Reject'),
          ),
        ],
      ),
    );
  }

  bool _isPayment(SigningPreview preview) {
    final draft = ref.read(paymentSigningDraftProvider);
    return draft != null && draft.preview.id == preview.id;
  }

  bool _isEvmPayment(SigningPreview preview) {
    final draft = ref.read(evmPaymentSigningDraftProvider);
    return draft != null && draft.preview.previewId == preview.id;
  }

  bool _isDapp(SigningPreview preview) {
    final draft = ref.read(dappSigningDraftProvider);
    return draft != null && draft.preview.id == preview.id;
  }

  bool _isEvmDapp(SigningPreview preview) {
    final draft = ref.read(evmDappSigningDraftProvider);
    return draft != null && draft.preview.previewId == preview.id;
  }

  bool _isSquads(SigningPreview preview) {
    final draft = ref.read(squadsSigningDraftProvider);
    return draft != null && draft.preview.id == preview.id;
  }

  bool _requiresWalletPassword(SigningPreview preview) {
    return _isPayment(preview) ||
        _isEvmPayment(preview) ||
        _isDapp(preview) ||
        _isEvmDapp(preview) ||
        _isSquads(preview);
  }

  Future<void> _approve(SigningPreview preview) async {
    if (!_isPayment(preview) &&
        !_isEvmPayment(preview) &&
        !_isDapp(preview) &&
        !_isEvmDapp(preview) &&
        !_isSquads(preview)) {
      _complete('Signature request approved for native flow');
      return;
    }

    setState(() => _submitting = true);
    try {
      final wallet = ref.read(activeWalletProvider);
      if (wallet == null) {
        throw const MobileBridgeException(
            'invalid_input', 'Select a wallet before signing');
      }
      final keystoreJson =
          await ref.read(mobileWalletStoreProvider).readKeystoreJson(wallet.id);
      await ref.read(biometricGateProvider).confirmSensitiveSubmit();
      if (_isPayment(preview)) {
        final draft = ref.read(paymentSigningDraftProvider);
        if (draft == null) {
          throw const MobileBridgeException(
              'invalid_input', 'Payment draft is missing');
        }
        final result = await ref.read(mobileBridgeProvider).confirmPayment(
              preview: preview,
              approved: true,
              keystoreJson: keystoreJson,
              password: _passwordController.text,
              recipient: draft.recipient,
              amountBaseUnits: draft.amountBaseUnits,
              operation: draft.operation,
              mint: draft.mint,
            );
        _complete('Submitted: ${result.signature}');
        return;
      }

      if (_isEvmPayment(preview)) {
        final draft = ref.read(evmPaymentSigningDraftProvider);
        if (draft == null) {
          throw const MobileBridgeException(
              'invalid_input', 'EVM payment draft is missing');
        }
        final result = await ref.read(mobileBridgeProvider).confirmEvmPayment(
              preview: draft.preview,
              approved: true,
              keystoreJson: keystoreJson,
              password: _passwordController.text,
            );
        _complete('Submitted: ${result.transactionHash}');
        return;
      }

      if (_isSquads(preview)) {
        final message = await _approveSquads(preview, keystoreJson);
        _complete(message);
        return;
      }

      if (_isEvmDapp(preview)) {
        final draft = ref.read(evmDappSigningDraftProvider);
        if (draft == null) {
          throw const MobileBridgeException(
              'invalid_input', 'EVM dApp signing draft is missing');
        }
        final result = await ref.read(mobileBridgeProvider).confirmEvmDappSign(
              preview: draft.preview,
              approved: true,
              keystoreJson: keystoreJson,
              password: _passwordController.text,
              method: draft.method,
              payloadJson: draft.payloadJson,
            );
        if (draft.requestId != null) {
          ref.read(dappSignResponseProvider.notifier).state = DappSignResponse(
            requestId: draft.requestId!,
            approved: true,
            signature: result.signature,
            signedTransaction: result.signedTransaction,
            transactionSignature: result.transaction?.transactionHash,
          );
          _completeToPrevious(result.signature == null
              ? 'EVM dApp request ${result.status}'
              : 'Signed: ${result.signature}');
          return;
        }
        _complete(result.signature == null
            ? 'EVM dApp request ${result.status}'
            : 'Signed: ${result.signature}');
        return;
      }

      final draft = ref.read(dappSigningDraftProvider);
      if (draft == null) {
        throw const MobileBridgeException(
            'invalid_input', 'dApp signing draft is missing');
      }
      final result = await ref.read(mobileBridgeProvider).confirmDappSign(
            preview: preview,
            approved: true,
            keystoreJson: keystoreJson,
            password: _passwordController.text,
            method: draft.method,
            payloadBase64: draft.payloadBase64,
            transactionFormat: draft.transactionFormat,
          );
      if (draft.requestId != null) {
        ref.read(dappSignResponseProvider.notifier).state = DappSignResponse(
          requestId: draft.requestId!,
          approved: true,
          signature: result.signature,
          signatureBase64: result.signatureBase64,
          signedPayloadBase64: result.signedPayloadBase64,
          signedPayloadsBase64: result.signedPayloadsBase64,
          transactionSignature: result.transaction?.signature,
        );
        _completeToPrevious(
          result.signature == null
              ? 'dApp request ${result.status}'
              : 'Signed: ${result.signature}',
        );
        return;
      }
      _complete(result.signature == null
          ? 'dApp request ${result.status}'
          : 'Signed: ${result.signature}');
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.toString())));
    } finally {
      if (mounted) setState(() => _submitting = false);
      _passwordController.clear();
    }
  }

  Future<void> _reject(SigningPreview preview) async {
    var shouldReturnToPrevious = false;
    if (_isPayment(preview)) {
      try {
        await ref.read(mobileBridgeProvider).confirmPayment(
              preview: preview,
              approved: false,
              keystoreJson: '',
              password: '',
              recipient: ref.read(paymentSigningDraftProvider)?.recipient ?? '',
              amountBaseUnits:
                  ref.read(paymentSigningDraftProvider)?.amountBaseUnits ?? 0,
            );
      } catch (_) {
        // Rejection is expected to surface as a structured UserRejected error.
      }
    }
    if (_isEvmPayment(preview)) {
      try {
        final draft = ref.read(evmPaymentSigningDraftProvider);
        if (draft != null) {
          await ref.read(mobileBridgeProvider).confirmEvmPayment(
                preview: draft.preview,
                approved: false,
                keystoreJson: '',
                password: '',
              );
        }
      } catch (_) {
        // Rejection is expected to surface as a structured UserRejected error.
      }
    }
    if (_isDapp(preview)) {
      try {
        final draft = ref.read(dappSigningDraftProvider);
        await ref.read(mobileBridgeProvider).confirmDappSign(
              preview: preview,
              approved: false,
              keystoreJson: '',
              password: '',
              method: draft?.method ?? 'signMessage',
              payloadBase64: draft?.payloadBase64 ?? 'AA==',
              transactionFormat: draft?.transactionFormat,
            );
        if (draft?.requestId != null) {
          ref.read(dappSignResponseProvider.notifier).state = DappSignResponse(
            requestId: draft!.requestId!,
            approved: false,
            error: 'User rejected the dApp signing request',
          );
          shouldReturnToPrevious = true;
        }
      } catch (_) {
        // Rejection is expected to surface as a structured UserRejected error.
      }
    }
    if (_isEvmDapp(preview)) {
      try {
        final draft = ref.read(evmDappSigningDraftProvider);
        if (draft != null) {
          await ref.read(mobileBridgeProvider).confirmEvmDappSign(
                preview: draft.preview,
                approved: false,
                keystoreJson: '',
                password: '',
                method: draft.method,
                payloadJson: draft.payloadJson,
              );
          if (draft.requestId != null) {
            ref.read(dappSignResponseProvider.notifier).state =
                DappSignResponse(
              requestId: draft.requestId!,
              approved: false,
              error: 'User rejected the EVM dApp signing request',
            );
            shouldReturnToPrevious = true;
          }
        }
      } catch (_) {
        // Rejection is expected to surface as a structured UserRejected error.
      }
    }
    if (_isSquads(preview)) {
      try {
        final draft = ref.read(squadsSigningDraftProvider);
        await _rejectSquads(preview, draft);
      } catch (_) {
        // Rejection is expected to surface as a structured UserRejected error.
      }
    }
    _passwordController.clear();
    if (shouldReturnToPrevious) {
      _completeToPrevious('Rejected');
      return;
    }
    _complete('Rejected');
  }

  Future<String> _approveSquads(
    SigningPreview preview,
    String keystoreJson,
  ) async {
    final draft = ref.read(squadsSigningDraftProvider);
    if (draft == null) {
      throw const MobileBridgeException(
          'invalid_input', 'Squads signing draft is missing');
    }
    final bridge = ref.read(mobileBridgeProvider);
    final password = _passwordController.text;
    switch (draft.kind) {
      case SquadsDraftKind.create:
        final result = await bridge.confirmSquadsCreate(
          network: preview.network,
          approved: true,
          keystoreJson: keystoreJson,
          password: password,
          members: draft.members,
          threshold: draft.threshold,
          timeLock: draft.timeLock,
          memo: draft.memo,
        );
        return 'Created Squads: ${result.multisig}';
      case SquadsDraftKind.solTransferProposal:
        final result = await bridge.confirmSquadsTransferProposal(
          network: preview.network,
          approved: true,
          keystoreJson: keystoreJson,
          password: password,
          multisig: draft.multisig ?? '',
          kind: SquadsTransferKind.sol,
          recipient: draft.recipient,
          amountBaseUnits: draft.amountBaseUnits,
          memo: draft.memo,
        );
        return 'Proposal: ${result.proposal}';
      case SquadsDraftKind.tokenTransferProposal:
        final result = await bridge.confirmSquadsTransferProposal(
          network: preview.network,
          approved: true,
          keystoreJson: keystoreJson,
          password: password,
          multisig: draft.multisig ?? '',
          kind: SquadsTransferKind.splToken,
          recipient: draft.recipient,
          destinationTokenAccount: draft.destinationTokenAccount,
          sourceTokenAccount: draft.sourceTokenAccount,
          mint: draft.mint,
          amountBaseUnits: draft.amountBaseUnits,
          decimals: draft.decimals,
          memo: draft.memo,
        );
        return 'Proposal: ${result.proposal}';
      case SquadsDraftKind.approve:
        final result = await bridge.confirmSquadsApprove(
          network: preview.network,
          approved: true,
          keystoreJson: keystoreJson,
          password: password,
          multisig: draft.multisig ?? '',
          proposal: draft.proposal ?? '',
          memo: draft.memo,
        );
        return 'Approved: ${result.signature}';
      case SquadsDraftKind.reject:
        final result = await bridge.confirmSquadsReject(
          network: preview.network,
          approved: true,
          keystoreJson: keystoreJson,
          password: password,
          multisig: draft.multisig ?? '',
          proposal: draft.proposal ?? '',
          memo: draft.memo,
        );
        return 'Rejected on-chain: ${result.signature}';
      case SquadsDraftKind.execute:
        final result = await bridge.confirmSquadsExecute(
          network: preview.network,
          approved: true,
          keystoreJson: keystoreJson,
          password: password,
          multisig: draft.multisig ?? '',
          proposal: draft.proposal ?? '',
          transactionIndex: draft.transactionIndex ?? 0,
        );
        return 'Executed: ${result.signature}';
    }
  }

  Future<void> _rejectSquads(
    SigningPreview preview,
    SquadsSigningDraft? draft,
  ) {
    final bridge = ref.read(mobileBridgeProvider);
    switch (draft?.kind) {
      case SquadsDraftKind.create:
        return bridge.confirmSquadsCreate(
          network: preview.network,
          approved: false,
          keystoreJson: '',
          password: '',
          members: const [],
          threshold: 1,
        );
      case SquadsDraftKind.solTransferProposal:
      case SquadsDraftKind.tokenTransferProposal:
        return bridge.confirmSquadsTransferProposal(
          network: preview.network,
          approved: false,
          keystoreJson: '',
          password: '',
          multisig: draft?.multisig ?? '',
          kind: draft?.kind == SquadsDraftKind.tokenTransferProposal
              ? SquadsTransferKind.splToken
              : SquadsTransferKind.sol,
          amountBaseUnits: draft?.amountBaseUnits ?? 0,
        );
      case SquadsDraftKind.approve:
        return bridge.confirmSquadsApprove(
          network: preview.network,
          approved: false,
          keystoreJson: '',
          password: '',
          multisig: draft?.multisig ?? '',
          proposal: draft?.proposal ?? '',
        );
      case SquadsDraftKind.reject:
        return bridge.confirmSquadsReject(
          network: preview.network,
          approved: false,
          keystoreJson: '',
          password: '',
          multisig: draft?.multisig ?? '',
          proposal: draft?.proposal ?? '',
        );
      case SquadsDraftKind.execute:
        return bridge.confirmSquadsExecute(
          network: preview.network,
          approved: false,
          keystoreJson: '',
          password: '',
          multisig: draft?.multisig ?? '',
          proposal: draft?.proposal ?? '',
          transactionIndex: draft?.transactionIndex ?? 0,
        );
      case null:
        return Future.value();
    }
  }

  void _complete(String message) {
    ref.read(signingPreviewProvider.notifier).state = null;
    ref.read(paymentSigningDraftProvider.notifier).state = null;
    ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
    ref.read(dappSigningDraftProvider.notifier).state = null;
    ref.read(evmDappSigningDraftProvider.notifier).state = null;
    ref.read(squadsSigningDraftProvider.notifier).state = null;
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
    context.go('/');
  }

  void _completeToPrevious(String message) {
    ref.read(signingPreviewProvider.notifier).state = null;
    ref.read(paymentSigningDraftProvider.notifier).state = null;
    ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
    ref.read(dappSigningDraftProvider.notifier).state = null;
    ref.read(evmDappSigningDraftProvider.notifier).state = null;
    ref.read(squadsSigningDraftProvider.notifier).state = null;
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
    if (Navigator.of(context).canPop()) {
      context.pop();
    } else {
      context.go('/');
    }
  }
}

class _Detail extends StatelessWidget {
  const _Detail({
    required this.label,
    required this.value,
  });

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 4),
          Text(value),
        ],
      ),
    );
  }
}
