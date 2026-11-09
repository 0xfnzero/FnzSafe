"use client";

import { useId, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";

/** The scroll viewport must shrink independently of the header and decision buttons. */
export function DappApprovalDialog({ title, subtitle, origin, cancelLabel, busy, onReject, actions, children }: {
  title: string;
  subtitle: string;
  origin: string;
  cancelLabel: string;
  busy: boolean;
  onReject: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-3">
    <button type="button" aria-label={cancelLabel} disabled={busy} className="absolute inset-0 cursor-default" onClick={onReject} tabIndex={-1} />
    <section role="dialog" aria-modal="true" aria-labelledby={titleId} className="relative flex max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 text-white shadow-2xl">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 px-5 py-4">
        <div className="min-w-0">
          <h3 id={titleId} className="text-lg font-semibold">{title}</h3>
          <p className="mt-1 break-words text-sm text-gray-400">{subtitle}</p>
          <p className="mt-1 break-all text-xs text-gray-500">{origin}</p>
        </div>
        <button type="button" aria-label={cancelLabel} disabled={busy} onClick={onReject} className="shrink-0 rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20 disabled:opacity-50"><X className="h-4 w-4" /></button>
      </header>
      <div data-dapp-approval-scroll tabIndex={0} aria-label={title} className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4 outline-offset-[-3px]">
        {children}
      </div>
      <footer className="grid shrink-0 grid-cols-2 gap-3 border-t border-white/10 bg-zinc-950 px-5 py-4">{actions}</footer>
    </section>
  </div>;
}

/** Only the displayed excerpt is shortened. Expanded content retains every byte. */
export function DappRequestContent({ title, value, expandLabel, collapseLabel }: {
  title: string;
  value: string;
  expandLabel: string;
  collapseLabel: string;
}) {
  const excerpt = value.split("\n").slice(0, 3).join("\n").slice(0, 180);
  return <details className="group min-w-0 rounded-lg border border-sky-300/15 bg-black/20">
    <summary className="cursor-pointer list-none rounded-lg p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-300 [&::-webkit-details-marker]:hidden">
      <span className="flex items-center justify-between gap-3">
        <span className="min-w-0 break-words text-xs font-medium text-sky-100">{title}</span>
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-sky-100/70">
          <span className="group-open:hidden">{expandLabel}</span><span className="hidden group-open:inline">{collapseLabel}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
        </span>
      </span>
      <span className="mt-2 line-clamp-3 whitespace-pre-wrap break-all text-xs leading-relaxed text-sky-50/70 group-open:hidden">{excerpt}{excerpt.length < value.length ? "…" : ""}</span>
    </summary>
    <pre tabIndex={0} aria-label={title} className="select-text whitespace-pre-wrap break-all border-t border-sky-300/15 p-3 text-xs leading-relaxed text-sky-50">{value}</pre>
  </details>;
}
