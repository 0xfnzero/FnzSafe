"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useTranslations } from "@/hooks/useTranslations";

/** Full public address with clipboard feedback; never copies a shortened display value. */
export function SafeAddress({ address }: { address: string }) {
  const t = useTranslations();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ address: string; ok: boolean }>();
  const current = feedback?.address === address ? feedback : undefined;
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(undefined), 2500);
    return () => clearTimeout(timer);
  }, [feedback]);

  async function copy(container: HTMLElement) {
    setBusy(true);
    setFeedback(undefined);
    try {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(address);
      } catch {
        // Some desktop webviews lack the async clipboard API. Keep the fallback
        // inside an open dialog so its input is not made inert by the modal.
        const active = document.activeElement;
        const input = document.createElement("textarea");
        input.value = address;
        input.readOnly = true;
        input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;";
        container.appendChild(input);
        try {
          input.focus({ preventScroll: true });
          input.select();
          if (!document.execCommand("copy")) throw new Error("Copy failed");
        } finally {
          input.remove();
          if (active instanceof HTMLElement) active.focus({ preventScroll: true });
        }
      }
      setFeedback({ address, ok: true });
    } catch {
      setFeedback({ address, ok: false });
    } finally { setBusy(false); }
  }

  return <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
    <span className="min-w-0 break-all font-mono text-xs leading-6" style={{ userSelect: "all" }}>{address}</span>
    <button type="button" disabled={busy} title={t(current?.ok ? "common.copied" : "features.safe-multisig.copyAddress")}
      aria-label={`${t("features.safe-multisig.copyAddress")} ${address}`}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500 disabled:opacity-50"
      onClick={e => { e.stopPropagation(); void copy(e.currentTarget.closest("dialog") || document.body); }}>
      {current?.ok ? <Check size={14} className="text-emerald-500" aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
    <span role="status" aria-live="polite" className={current?.ok ? "sr-only" : "text-xs text-red-400"}>
      {current ? t(current.ok ? "common.copied" : "features.safe-multisig.copyAddressFailed") : ""}
    </span>
  </div>;
}
