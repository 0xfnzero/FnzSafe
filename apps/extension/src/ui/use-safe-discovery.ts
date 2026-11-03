"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { nextDiscoveryCursor, type DiscoveryCursor } from "../../../desktop/src/lib/safeDiscovery";
import type { SafeDiscoveryPage, SafeAccount } from "../../../desktop/src/lib/safeMultisig";

type Status = "idle" | "running" | "paused" | "complete" | "error";
export function useSafeDiscovery({ scope, enabled, request, onAccounts }: {
  scope: string; enabled: boolean;
  request: (cursor: DiscoveryCursor) => Promise<SafeDiscoveryPage>;
  onAccounts: (accounts: SafeAccount[]) => void;
}) {
  const callbacks = useRef({ request, onAccounts });
  callbacks.current = { request, onAccounts };
  const generation = useRef(0);
  const cursor = useRef<DiscoveryCursor>({ offset: 0 });
  const found = useRef(new Set<string>());
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const [page, setPage] = useState<SafeDiscoveryPage>();
  const [count, setCount] = useState(0);
  const [unsupported, setUnsupported] = useState(0);
  const start = useCallback(async (reset = false) => {
    if (!enabled) return;
    const token = ++generation.current;
    if (reset) {
      cursor.current = { offset: 0 }; found.current = new Set();
      setPage(undefined); setCount(0); setUnsupported(0);
    }
    setStatus("running"); setError("");
    try {
      while (token === generation.current) {
        const previous = cursor.current;
        const result = await callbacks.current.request(previous);
        if (token !== generation.current) return;
        const next = nextDiscoveryCursor(result, previous);
        callbacks.current.onAccounts(result.accounts);
        for (const account of result.accounts) found.current.add(account.address.toLowerCase());
        setCount(found.current.size); setPage(result);
        setUnsupported(n => n + result.unsupported);
        if (!next) { setStatus("complete"); return; }
        cursor.current = next;
        // Yield between bounded read-only pages; do not monopolize the RPC.
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    } catch (e) {
      if (token !== generation.current) return;
      setError(e instanceof Error ? e.message : String(e)); setStatus("error");
    }
  }, [enabled]);
  useEffect(() => {
    // Scope includes chain configuration + owner. Late responses cannot populate
    // another wallet or network, including an A -> B -> A switch.
    const activeGeneration = generation;
    if (enabled) void start(true);
    else { setStatus("idle"); setPage(undefined); setCount(0); setError(""); }
    return () => { activeGeneration.current++; };
  }, [scope, enabled, start]);
  return { status, error, page, count, unsupported, start,
    pause: () => { generation.current++; setStatus("paused"); } };
}
