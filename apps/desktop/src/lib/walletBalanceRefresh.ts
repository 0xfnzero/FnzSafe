export interface WalletBalanceTarget<T> {
  key: string;
  walletId: string;
  identity: string;
  load: () => Promise<T>;
}

/** Keep public balance requests alive across wallet session checks and selection changes. */
export function createWalletBalanceRefresh<T>() {
  type Request = { identity: string; refreshKey: string; pending: boolean; done: Promise<void> };
  const requests = new Map<string, Request>();
  let selectedWallet: string | undefined;
  let context: string | undefined;
  let refreshKey: string | undefined;

  return {
    clear() {
      requests.clear();
      selectedWallet = undefined;
      context = undefined;
      refreshKey = undefined;
    },
    refresh(options: {
      targets: WalletBalanceTarget<T>[];
      selectedWalletId: string;
      contextKey: string;
      refreshKey: string;
      onStart: (target: WalletBalanceTarget<T>) => void;
      onSuccess: (target: WalletBalanceTarget<T>, value: T) => void;
      onError: (target: WalletBalanceTarget<T>, error: unknown) => void;
    }): Promise<void> {
      const switchingWallet = selectedWallet !== undefined
        && selectedWallet !== options.selectedWalletId
        && context === options.contextKey
        && refreshKey === options.refreshKey;
      selectedWallet = options.selectedWalletId;
      context = options.contextKey;
      refreshKey = options.refreshKey;
      const work: Promise<void>[] = [];
      for (const target of options.targets) {
        // A selection change must not restart the rest of the wallet list,
        // including requests still running from the initial list load.
        if (switchingWallet && target.walletId !== options.selectedWalletId) continue;
        const identity = JSON.stringify([options.contextKey, target.identity]);
        const prior = requests.get(target.key);
        const sameIdentity = prior?.identity === identity;
        if (sameIdentity && prior.pending) {
          prior.refreshKey = options.refreshKey;
          work.push(prior.done);
          continue;
        }
        if (sameIdentity && prior.refreshKey === options.refreshKey && !switchingWallet) continue;
        const request: Request = {
          identity,
          refreshKey: options.refreshKey,
          pending: true,
          done: Promise.resolve(),
        };
        requests.set(target.key, request);
        options.onStart(target);
        request.done = Promise.resolve().then(target.load).then(
          (value) => {
            if (requests.get(target.key) === request) options.onSuccess(target, value);
          },
          (error: unknown) => {
            if (requests.get(target.key) === request) options.onError(target, error);
          },
        ).finally(() => { request.pending = false; });
        work.push(request.done);
      }
      return Promise.all(work).then(() => undefined);
    },
  };
}
