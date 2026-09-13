import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import type { Wallet as StandardWallet, WalletAccount } from '@wallet-standard/base';
import { registerWallet } from '@wallet-standard/wallet';

interface RpcError {
  code: number;
  message: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error & { code?: number }) => void;
  timer: number;
}

const calls = new Map<string, PendingCall>();
const MAX_PENDING_CALLS = 100;

function request(family: 'evm' | 'solana', method: string, params?: unknown[]): Promise<unknown> {
  if (calls.size >= MAX_PENDING_CALLS) {
    return Promise.reject(new Error('Too many FnzSafe requests are pending'));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      calls.delete(id);
      reject(new Error('FnzSafe request timed out'));
    }, 5 * 60_000);
    calls.set(id, { resolve, reject, timer });
    window.postMessage({ channel: 'fnzsafe:provider', direction: 'request', id, family, method, params }, location.origin);
  });
}

window.addEventListener('message', (event: MessageEvent<{ channel?: string; direction?: string; id?: string; result?: unknown; error?: RpcError }>) => {
  if (event.source !== window || event.origin !== location.origin) return;
  if (event.data?.channel !== 'fnzsafe:provider' || event.data.direction !== 'response' || !event.data.id) return;
  const call = calls.get(event.data.id);
  if (!call) return;
  calls.delete(event.data.id);
  window.clearTimeout(call.timer);
  if (event.data.error) {
    const error = Object.assign(new Error(event.data.error.message), { code: event.data.error.code });
    call.reject(error);
  } else {
    call.resolve(event.data.result);
  }
});

class FnzSafeEvmProvider {
  readonly isFnzSafe = true;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    const result = await request('evm', args.method, args.params);
    if (args.method === 'eth_requestAccounts') this.emit('accountsChanged', result);
    if (args.method === 'wallet_switchEthereumChain') {
      this.emit('chainChanged', (args.params?.[0] as { chainId?: string })?.chainId);
    }
    return result;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? new Set();
    current.add(listener);
    this.listeners.set(event, current);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base58ToBytes(value: string): Uint8Array {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number = 0n;
  for (const character of value) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base58 signature');
    number = number * 58n + BigInt(index);
  }
  const output: number[] = [];
  while (number > 0) {
    output.unshift(Number(number % 256n));
    number /= 256n;
  }
  const leading = value.match(/^1*/)?.[0].length ?? 0;
  return Uint8Array.from([...new Array(leading).fill(0), ...output]);
}

class FnzSafeSolanaProvider {
  readonly isFnzSafe = true;
  publicKey: PublicKey | null = null;
  isConnected = false;

  async connect(): Promise<{ publicKey: PublicKey }> {
    const result = (await request('solana', 'solana_connect')) as { publicKey: string };
    this.publicKey = new PublicKey(result.publicKey);
    this.isConnected = true;
    return { publicKey: this.publicKey };
  }

  async disconnect(): Promise<void> {
    this.publicKey = null;
    this.isConnected = false;
  }

  async signMessage(message: Uint8Array): Promise<{ signature: Uint8Array; publicKey: PublicKey }> {
    const result = (await request('solana', 'solana_signMessage', [bytesToBase64(message)])) as { signature: string; publicKey: string };
    return {
      signature: base58ToBytes(result.signature),
      publicKey: new PublicKey(result.publicKey),
    };
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    const encoded = transaction instanceof VersionedTransaction
      ? bytesToBase64(transaction.serialize())
      : bytesToBase64(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
    const result = (await request('solana', 'solana_signTransaction', [encoded])) as { signedTransaction: string };
    const bytes = Uint8Array.from(atob(result.signedTransaction), (char) => char.charCodeAt(0));
    return (transaction instanceof VersionedTransaction ? VersionedTransaction.deserialize(bytes) : Transaction.from(bytes)) as T;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(transactions: T[]): Promise<T[]> {
    const encoded = transactions.map((transaction) =>
      bytesToBase64(
        transaction instanceof VersionedTransaction
          ? transaction.serialize()
          : transaction.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
      ),
    );
    const result = (await request('solana', 'solana_signAllTransactions', [encoded])) as {
      signedTransactions: string[];
    };
    return result.signedTransactions.map((signed, index) => {
      const bytes = base64ToBytes(signed);
      return (transactions[index] instanceof VersionedTransaction
        ? VersionedTransaction.deserialize(bytes)
        : Transaction.from(bytes)) as T;
    });
  }

  async signAndSendTransaction(transaction: Transaction | VersionedTransaction): Promise<{ signature: string }> {
    const encoded = transaction instanceof VersionedTransaction
      ? bytesToBase64(transaction.serialize())
      : bytesToBase64(transaction.serialize({ requireAllSignatures: false, verifySignatures: false }));
    return request('solana', 'solana_signAndSendTransaction', [encoded]) as Promise<{ signature: string }>;
  }
}

const ethereum = new FnzSafeEvmProvider();
const solana = new FnzSafeSolanaProvider();
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#16181d"/><path d="M17 15h32v9H27v7h18v9H27v15H17z" fill="white"/></svg>`;
const info = Object.freeze({ uuid: '2fd1f1c0-b818-4ec8-a62d-4fc708e04d4c', name: 'FnzSafe', icon: `data:image/svg+xml,${encodeURIComponent(icon)}`, rdns: 'io.fnzero.safe' });
const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: ethereum }) }));

window.addEventListener('eip6963:requestProvider', announce);
announce();

const target = window as Window & { ethereum?: FnzSafeEvmProvider; solana?: FnzSafeSolanaProvider; fnzsafe?: { ethereum: FnzSafeEvmProvider; solana: FnzSafeSolanaProvider } };
target.fnzsafe = Object.freeze({ ethereum, solana });
if (!target.ethereum) target.ethereum = ethereum;
if (!target.solana) target.solana = solana;

class FnzSafeStandardWallet implements StandardWallet {
  readonly version = '1.0.0' as const;
  readonly name = 'FnzSafe';
  readonly icon = `data:image/svg+xml;base64,${btoa(icon)}` as StandardWallet['icon'];
  readonly chains = ['solana:mainnet', 'solana:devnet'] as const;
  private authorizedAccounts: readonly WalletAccount[] = [];
  private readonly changeListeners = new Set<
    (properties: { accounts: readonly WalletAccount[] }) => void
  >();

  get accounts(): readonly WalletAccount[] {
    return this.authorizedAccounts;
  }

  get features(): StandardWallet['features'] {
    return {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => {
          const connected = await solana.connect();
          this.authorizedAccounts = [this.account(connected.publicKey)];
          this.emitChange();
          return { accounts: this.accounts };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {
          await solana.disconnect();
          this.authorizedAccounts = [];
          this.emitChange();
        },
      },
      'standard:events': {
        version: '1.0.0',
        on: (
          event: string,
          listener: (properties: { accounts: readonly WalletAccount[] }) => void,
        ) => {
          if (event !== 'change') {
            throw new Error(`Unsupported wallet event: ${event}`);
          }
          this.changeListeners.add(listener);
          return () => this.changeListeners.delete(listener);
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs: Array<{ message: Uint8Array }>) =>
          Promise.all(
            inputs.map(async (input) => {
              const signed = await solana.signMessage(input.message);
              return {
                signedMessage: input.message,
                signature: signed.signature,
              };
            }),
          ),
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (
          ...inputs: Array<{ transaction: Uint8Array }>
        ) => {
          const result = (await request(
            'solana',
            'solana_signAllTransactions',
            [inputs.map((input) => bytesToBase64(input.transaction))],
          )) as { signedTransactions: string[] };
          return result.signedTransactions.map((transaction) => ({
            signedTransaction: base64ToBytes(transaction),
          }));
        },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (
          ...inputs: Array<{ transaction: Uint8Array }>
        ) =>
          Promise.all(
            inputs.map(async (input) => {
              const result = (await request(
                'solana',
                'solana_signAndSendTransaction',
                [bytesToBase64(input.transaction)],
              )) as { signature: string };
              return { signature: base58ToBytes(result.signature) };
            }),
          ),
      },
    };
  }

  private account(publicKey: PublicKey): WalletAccount {
    return Object.freeze({
      address: publicKey.toBase58(),
      publicKey: publicKey.toBytes(),
      chains: this.chains,
      features: [
        'solana:signMessage',
        'solana:signTransaction',
        'solana:signAndSendTransaction',
      ] as const,
      label: 'FnzSafe Solana Account',
      icon: this.icon,
    });
  }

  private emitChange(): void {
    const properties = { accounts: this.accounts };
    for (const listener of this.changeListeners) listener(properties);
  }
}

registerWallet(new FnzSafeStandardWallet());
