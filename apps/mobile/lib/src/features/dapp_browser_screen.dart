import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../bridge/mobile_bridge_provider.dart';
import '../bridge/mobile_models.dart';

class DappBrowserScreen extends ConsumerStatefulWidget {
  const DappBrowserScreen({super.key});

  @override
  ConsumerState<DappBrowserScreen> createState() => _DappBrowserScreenState();
}

class _DappBrowserScreenState extends ConsumerState<DappBrowserScreen> {
  late final WebViewController _controller;
  final _urlController = TextEditingController(text: 'https://example.com');
  final Map<String, String> _connectedScopes = <String, String>{};
  final Map<String, DappPageContext> _requestContexts =
      <String, DappPageContext>{};
  String? _scheduledDappResponseId;
  int _navigationGeneration = 0;

  static const _maxProviderMessageBytes = 64 * 1024;
  static final _requestIdPattern = RegExp(r'^[A-Za-z0-9_-]{1,128}$');

  @override
  void initState() {
    super.initState();
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..addJavaScriptChannel(
        'FnzSafeProvider',
        onMessageReceived: (message) {
          _handleProviderMessage(message.message);
        },
      )
      ..setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) {
            final uri = Uri.tryParse(request.url);
            if (!_isAllowedDappUri(uri)) return NavigationDecision.prevent;
            if (request.isMainFrame) _beginNavigation(uri!);
            return NavigationDecision.navigate;
          },
          onPageFinished: _handlePageFinished,
        ),
      )
      ..loadRequest(Uri.parse(_urlController.text));
  }

  @override
  void dispose() {
    _requestContexts.clear();
    ref.read(dappPageContextProvider.notifier).state = null;
    _urlController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final scanned = ref.watch(scannedValueProvider);
    final dappResponse = ref.watch(dappSignResponseProvider);

    if (scanned != null && scanned.startsWith(RegExp(r'https?://'))) {
      _urlController.text = scanned;
      ref.read(scannedValueProvider.notifier).state = null;
      _load();
    }
    if (dappResponse != null &&
        _scheduledDappResponseId != dappResponse.requestId) {
      _scheduledDappResponseId = dappResponse.requestId;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _deliverDappResponse(dappResponse).whenComplete(() {
          if (_scheduledDappResponseId == dappResponse.requestId) {
            _scheduledDappResponseId = null;
          }
        });
      });
    }

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          tooltip: 'Back',
          icon: const Icon(Icons.arrow_back),
          onPressed: () => context.go('/dapps'),
        ),
        title: const Text('dApp Browser'),
        actions: [
          IconButton(
            tooltip: 'Scan URL',
            icon: const Icon(Icons.qr_code_scanner),
            onPressed: () => context.go('/scan'),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _urlController,
                    keyboardType: TextInputType.url,
                    decoration: const InputDecoration(
                      labelText: 'URL',
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _load(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  tooltip: 'Go',
                  icon: const Icon(Icons.arrow_forward),
                  onPressed: _load,
                ),
              ],
            ),
          ),
          Expanded(child: WebViewWidget(controller: _controller)),
        ],
      ),
    );
  }

  void _load() {
    final text = _urlController.text.trim();
    if (text.isEmpty) return;
    final uri = Uri.tryParse(
        text.startsWith(RegExp(r'https?://')) ? text : 'https://$text');
    if (!_isAllowedDappUri(uri)) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text(
            'Only HTTPS sites and local HTTP development sites are allowed.'),
      ));
      return;
    }
    _controller.loadRequest(uri!);
  }

  Future<void> _injectProvider() async {
    final wallet = ref.read(activeWalletProvider);
    final publicKey = wallet?.publicKey;
    final isEvm = wallet?.family == WalletFamily.evm;
    final evmChain = ref.read(activeEvmChainProvider);
    final evmChainId =
        evmChain == null ? '0x1' : '0x${evmChain.chainId.toRadixString(16)}';
    final currentOrigin =
        _originForUri(Uri.tryParse(await _controller.currentUrl() ?? ''));
    final connectedForOrigin = currentOrigin != null &&
        wallet != null &&
        _isConnected(currentOrigin, wallet);
    final script = '''
(() => {
  if (window.fnzeroSafe) return;
  const pending = new Map();
  let connected = ${connectedForOrigin ? 'true' : 'false'};
  let publicKeyValue = ${jsonEncode(publicKey)};
  let ethereumChainId = ${jsonEncode(evmChainId)};
  const toSerializable = (value) => {
    if (value instanceof Uint8Array) return { __fnzeroBytes: Array.from(value) };
    if (value && value.constructor && value.constructor.name === 'Buffer') {
      return { __fnzeroBytes: Array.from(value) };
    }
    if (Array.isArray(value)) return value.map((item) => toSerializable(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toSerializable(item)]));
    }
    return value;
  };
  const base64ToBytes = (value) => {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };
  const normalizeSuccess = (entry, payload) => {
    const method = entry.method;
    if (method === 'connect') {
      return { publicKey: provider.publicKey };
    }
    if (method === 'disconnect') {
      return undefined;
    }
    if (method === 'signMessage') {
      return {
        publicKey: provider.publicKey,
        signature: payload.signatureBase64 ? base64ToBytes(payload.signatureBase64) : payload.signature
      };
    }
    if (method === 'signAndSendTransaction') {
      return { signature: payload.transactionSignature || payload.signature };
    }
    if (method === 'signAllTransactions') {
      return {
        signedTransactions: payload.signedTransactions || [],
        signedTransactionBytes: (payload.signedTransactions || []).map((item) => base64ToBytes(item))
      };
    }
    if (method === 'signTransaction') {
      return {
        signedTransaction: payload.signedTransaction,
        signedTransactionBytes: payload.signedTransaction ? base64ToBytes(payload.signedTransaction) : undefined
      };
    }
    if (method && method.startsWith('eth_')) {
      if (method === 'eth_chainId') return payload.chainId;
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return payload.accounts || [];
      if (method === 'personal_sign' || method === 'eth_sign' || method === 'eth_signTypedData_v4') return payload.signature;
      if (method === 'eth_sendTransaction') return payload.transactionHash || payload.signature;
      if (method === 'eth_signTransaction') return payload.signedTransaction;
    }
    if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
    return payload;
  };
  const listeners = new Map();
  const emit = (event, value) => {
    const callbacks = listeners.get(event) || [];
    callbacks.forEach((callback) => {
      try { callback(value); } catch (_) {}
    });
  };
  const provider = {
    isFnzSafe: true,
    get isConnected() { return connected; },
    get publicKey() {
      if (!connected || !publicKeyValue) return null;
      return {
        toString: () => publicKeyValue,
        toBase58: () => publicKeyValue,
        toJSON: () => publicKeyValue
      };
    },
    connect: (opts) => provider.request({ method: 'connect', params: opts || {} }),
    disconnect: () => provider.request({ method: 'disconnect' }),
    signMessage: (message, encoding) => provider.request({
      method: 'signMessage',
      params: { message, encoding }
    }),
    signTransaction: (transaction) => provider.request({
      method: 'signTransaction',
      params: { transaction }
    }),
    signAllTransactions: (transactions) => provider.request({
      method: 'signAllTransactions',
      params: { transactions }
    }),
    signAndSendTransaction: (transaction, options) => provider.request({
      method: 'signAndSendTransaction',
      params: { transaction, options }
    }),
    request: (payload) => {
      if (pending.size >= 100) return Promise.reject(new Error('Too many FnzSafe requests are pending'));
      const id = `\${Date.now()}-\${Math.random().toString(36).slice(2)}`;
      FnzSafeProvider.postMessage(JSON.stringify({ ...(payload || {}), __fnzeroRequestId: id }, (_, value) => toSerializable(value)));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('FnzSafe request timed out'));
        }, 300000);
        pending.set(id, {
          resolve,
          reject,
          timer,
          method: payload && payload.method ? payload.method : 'request',
          params: payload && payload.params ? payload.params : undefined
        });
      });
    }
  };
  window.fnzeroSafeResolve = (id, ok, payload) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) {
      const previousConnected = connected;
      const previousPublicKey = publicKeyValue;
      const previousChainId = ethereumChainId;
      if (payload && payload.connected !== undefined) connected = !!payload.connected;
      if (payload && payload.publicKey !== undefined) publicKeyValue = payload.publicKey;
      if (payload && payload.chainId !== undefined) ethereumChainId = payload.chainId;
      if (previousChainId !== ethereumChainId) emit('chainChanged', ethereumChainId);
      if (previousPublicKey !== publicKeyValue) emit('accountsChanged', publicKeyValue ? [publicKeyValue] : []);
      if (previousConnected !== connected) {
        if (connected) {
          emit('connect', { chainId: ethereumChainId });
        } else {
          emit('disconnect', { code: 4900, message: 'Disconnected' });
        }
      }
      entry.resolve(normalizeSuccess(entry, payload || {}));
    } else {
      const error = new Error(payload && payload.message ? payload.message : 'FnzSafe request rejected');
      error.code = payload && payload.code ? payload.code : 4001;
      entry.reject(error);
    }
  };
  window.fnzeroSafe = provider;
  window.fnzeroSafeSetEthereumState = (nextChainId, selectedAddress, nextConnected) => {
    if (nextChainId && ethereumChainId !== nextChainId) {
      ethereumChainId = nextChainId;
      emit('chainChanged', ethereumChainId);
    }
    if (selectedAddress !== undefined && publicKeyValue !== selectedAddress) {
      publicKeyValue = selectedAddress;
      emit('accountsChanged', publicKeyValue ? [publicKeyValue] : []);
    }
    if (nextConnected !== undefined && connected !== !!nextConnected) {
      connected = !!nextConnected;
      if (connected) {
        emit('connect', { chainId: ethereumChainId });
      } else {
        emit('disconnect', { code: 4900, message: 'Disconnected' });
      }
    }
  };
  if (${isEvm ? 'true' : 'false'}) {
    const ethereum = {
      isFnzSafe: true,
      get chainId() { return ethereumChainId; },
      get networkVersion() { return String(parseInt(ethereumChainId, 16)); },
      get selectedAddress() { return connected ? publicKeyValue : null; },
      get isConnected() { return connected; },
      request: (payload) => provider.request(payload),
      enable: () => provider.request({ method: 'eth_requestAccounts' }),
      on: (event, callback) => {
        const callbacks = listeners.get(event) || [];
        callbacks.push(callback);
        listeners.set(event, callbacks);
        return ethereum;
      },
      removeListener: (event, callback) => {
        const callbacks = listeners.get(event) || [];
        listeners.set(event, callbacks.filter((item) => item !== callback));
        return ethereum;
      }
    };
    window.ethereum = ethereum;
    const providerInfo = Object.freeze({
      uuid: '2fd1f1c0-b818-4ec8-a62d-4fc708e04d4c',
      name: 'FnzSafe',
      icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"%3E%3Crect width="64" height="64" rx="14" fill="%2316181d"/%3E%3Cpath d="M17 15h32v9H27v7h18v9H27v15H17z" fill="white"/%3E%3C/svg%3E',
      rdns: 'io.fnzero.safe'
    });
    const announceProvider = () => window.dispatchEvent(new CustomEvent(
      'eip6963:announceProvider',
      { detail: Object.freeze({ info: providerInfo, provider: ethereum }) }
    ));
    window.addEventListener('eip6963:requestProvider', announceProvider);
    announceProvider();
  } else {
    window.solana = provider;
  }
  window.dispatchEvent(new Event('fnzero#initialized'));
})();
''';
    await _controller.runJavaScript(script);
  }

  Future<void> _handleProviderMessage(String message) async {
    String? requestId;
    try {
      if (utf8.encode(message).length > _maxProviderMessageBytes) {
        throw const FormatException('Provider request is too large');
      }
      final wallet = ref.read(activeWalletProvider);
      if (wallet == null) {
        throw StateError('Select a wallet before using dApps');
      }
      final decoded = jsonDecode(message);
      final payload =
          decoded is Map<String, Object?> ? decoded : <String, Object?>{};
      final method = payload['method']?.toString() ?? 'request';
      requestId = payload['__fnzeroRequestId']?.toString();
      if (requestId == null ||
          !_requestIdPattern.hasMatch(requestId) ||
          method.isEmpty ||
          method.length > 80) {
        throw const FormatException('Invalid provider request');
      }
      final currentUrl = await _controller.currentUrl() ?? '';
      final currentUri = Uri.tryParse(currentUrl);
      final origin = _originForUri(currentUri);
      if (origin == null) throw const FormatException('Untrusted dApp origin');
      final pageContext = DappPageContext(
        origin: origin,
        navigationGeneration: _navigationGeneration,
      );
      _requestContexts[requestId] = pageContext;
      if (wallet.family == WalletFamily.evm) {
        await _handleEvmProviderMessage(
            wallet, method, requestId, payload, message, origin);
        return;
      }
      if (method == 'connect') {
        if (!_isConnected(origin, wallet) &&
            !await _confirmSiteAction('Connect wallet?', origin)) {
          await _deliverProviderResponse(requestId, false,
              {'code': 4001, 'message': 'User rejected the connection'});
          return;
        }
        if (!await _requestIsCurrent(requestId)) return;
        _connectedScopes[origin] = _connectionScope(wallet);
        await _deliverProviderResponse(
          requestId,
          true,
          {
            'publicKey': wallet.publicKey,
            'connected': true,
          },
        );
        return;
      }
      if (method == 'disconnect') {
        _connectedScopes.remove(origin);
        await _deliverProviderResponse(
          requestId,
          true,
          {
            'publicKey': null,
            'connected': false,
          },
        );
        return;
      }
      if (!_isConnected(origin, wallet)) {
        await _deliverProviderResponse(requestId, false,
            {'code': 4100, 'message': 'Connect this site before signing'});
        return;
      }
      final signingPayloadBase64 =
          _signingPayloadBase64(method, payload, message);
      final transactionFormat = _transactionFormat(method);
      final appName = currentUri?.host ?? 'dApp';
      final appUrl = currentUrl;
      final preview = await ref.read(mobileBridgeProvider).previewDappSign(
            network: ref.read(activeNetworkProvider),
            walletPublicKey: wallet.publicKey,
            appName: appName,
            appUrl: appUrl,
            method: method,
            payloadBase64: signingPayloadBase64,
            transactionFormat: transactionFormat,
          );
      if (!await _requestIsCurrent(requestId)) return;
      ref.read(signingPreviewProvider.notifier).state = preview;
      ref.read(paymentSigningDraftProvider.notifier).state = null;
      ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
      ref.read(dappSigningDraftProvider.notifier).state = DappSigningDraft(
        preview: preview,
        appName: appName,
        appUrl: appUrl,
        method: method,
        payloadBase64: signingPayloadBase64,
        pageContext: pageContext,
        requestId: requestId,
        transactionFormat: transactionFormat,
      );
      ref.read(evmDappSigningDraftProvider.notifier).state = null;
      ref.read(squadsSigningDraftProvider.notifier).state = null;
      if (mounted) await context.push('/confirm');
    } catch (error) {
      await _deliverProviderResponse(
          requestId, false, {'code': -32600, 'message': error.toString()});
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(error.toString())));
    }
  }

  Future<void> _handleEvmProviderMessage(
    WalletSummary wallet,
    String method,
    String? requestId,
    Map<String, Object?> payload,
    String rawMessage,
    String origin,
  ) async {
    final chain = ref.read(activeEvmChainProvider);
    if (chain == null) {
      throw StateError('Select an EVM chain before using EVM dApps');
    }
    if (method == 'eth_chainId') {
      await _deliverProviderResponse(
        requestId,
        true,
        {'chainId': '0x${chain.chainId.toRadixString(16)}'},
      );
      return;
    }
    if (method == 'eth_accounts') {
      await _deliverProviderResponse(
        requestId,
        true,
        {
          'accounts':
              _isConnected(origin, wallet) ? [wallet.publicKey] : const [],
          'connected': _isConnected(origin, wallet),
          'publicKey': _isConnected(origin, wallet) ? wallet.publicKey : null,
        },
      );
      return;
    }
    if (method == 'connect' || method == 'eth_requestAccounts') {
      if (!_isConnected(origin, wallet) &&
          !await _confirmSiteAction('Connect wallet?', origin)) {
        await _deliverProviderResponse(requestId, false,
            {'code': 4001, 'message': 'User rejected the connection'});
        return;
      }
      if (!await _requestIsCurrent(requestId)) return;
      _connectedScopes[origin] = _connectionScope(wallet);
      await _deliverProviderResponse(
        requestId,
        true,
        {
          'accounts': [wallet.publicKey],
          'connected': true,
          'publicKey': wallet.publicKey,
          'chainId': _hexChainId(chain.chainId),
        },
      );
      return;
    }
    if (method == 'disconnect') {
      _connectedScopes.remove(origin);
      await _deliverProviderResponse(
        requestId,
        true,
        {
          'accounts': const [],
          'connected': false,
          'publicKey': null,
          'chainId': _hexChainId(chain.chainId),
        },
      );
      return;
    }
    if (method == 'wallet_switchEthereumChain') {
      if (!_isConnected(origin, wallet)) {
        await _deliverProviderResponse(requestId, false, {
          'code': 4100,
          'message': 'Connect this site before switching networks'
        });
        return;
      }
      final requestedChainId = _requestedEvmChainId(payload);
      if (requestedChainId == null) {
        await _deliverProviderResponse(
          requestId,
          false,
          {'code': 4902, 'message': 'Invalid EVM chain id'},
        );
        return;
      }
      final chains = await ref.read(evmChainsProvider.future);
      final nextChain = _findEvmChain(chains, requestedChainId);
      if (nextChain == null) {
        await _deliverProviderResponse(
          requestId,
          false,
          {'code': 4902, 'message': 'Unknown EVM chain'},
        );
        return;
      }
      if (!await _confirmSiteAction(
          'Switch network?', '$origin\n${chain.name} -> ${nextChain.name}')) {
        await _deliverProviderResponse(requestId, false,
            {'code': 4001, 'message': 'User rejected the network switch'});
        return;
      }
      if (!await _requestIsCurrent(requestId)) return;
      ref.read(activeEvmChainProvider.notifier).state = nextChain;
      _connectedScopes[origin] = _connectionScope(wallet);
      await _setEthereumProviderState(nextChain, wallet);
      await _deliverProviderResponse(
        requestId,
        true,
        {'chainId': _hexChainId(nextChain.chainId)},
      );
      return;
    }
    if (method == 'wallet_addEthereumChain') {
      if (!_isConnected(origin, wallet)) {
        await _deliverProviderResponse(requestId, false, {
          'code': 4100,
          'message': 'Connect this site before adding a network'
        });
        return;
      }
      final nextChain = _chainFromAddEthereumChain(payload);
      if (nextChain == null) {
        await _deliverProviderResponse(
          requestId,
          false,
          {'code': 4902, 'message': 'Invalid EVM chain configuration'},
        );
        return;
      }
      final builtins = await ref.read(mobileBridgeProvider).evmChains();
      final builtin = _findEvmChain(builtins, nextChain.chainId);
      if (builtin != null) {
        if (!await _requestIsCurrent(requestId)) return;
        ref.read(activeEvmChainProvider.notifier).state = builtin;
        _connectedScopes[origin] = _connectionScope(wallet);
        await _setEthereumProviderState(builtin, wallet);
        await _deliverProviderResponse(
          requestId,
          true,
          {'chainId': _hexChainId(builtin.chainId)},
        );
        return;
      }
      if (!await _confirmSiteAction(
          'Add network?', '$origin\n${nextChain.name}\n${nextChain.rpcUrl}')) {
        await _deliverProviderResponse(requestId, false,
            {'code': 4001, 'message': 'User rejected the network'});
        return;
      }
      if (!await _rpcReportsChainId(nextChain)) {
        await _deliverProviderResponse(
          requestId,
          false,
          {
            'code': 4902,
            'message': 'RPC endpoint did not report the requested chain id',
          },
        );
        return;
      }
      if (!await _requestIsCurrent(requestId)) return;
      await ref.read(mobileWalletStoreProvider).saveCustomEvmChain(nextChain);
      ref.invalidate(evmChainsProvider);
      ref.read(activeEvmChainProvider.notifier).state = nextChain;
      _connectedScopes[origin] = _connectionScope(wallet);
      await _setEthereumProviderState(nextChain, wallet);
      await _deliverProviderResponse(
        requestId,
        true,
        {'chainId': _hexChainId(nextChain.chainId)},
      );
      return;
    }
    if (method == 'net_version') {
      await _deliverProviderResponse(
        requestId,
        true,
        {'networkVersion': chain.chainId.toString()},
      );
      return;
    }

    if (!_isConnected(origin, wallet)) {
      await _deliverProviderResponse(requestId, false,
          {'code': 4100, 'message': 'Connect this site before signing'});
      return;
    }

    final pageContext = _requestContexts[requestId];
    if (pageContext == null) {
      throw StateError(
          'The dApp page changed before the request could be reviewed');
    }
    final appUrl = await _controller.currentUrl() ?? '';
    final appUri = Uri.tryParse(appUrl);
    final preview = await ref.read(mobileBridgeProvider).previewEvmDappSign(
          chain: chain,
          walletAddress: wallet.publicKey,
          appName: appUri?.host ?? 'dApp',
          appUrl: appUrl,
          method: method,
          payloadJson: jsonEncode(payload),
        );
    if (!await _requestIsCurrent(requestId)) return;
    ref.read(signingPreviewProvider.notifier).state = SigningPreview(
      id: preview.previewId,
      title: 'EVM dApp Request',
      network: AppNetwork.mainnet,
      walletPublicKey: wallet.publicKey,
      summary: preview.summary,
      warnings: preview.warnings,
    );
    ref.read(evmDappSigningDraftProvider.notifier).state = EvmDappSigningDraft(
      preview: preview,
      method: method,
      payloadJson: jsonEncode(payload),
      pageContext: pageContext,
      requestId: requestId,
    );
    ref.read(paymentSigningDraftProvider.notifier).state = null;
    ref.read(evmPaymentSigningDraftProvider.notifier).state = null;
    ref.read(dappSigningDraftProvider.notifier).state = null;
    ref.read(squadsSigningDraftProvider.notifier).state = null;
    if (mounted) await context.push('/confirm');
  }

  String _signingPayloadBase64(
    String method,
    Map<String, Object?> payload,
    String rawMessage,
  ) {
    if (method == 'signAllTransactions') {
      final transactions = _extractTransactionList(payload, rawMessage)
          .map((value) => _valueToBase64(value, rawMessage))
          .toList(growable: false);
      return base64Encode(utf8.encode(jsonEncode(transactions)));
    }

    if (method != 'signMessage' && method != 'personal_sign') {
      final transaction = _extractPayloadValue(payload);
      return _valueToBase64(transaction, rawMessage);
    }

    final message = _extractPayloadValue(payload);

    return _valueToBase64(message, rawMessage);
  }

  String? _transactionFormat(String method) {
    return switch (method) {
      'signTransaction' ||
      'signAndSendTransaction' ||
      'signAllTransactions' =>
        'auto',
      _ => null,
    };
  }

  Object? _extractPayloadValue(Map<String, Object?> payload) {
    final params = payload['params'];
    if (params is Map<String, Object?>) {
      return params['transaction'] ??
          params['message'] ??
          params['data'] ??
          params['payload'];
    }
    if (params is List<Object?> && params.isNotEmpty) {
      return params.first;
    }
    return payload['transaction'] ?? payload['message'] ?? payload['data'];
  }

  List<Object?> _extractTransactionList(
    Map<String, Object?> payload,
    String rawMessage,
  ) {
    final params = payload['params'];
    Object? transactions;
    if (params is Map<String, Object?>) {
      transactions = params['transactions'] ?? params['transaction'];
    } else if (params is List<Object?>) {
      transactions = params;
    }
    transactions ??= payload['transactions'] ?? payload['transaction'];

    if (transactions is List<Object?> && !_looksLikeByteList(transactions)) {
      return transactions;
    }
    return [transactions ?? rawMessage];
  }

  bool _looksLikeByteList(List<Object?> value) {
    return value.isNotEmpty &&
        value.every((item) => item is int && item >= 0 && item <= 255);
  }

  String _valueToBase64(Object? value, String fallback) {
    if (value is String && value.isNotEmpty) {
      try {
        base64Decode(value);
        return value;
      } catch (_) {
        return base64Encode(utf8.encode(value));
      }
    }

    if (value is Map<String, Object?> && value['__fnzeroBytes'] is List) {
      return _valueToBase64(value['__fnzeroBytes'], fallback);
    }

    if (value is List<Object?>) {
      final bytes = <int>[];
      for (final item in value) {
        if (item is! int || item < 0 || item > 255) {
          return base64Encode(utf8.encode(fallback));
        }
        bytes.add(item);
      }
      return base64Encode(bytes);
    }

    return base64Encode(utf8.encode(fallback));
  }

  Future<void> _deliverDappResponse(DappSignResponse response) async {
    ref.read(dappSignResponseProvider.notifier).state = null;
    final payload = response.approved
        ? {
            'publicKey': ref.read(activeWalletProvider)?.publicKey,
            'connected': true,
            if (response.signature != null) 'signature': response.signature,
            if (response.signatureBase64 != null)
              'signatureBase64': response.signatureBase64,
            if (response.signedPayloadBase64 != null)
              'signedTransaction': response.signedPayloadBase64,
            if (response.signedTransaction != null)
              'signedTransaction': response.signedTransaction,
            if (response.signedPayloadsBase64.isNotEmpty)
              'signedTransactions': response.signedPayloadsBase64,
            if (response.transactionSignature != null)
              'transactionSignature': response.transactionSignature,
            if (response.transactionSignature != null)
              'transactionHash': response.transactionSignature,
          }
        : {
            'message': response.error ?? 'FnzSafe request rejected',
            'code': 4001,
          };
    final expected = _requestContexts[response.requestId];
    if (!response.pageContext.matches(expected)) return;
    await _deliverProviderResponse(
        response.requestId, response.approved, payload);
  }

  Future<void> _deliverProviderResponse(
    String? requestId,
    bool approved,
    Map<String, Object?> payload,
  ) async {
    if (requestId == null) return;
    final expected = _requestContexts.remove(requestId);
    if (expected == null || !await _isCurrentPageContext(expected)) return;
    final script =
        'window.fnzeroSafeResolve(${jsonEncode(requestId)}, $approved, ${jsonEncode(payload)});';
    await _controller.runJavaScript(script);
  }

  Future<void> _setEthereumProviderState(
    EvmChainConfig chain,
    WalletSummary wallet,
  ) {
    final script =
        'window.fnzeroSafeSetEthereumState && window.fnzeroSafeSetEthereumState(${jsonEncode(_hexChainId(chain.chainId))}, ${jsonEncode(wallet.publicKey)}, true);';
    return _controller.runJavaScript(script);
  }

  EvmChainConfig? _findEvmChain(List<EvmChainConfig> chains, int chainId) {
    for (final chain in chains) {
      if (chain.chainId == chainId) return chain;
    }
    return null;
  }

  int? _requestedEvmChainId(Map<String, Object?> payload) {
    final params = payload['params'];
    Object? value;
    if (params is List<Object?> && params.isNotEmpty) {
      final first = params.first;
      if (first is Map<String, Object?>) value = first['chainId'];
    } else if (params is Map<String, Object?>) {
      value = params['chainId'];
    }
    return _parseEvmChainId(value);
  }

  EvmChainConfig? _chainFromAddEthereumChain(Map<String, Object?> payload) {
    final params = payload['params'];
    Object? raw;
    if (params is List<Object?> && params.isNotEmpty) {
      raw = params.first;
    } else if (params is Map<String, Object?>) {
      raw = params;
    }
    if (raw is! Map<String, Object?>) return null;

    final chainId = _parseEvmChainId(raw['chainId']);
    final name = raw['chainName']?.toString().trim();
    final nativeCurrency = raw['nativeCurrency'];
    final symbol = nativeCurrency is Map<String, Object?>
        ? nativeCurrency['symbol']?.toString().trim()
        : null;
    final rpcUrls = raw['rpcUrls'];
    final rpcUrl = rpcUrls is List<Object?> && rpcUrls.isNotEmpty
        ? rpcUrls.first?.toString().trim()
        : null;
    final explorerUrls = raw['blockExplorerUrls'];
    final explorerUrl = explorerUrls is List<Object?> && explorerUrls.isNotEmpty
        ? explorerUrls.first?.toString().trim()
        : null;

    if (chainId == null ||
        chainId <= 0 ||
        chainId > 9007199254740991 ||
        name == null ||
        name.isEmpty ||
        name.length > 64 ||
        symbol == null ||
        symbol.isEmpty ||
        symbol.length > 16 ||
        rpcUrl == null ||
        rpcUrl.length > 2048 ||
        !_isAllowedRpcUri(Uri.tryParse(rpcUrl)) ||
        (explorerUrl != null &&
            (explorerUrl.length > 2048 ||
                !_isAllowedDappUri(Uri.tryParse(explorerUrl))))) {
      return null;
    }

    return EvmChainConfig(
      chainId: chainId,
      name: name,
      nativeSymbol: symbol,
      rpcUrl: rpcUrl,
      explorerUrl:
          explorerUrl == null || explorerUrl.isEmpty ? null : explorerUrl,
      testnet: chainId != 1,
    );
  }

  int? _parseEvmChainId(Object? value) {
    if (value is int) return value;
    if (value is num) {
      if (!value.isFinite || value < 0 || value > 9007199254740991) {
        return null;
      }
      final integer = value.toInt();
      return value == integer ? integer : null;
    }
    if (value is String) {
      final trimmed = value.trim().toLowerCase();
      if (trimmed.startsWith('0x')) {
        return int.tryParse(trimmed.substring(2), radix: 16);
      }
      return int.tryParse(trimmed);
    }
    return null;
  }

  String _hexChainId(int chainId) => '0x${chainId.toRadixString(16)}';

  bool _isConnected(String origin, WalletSummary wallet) {
    return _connectedScopes[origin] == _connectionScope(wallet);
  }

  String _connectionScope(WalletSummary wallet) {
    if (wallet.family == WalletFamily.evm) {
      return '${wallet.id}:evm:${ref.read(activeEvmChainProvider)?.chainId ?? 0}';
    }
    return '${wallet.id}:solana:${ref.read(activeNetworkProvider).name}';
  }

  bool _isAllowedDappUri(Uri? uri) {
    if (uri == null || !uri.hasAuthority) return false;
    if (uri.scheme == 'https') return true;
    return uri.scheme == 'http' &&
        (uri.host == 'localhost' || uri.host == '127.0.0.1');
  }

  bool _isAllowedRpcUri(Uri? uri) {
    if (uri == null || uri.userInfo.isNotEmpty || !uri.hasAuthority) {
      return false;
    }
    if (uri.scheme == 'https') return true;
    return uri.scheme == 'http' &&
        (uri.host == 'localhost' || uri.host == '127.0.0.1');
  }

  void _beginNavigation(Uri uri) {
    _navigationGeneration += 1;
    _requestContexts.clear();
    ref.read(dappPageContextProvider.notifier).state = DappPageContext(
      origin: _originForUri(uri) ?? '',
      navigationGeneration: _navigationGeneration,
    );
  }

  Future<void> _handlePageFinished(String url) async {
    final uri = Uri.tryParse(url);
    final origin = _originForUri(uri);
    if (origin == null) return;
    final actualUrl = await _controller.currentUrl();
    final actualOrigin = _originForUri(Uri.tryParse(actualUrl ?? ''));
    if (actualOrigin != origin) return;
    _urlController.text = actualUrl ?? url;
    ref.read(dappPageContextProvider.notifier).state = DappPageContext(
      origin: origin,
      navigationGeneration: _navigationGeneration,
    );
    await _injectProvider();
  }

  Future<bool> _isCurrentPageContext(DappPageContext expected) async {
    final currentOrigin =
        _originForUri(Uri.tryParse(await _controller.currentUrl() ?? ''));
    return expected.navigationGeneration == _navigationGeneration &&
        expected.origin == currentOrigin &&
        expected.matches(ref.read(dappPageContextProvider));
  }

  Future<bool> _requestIsCurrent(String? requestId) async {
    if (requestId == null) return false;
    final requestContext = _requestContexts[requestId];
    return requestContext != null &&
        await _isCurrentPageContext(requestContext);
  }

  Future<bool> _rpcReportsChainId(EvmChainConfig chain) async {
    final uri = Uri.tryParse(chain.rpcUrl);
    if (!_isAllowedRpcUri(uri)) return false;
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 8);
    try {
      final request =
          await client.postUrl(uri!).timeout(const Duration(seconds: 8));
      request.followRedirects = false;
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode({
        'jsonrpc': '2.0',
        'id': 1,
        'method': 'eth_chainId',
        'params': const [],
      }));
      final response =
          await request.close().timeout(const Duration(seconds: 8));
      if (response.statusCode != HttpStatus.ok ||
          response.contentLength > 64 * 1024) {
        return false;
      }
      final bytes = <int>[];
      await for (final chunk in response.timeout(const Duration(seconds: 8))) {
        if (bytes.length + chunk.length > 64 * 1024) return false;
        bytes.addAll(chunk);
      }
      final body = utf8.decode(bytes);
      final decoded = jsonDecode(body);
      if (decoded is! Map<String, dynamic>) return false;
      return _parseEvmChainId(decoded['result']) == chain.chainId;
    } catch (_) {
      return false;
    } finally {
      client.close(force: true);
    }
  }

  String? _originForUri(Uri? uri) {
    if (!_isAllowedDappUri(uri)) return null;
    final defaultPort = (uri!.scheme == 'https' && uri.port == 443) ||
        (uri.scheme == 'http' && uri.port == 80);
    return '${uri.scheme}://${uri.host}${defaultPort || !uri.hasPort ? '' : ':${uri.port}'}';
  }

  Future<bool> _confirmSiteAction(String title, String details) async {
    if (!mounted) return false;
    return await showDialog<bool>(
          context: context,
          builder: (dialogContext) => AlertDialog(
            icon: const Icon(Icons.security_outlined),
            title: Text(title),
            content: Text(details),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(dialogContext).pop(false),
                child: const Text('Cancel'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(dialogContext).pop(true),
                child: const Text('Approve'),
              ),
            ],
          ),
        ) ??
        false;
  }
}
