"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle } from "lucide-react";
import { useTranslations } from "@/hooks/useTranslations";

/** Mount for the lifetime of an operation. Elapsed time is never a completion estimate. */
export function OperationStatus({ label, detail, slowDetail, floating = false, className = "" }: {
  label: string; detail?: string; slowDetail?: string; floating?: boolean; className?: string;
}) {
  const t = useTranslations();
  const [startedAt] = useState(() => Date.now());
  const [seconds, setSeconds] = useState(0);
  const anchor = useRef<HTMLSpanElement>(null);
  const [portalRoot, setPortalRoot] = useState<Element | null>(null);
  useEffect(() => {
    if (floating) setPortalRoot(anchor.current?.closest(".app-shell") || document.body);
  }, [floating]);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const status = <div className={`operation-status ${floating ? "app-operation-status" : ""} ${className}`}>
    <LoaderCircle className="h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
    <div className="min-w-0 flex-1" role="status" aria-live="polite">
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-1 text-xs leading-relaxed opacity-80">{seconds >= 10 ? slowDetail || t("common.operationSlow") : detail || t("common.operationHint")}</p>
    </div>
    <span className="shrink-0 text-xs tabular-nums" aria-hidden="true">{seconds}s</span>
  </div>;
  // Desktop cards use backdrop-filter, which traps fixed descendants. Portal to
  // the themed shell so progress stays visible when a long form is scrolled.
  return floating ? <><span ref={anchor} hidden />{portalRoot && createPortal(status, portalRoot)}</> : status;
}
