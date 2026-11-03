import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

// Exercise the actual shipped classic script, not the TypeScript module scope.
execFileSync(process.execPath, ['build.mjs'], { cwd: new URL('..', import.meta.url) });
const bundle = readFileSync(new URL('../dist/inpage.js', import.meta.url), 'utf8');

function page(existingWallet: boolean) {
  const announcements: any[] = [];
  const messages: any[] = [];
  const handlers = new Map<string, Array<(event: any) => void>>();
  const phantom = { isPhantom: true, request: () => { throw new Error('Phantom must not receive FnzSafe requests'); } };
  const context = createContext({
    TextEncoder, TextDecoder, Uint8Array, crypto, console, URL,
    btoa: (text: string) => Buffer.from(text, 'binary').toString('base64'),
    atob: (text: string) => Buffer.from(text, 'base64').toString('binary'),
    location: { origin: 'https://dapp.example' },
    document: { readyState: 'complete' },
    setTimeout: () => 1, clearTimeout: () => {},
    Event: class { constructor(public type: string) {} },
    CustomEvent: class { detail: any; constructor(public type: string, init: any) { this.detail = init.detail; } },
    addEventListener(type: string, listener: (event: any) => void) {
      handlers.set(type, [...(handlers.get(type) ?? []), listener]);
    },
    dispatchEvent(event: any) {
      if (event.type === 'eip6963:announceProvider') announcements.push(event.detail);
      for (const listener of handlers.get(event.type) ?? []) listener(event);
      return true;
    },
    postMessage(message: any) { messages.push(message); },
  });
  runInContext('window = globalThis', context);
  if (existingWallet) {
    context.ethereum = phantom;
    context.solana = phantom;
  }
  runInContext(bundle, context);
  return { context, announcements, messages, phantom };
}

for (const existing of [false, true]) {
  test(`bundled providers stay isolated with another wallet injected ${existing ? 'before' : 'after'} FnzSafe`, () => {
    const { context, announcements, messages, phantom } = page(existing);
    const own = context.fnzsafe;
    assert.equal(announcements[0].info.name, 'FnzSafe');
    assert.equal(announcements[0].provider, own.ethereum);
    assert.equal(own.ethereum.isFnzSafe, true);
    assert.equal(own.ethereum.isPhantom, undefined);
    if (existing) {
      assert.equal(context.ethereum, phantom);
      assert.equal(context.solana, phantom);
    } else {
      assert.equal(context.ethereum, own.ethereum);
      assert.equal(context.solana, own.solana);
    }
    // Model later-injecting wallets taking over legacy global aliases.
    context.ethereum = phantom;
    context.solana = phantom;
    runInContext("dispatchEvent(new Event('eip6963:requestProvider'))", context);
    assert.equal(announcements.at(-1).provider, own.ethereum);
    void announcements.at(-1).provider.request({ method: 'eth_requestAccounts' });
    void own.solana.connect();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].channel, 'fnzsafe:provider');
    assert.equal(messages[0].family, 'evm');
    assert.equal(messages[0].method, 'eth_requestAccounts');
    assert.equal(messages[1].family, 'solana');
    assert.equal(messages[1].method, 'solana_connect');
    for (const internal of ['calls', 'request', 'info', 'announce', 'target', 'FnzSafeEvmProvider']) {
      assert.equal(context[internal], undefined, `${internal} must not leak into the page`);
    }
  });
}
