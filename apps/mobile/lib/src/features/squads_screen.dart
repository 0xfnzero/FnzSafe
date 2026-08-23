import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class SquadsScreen extends ConsumerStatefulWidget {
  const SquadsScreen({super.key});

  @override
  ConsumerState<SquadsScreen> createState() => _SquadsScreenState();
}

class _SquadsScreenState extends ConsumerState<SquadsScreen> {
  final _membersController = TextEditingController();
  final _thresholdController = TextEditingController(text: '1');
  final _multisigController = TextEditingController();
  final _proposalController = TextEditingController();
  final _transactionIndexController = TextEditingController();
  final _recipientController = TextEditingController();
  final _mintController = TextEditingController();
  final _amountController = TextEditingController();
  final _decimalsController = TextEditingController();
  final _memoController = TextEditingController();
  SquadsInfo? _info;
  SquadsProposals? _proposals;
  bool _loading = false;

  @override
  void dispose() {
    _membersController.dispose();
    _thresholdController.dispose();
    _multisigController.dispose();
    _proposalController.dispose();
    _transactionIndexController.dispose();
    _recipientController.dispose();
    _mintController.dispose();
    _amountController.dispose();
    _decimalsController.dispose();
    _memoController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final wallet = ref.watch(activeWalletProvider);
    final network = ref.watch(activeNetworkProvider);

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/'),
        ),
        title: const Text('Squads'),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Squads', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: 8),
          Text(wallet == null
              ? 'No active wallet'
              : '${network.label} · ${wallet.publicKey}'),
          const SizedBox(height: 16),
          TextField(
            controller: _multisigController,
            decoration: const InputDecoration(
              labelText: 'Multisig address',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _loading ? null : _loadInfo,
                  icon: const Icon(Icons.info_outline),
                  label: const Text('Info'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _loading ? null : _loadProposals,
                  icon: const Icon(Icons.list_alt),
                  label: const Text('Proposals'),
                ),
              ),
            ],
          ),
          if (_info != null) ...[
            const SizedBox(height: 14),
            _Line('Vault', _info!.vault),
            _Line('Threshold', _info!.threshold.toString()),
            _Line('Tx index', _info!.transactionIndex.toString()),
            _Line('Members', _info!.members.map((m) => m.key).join('\n')),
          ],
          if (_proposals != null) ...[
            const SizedBox(height: 14),
            for (final proposal in _proposals!.proposals)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(proposal.address),
                subtitle:
                    Text('#${proposal.transactionIndex} · ${proposal.status}'),
                onTap: () {
                  _proposalController.text = proposal.address;
                  _transactionIndexController.text =
                      proposal.transactionIndex.toString();
                },
              ),
          ],
          const Divider(height: 32),
          TextField(
            controller: _membersController,
            minLines: 2,
            maxLines: 5,
            decoration: const InputDecoration(
              labelText: 'Create members, one public key per line',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _thresholdController,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Threshold',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: _loading ? null : _prepareCreate,
            icon: const Icon(Icons.group_add),
            label: const Text('Create multisig'),
          ),
          const Divider(height: 32),
          TextField(
            controller: _recipientController,
            decoration: const InputDecoration(
              labelText: 'Recipient wallet',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _amountController,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Amount in base units',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: _loading ? null : _prepareSolProposal,
            icon: const Icon(Icons.send),
            label: const Text('Create SOL proposal'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _mintController,
            decoration: const InputDecoration(
              labelText: 'Token mint',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _decimalsController,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Decimals, optional',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          OutlinedButton.icon(
            onPressed: _loading ? null : _prepareTokenProposal,
            icon: const Icon(Icons.token),
            label: const Text('Create SPL proposal'),
          ),
          const Divider(height: 32),
          TextField(
            controller: _proposalController,
            decoration: const InputDecoration(
              labelText: 'Proposal address',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _transactionIndexController,
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Transaction index',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: _memoController,
            decoration: const InputDecoration(
              labelText: 'Memo, optional',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(
                child: FilledButton.icon(
                  onPressed: _loading ? null : _prepareApprove,
                  icon: const Icon(Icons.check),
                  label: const Text('Approve'),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: OutlinedButton.icon(
                  onPressed: _loading ? null : _prepareReject,
                  icon: const Icon(Icons.close),
                  label: const Text('Reject'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          FilledButton.icon(
            onPressed: _loading ? null : _prepareExecute,
            icon: const Icon(Icons.play_arrow),
            label: const Text('Execute'),
          ),
        ],
      ),
    );
  }

  Future<void> _loadInfo() async {
    await _run(() async {
      _info = await ref.read(mobileBridgeProvider).loadSquadsInfo(
            network: ref.read(activeNetworkProvider),
            multisig: _multisigController.text.trim(),
            proposal: _proposalController.text.trim().isEmpty
                ? null
                : _proposalController.text.trim(),
          );
    });
  }

  Future<void> _loadProposals() async {
    await _run(() async {
      _proposals = await ref.read(mobileBridgeProvider).loadSquadsProposals(
            network: ref.read(activeNetworkProvider),
            multisig: _multisigController.text.trim(),
            limit: 20,
          );
    });
  }

  Future<void> _prepareCreate() async {
    final members = _membersController.text
        .split(RegExp(r'[\n,]+'))
        .map((value) => value.trim())
        .where((value) => value.isNotEmpty)
        .toList();
    await _prepare(
      kind: SquadsDraftKind.create,
      action: 'create',
      members: members,
      threshold: int.tryParse(_thresholdController.text.trim()) ?? 1,
    );
  }

  Future<void> _prepareSolProposal() {
    return _prepare(
      kind: SquadsDraftKind.solTransferProposal,
      action: 'sol_transfer_proposal',
      multisig: _multisigController.text.trim(),
      recipient: _recipientController.text.trim(),
      amountBaseUnits: int.tryParse(_amountController.text.trim()) ?? 0,
      memo: _memoController.text.trim().isEmpty
          ? null
          : _memoController.text.trim(),
    );
  }

  Future<void> _prepareTokenProposal() {
    return _prepare(
      kind: SquadsDraftKind.tokenTransferProposal,
      action: 'token_transfer_proposal',
      multisig: _multisigController.text.trim(),
      recipient: _recipientController.text.trim(),
      mint: _mintController.text.trim(),
      amountBaseUnits: int.tryParse(_amountController.text.trim()) ?? 0,
      decimals: _decimalsController.text.trim().isEmpty
          ? null
          : int.tryParse(_decimalsController.text.trim()),
      memo: _memoController.text.trim().isEmpty
          ? null
          : _memoController.text.trim(),
    );
  }

  Future<void> _prepareApprove() {
    return _prepareVote(SquadsDraftKind.approve, 'approve');
  }

  Future<void> _prepareReject() {
    return _prepareVote(SquadsDraftKind.reject, 'reject');
  }

  Future<void> _prepareExecute() {
    return _prepare(
      kind: SquadsDraftKind.execute,
      action: 'execute',
      multisig: _multisigController.text.trim(),
      proposal: _proposalController.text.trim(),
      transactionIndex: int.tryParse(_transactionIndexController.text.trim()),
    );
  }

  Future<void> _prepareVote(SquadsDraftKind kind, String action) {
    return _prepare(
      kind: kind,
      action: action,
      multisig: _multisigController.text.trim(),
      proposal: _proposalController.text.trim(),
      memo: _memoController.text.trim().isEmpty
          ? null
          : _memoController.text.trim(),
    );
  }

  Future<void> _prepare({
    required SquadsDraftKind kind,
    required String action,
    List<String> members = const [],
    int threshold = 1,
    String? multisig,
    String? proposal,
    int? transactionIndex,
    String? recipient,
    String? mint,
    int amountBaseUnits = 0,
    int? decimals,
    String? memo,
  }) async {
    final wallet = ref.read(activeWalletProvider);
    if (wallet == null) {
      _show('Select a wallet first');
      return;
    }
    try {
      final preview = await ref.read(mobileBridgeProvider).previewSquadsAction(
            network: ref.read(activeNetworkProvider),
            walletPublicKey: wallet.publicKey,
            multisig: multisig?.isEmpty ?? true
                ? '11111111111111111111111111111111'
                : multisig!,
            action: action,
          );
      ref.read(signingPreviewProvider.notifier).state = preview;
      ref.read(paymentSigningDraftProvider.notifier).state = null;
      ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
      ref.read(dappSigningDraftProvider.notifier).state = null;
      ref.read(evmDappSigningDraftProvider.notifier).state = null;
      ref.read(squadsSigningDraftProvider.notifier).state = SquadsSigningDraft(
        preview: preview,
        kind: kind,
        members: members,
        threshold: threshold,
        multisig: multisig,
        proposal: proposal,
        transactionIndex: transactionIndex,
        recipient: recipient,
        mint: mint,
        amountBaseUnits: amountBaseUnits,
        decimals: decimals,
        memo: memo,
      );
      if (mounted) context.go('/confirm');
    } catch (error) {
      _show(error.toString());
    }
  }

  Future<void> _run(Future<void> Function() body) async {
    setState(() => _loading = true);
    try {
      await body();
    } catch (error) {
      _show(error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _show(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }
}

class _Line extends StatelessWidget {
  const _Line(this.label, this.value);

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
