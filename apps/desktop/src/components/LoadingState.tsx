"use client";

import { LoaderCircle, SearchX, WalletCards } from "lucide-react";
import { useTranslations } from "@/hooks/useTranslations";

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`ui-skeleton ${className}`} />;
}

/** Initial loading preserves the shape of the incoming content. No fake progress. */
export function LoadingState({ label, rows = 3, layout = "list" }: {
  label?: string; rows?: number; layout?: "list" | "cards";
}) {
  const t = useTranslations();
  return <div className="ui-loading-state" role="status" aria-live="polite">
    <div className="ui-loading-label"><LoaderCircle size={16} className="animate-spin" aria-hidden="true" />{label || t("common.loading")}</div>
    <div className={layout === "cards" ? "grid gap-3 sm:grid-cols-2" : "space-y-3"} aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => <div className="ui-skeleton-row" key={index}>
        <Skeleton className="h-11 w-11 shrink-0 !rounded-xl" />
        <div className="min-w-0 flex-1 space-y-3"><Skeleton className="h-3 w-2/5" /><Skeleton className="h-2.5 w-3/4" /></div>
        <Skeleton className="h-4 w-16 shrink-0" />
      </div>)}
    </div>
  </div>;
}

/** Refresh existing data in place instead of replacing it with an empty screen. */
export function RefreshStatus({ label }: { label?: string }) {
  const t = useTranslations();
  return <div className="ui-refresh-status" role="status" aria-live="polite">
    <div className="flex items-center gap-2"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /><span>{label || t("desktopUi.refreshing")}</span></div>
    <div className="ui-progress-track" aria-hidden="true"><span /></div>
  </div>;
}

export function EmptyState({ title, description, search = false }: { title: string; description?: string; search?: boolean }) {
  const Icon = search ? SearchX : WalletCards;
  return <div className="ui-empty-state">
    <span className="ui-empty-icon"><Icon size={24} aria-hidden="true" /></span>
    <p className="font-medium">{title}</p>
    {description && <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>}
  </div>;
}

export function LoadingValue({ className = "h-5 w-24" }: { className?: string }) {
  const t = useTranslations();
  return <span role="status"><span className="sr-only">{t("common.loading")}</span><Skeleton className={className} /></span>;
}
