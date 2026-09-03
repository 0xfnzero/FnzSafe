"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  CheckCircle2,
  ChevronRight,
  CircleX,
  CircleUserRound,
  Clock3,
  Code2,
  Cookie,
  Download,
  EllipsisVertical,
  Eraser,
  ExternalLink,
  FileDown,
  History,
  KeyRound,
  LoaderCircle,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "@/hooks/useTranslations";
import { openUrlInChrome } from "@/lib/openExternal";
import {
  DEFAULT_BROWSER_SETTINGS,
  EMPTY_BROWSER_CONTACT,
  MAX_BROWSER_DOWNLOADS,
  mergeBrowserHistory,
  parseBrowserContact,
  parseBrowserDownloads,
  parseBrowserHistory,
  parseBrowserSettings,
  type BrowserContactState,
  type BrowserDownloadEntry,
  type BrowserHistoryEntry,
  type BrowserSettingsState,
} from "@/lib/browserStorage";

const HISTORY_KEY = "fnzsafe.browser.history.v1";
const DOWNLOADS_KEY = "fnzsafe.browser.downloads.v1";
const SETTINGS_KEY = "fnzsafe.browser.settings.v1";
const CONTACT_KEY = "fnzsafe.browser.contact.v1";

type BrowserDialog = "import" | "passwords" | "contact" | "downloads" | "history" | "clear" | "settings" | null;

interface BrowserMenuProps {
  activeTabId: string;
  currentUrl: string;
  tabOpen: boolean;
  onNavigate: (url: string) => void;
  onOverlayChange: (open: boolean) => void;
  importDialogRequest?: number;
  onImportDialogRequestHandled?: () => void;
  onChromeAuthImportCompleted?: () => void;
  addressField: ReactNode;
}

export const CHROME_AUTH_IMPORT_STORAGE_KEY = "fnzsafe.browser.chrome-auth-imported.v1";
export const CHROME_AUTH_IMPORT_EVENT = "fnzsafe:chrome-auth-imported";

interface ChromeProfileInfo {
  id: string;
  name: string;
  chrome_name: string;
  has_cookies: boolean;
  has_passwords: boolean;
  has_history: boolean;
}

interface BrowserCredentialSummary {
  id: string;
  origin: string;
  username: string;
  updated_at_ms: number;
}

interface ChromeImportResult {
  cookies_imported: number;
  passwords_imported: number;
  history_imported: number;
  cookies_skipped: number;
  passwords_skipped: number;
  history: BrowserHistoryEntry[];
}

type ChromeImportKind = "passwords" | "cookies" | "history";
type ChromeImportPhase = "select" | "running" | "complete";
type ChromeImportStatus = "idle" | "pending" | "running" | "success" | "error";

interface ChromeImportItemState {
  status: ChromeImportStatus;
  count: number;
  skipped: number;
  error?: string;
}

const EMPTY_IMPORT_ITEMS: Record<ChromeImportKind, ChromeImportItemState> = {
  passwords: { status: "idle", count: 0, skipped: 0 },
  cookies: { status: "idle", count: 0, skipped: 0 },
  history: { status: "idle", count: 0, skipped: 0 },
};

interface DappTabUrlEvent {
  tab_id: string;
  url: string;
  loaded: boolean;
}

interface DappDownloadEvent {
  tab_id: string;
  url: string;
  path: string;
  status: "started" | "completed" | "failed";
}

function readStored<T>(key: string, parse: (value: unknown) => T, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? parse(JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}

function errorText(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function formatTime(value: number): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function DialogShell({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <section
        className="max-h-[86vh] w-full max-w-2xl overflow-hidden rounded-lg border border-white/15 bg-[#15191f] text-gray-100 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex h-14 items-center justify-between border-b border-white/10 px-5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[calc(86vh-56px)] overflow-y-auto p-5">{children}</div>
      </section>
    </div>,
    document.body,
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 py-2 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-sky-400" />
    </label>
  );
}

export function BrowserMenu({
  activeTabId,
  currentUrl,
  tabOpen,
  onNavigate,
  onOverlayChange,
  importDialogRequest = 0,
  onImportDialogRequestHandled,
  onChromeAuthImportCompleted,
  addressField,
}: BrowserMenuProps) {
  const t = useTranslations();
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoFillMenuOpen, setAutoFillMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<BrowserDialog>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [zoom, setZoom] = useState(1);
  const [profiles, setProfiles] = useState<ChromeProfileInfo[]>([]);
  const [profileId, setProfileId] = useState("");
  const [importCookies, setImportCookies] = useState(true);
  const [importPasswords, setImportPasswords] = useState(true);
  const [importHistory, setImportHistory] = useState(true);
  const [importBusy, setImportBusy] = useState(false);
  const [importPhase, setImportPhase] = useState<ChromeImportPhase>("select");
  const [importItems, setImportItems] = useState<Record<ChromeImportKind, ChromeImportItemState>>(EMPTY_IMPORT_ITEMS);
  const [passwords, setPasswords] = useState<BrowserCredentialSummary[]>([]);
  const [history, setHistory] = useState<BrowserHistoryEntry[]>(() => readStored(HISTORY_KEY, parseBrowserHistory, []));
  const [downloads, setDownloads] = useState<BrowserDownloadEntry[]>(() => readStored(DOWNLOADS_KEY, parseBrowserDownloads, []));
  const [settings, setSettingsState] = useState<BrowserSettingsState>(() => readStored(SETTINGS_KEY, parseBrowserSettings, DEFAULT_BROWSER_SETTINGS));
  const [contact, setContact] = useState<BrowserContactState>(() => readStored(CONTACT_KEY, parseBrowserContact, EMPTY_BROWSER_CONTACT));
  const [clearSelection, setClearSelection] = useState({ browsing: true, history: true, downloads: true, passwords: false });
  const overlayOpen = menuOpen || findOpen || dialog !== null;

  const selectedProfile = useMemo(() => profiles.find((profile) => profile.id === profileId), [profileId, profiles]);

  useEffect(() => {
    onOverlayChange(overlayOpen);
    return () => onOverlayChange(false);
  }, [onOverlayChange, overlayOpen]);

  useEffect(() => {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    window.localStorage.setItem(DOWNLOADS_KEY, JSON.stringify(downloads));
  }, [downloads]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(CONTACT_KEY, JSON.stringify(contact));
  }, [contact]);

  const applyAutofill = useCallback(async (tabId: string) => {
    if (settings.autofillPasswords) {
      await invoke("browser_autofill", { tabId }).catch(() => undefined);
    }
    if (settings.autofillContacts && Object.values(contact).some((value) => value.trim())) {
      await invoke("browser_tab_action", { tabId, action: "autofill-contact", value: JSON.stringify(contact) }).catch(() => undefined);
    }
  }, [contact, settings.autofillContacts, settings.autofillPasswords]);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    Promise.all([
      listen<DappTabUrlEvent>("dapp://tab-url", (event) => {
        if (!event.payload.loaded) return;
        if (settings.saveHistory) {
          const entry: BrowserHistoryEntry = {
            url: event.payload.url,
            title: hostLabel(event.payload.url),
            visited_at_ms: Date.now(),
          };
          setHistory((items) => mergeBrowserHistory(items, [entry]));
        }
        window.setTimeout(() => void applyAutofill(event.payload.tab_id), 350);
      }),
      listen<DappDownloadEvent>("dapp://download", (event) => {
        setDownloads((items) => {
          const id = `${event.payload.tab_id}:${event.payload.url}:${event.payload.path}`;
          const next: BrowserDownloadEntry = { ...event.payload, id, updated_at_ms: Date.now() };
          return [next, ...items.filter((item) => item.id !== id)].slice(0, MAX_BROWSER_DOWNLOADS);
        });
      }),
    ]).then((cleanups) => {
      if (cancelled) cleanups.forEach((cleanup) => cleanup());
      else unlisteners.push(...cleanups);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      unlisteners.forEach((cleanup) => cleanup());
    };
  }, [applyAutofill, settings.saveHistory]);

  const runTabAction = async (action: string, value?: string) => {
    if (!tabOpen) {
      toast.error(t("features.dapp-store.browser.openPageFirst"));
      return;
    }
    try {
      await invoke("browser_tab_action", { tabId: activeTabId, action, value: value ?? null });
    } catch (error) {
      toast.error(errorText(error, t("features.dapp-store.browser.actionFailed")));
    }
  };

  const changeZoom = async (next: number) => {
    const normalized = Math.min(5, Math.max(0.25, Math.round(next * 4) / 4));
    setZoom(normalized);
    await runTabAction("zoom", String(normalized));
  };

  const openDialog = useCallback(async (next: BrowserDialog) => {
    setMenuOpen(false);
    setAutoFillMenuOpen(false);
    setDialog(next);
    if (next === "import") {
      setImportPhase("select");
      setImportItems(EMPTY_IMPORT_ITEMS);
      try {
        const list = await invoke<ChromeProfileInfo[]>("browser_chrome_profiles");
        setProfiles(list);
        setProfileId((current) => current && list.some((item) => item.id === current) ? current : list[0]?.id ?? "");
      } catch (error) {
        toast.error(errorText(error, t("features.dapp-store.browser.chromeUnavailable")));
      }
    }
    if (next === "passwords") {
      try {
        setPasswords(await invoke<BrowserCredentialSummary[]>("browser_passwords_list"));
      } catch (error) {
        toast.error(errorText(error, t("features.dapp-store.browser.passwordLoadFailed")));
      }
    }
  }, [t]);

  useEffect(() => {
    if (importDialogRequest <= 0) return;
    void openDialog("import");
    onImportDialogRequestHandled?.();
  }, [importDialogRequest, onImportDialogRequestHandled, openDialog]);

  const importFromChrome = async (retryKinds?: ChromeImportKind[]) => {
    const kinds = retryKinds ?? [
      ...(importPasswords ? ["passwords" as const] : []),
      ...(importCookies ? ["cookies" as const] : []),
      ...(importHistory ? ["history" as const] : []),
    ];
    if (!profileId || kinds.length === 0) return;
    setImportBusy(true);
    setImportPhase("running");
    setImportItems((current) => {
      const next = { ...current };
      for (const kind of kinds) next[kind] = { status: "pending", count: 0, skipped: 0 };
      return next;
    });
    let cookiesChanged = false;
    let authImportSucceeded = false;
    for (const kind of kinds) {
      setImportItems((current) => ({ ...current, [kind]: { status: "running", count: 0, skipped: 0 } }));
      try {
        const result = await invoke<ChromeImportResult>("browser_import_chrome", {
          request: {
            profile_id: profileId,
            cookies: kind === "cookies",
            passwords: kind === "passwords",
            history: kind === "history",
          },
        });
        const importedHistory = parseBrowserHistory(result.history);
        if (importedHistory.length) setHistory((items) => mergeBrowserHistory(items, importedHistory));
        const count = kind === "cookies" ? result.cookies_imported : kind === "passwords" ? result.passwords_imported : result.history_imported;
        const skipped = kind === "cookies" ? result.cookies_skipped : kind === "passwords" ? result.passwords_skipped : 0;
        if (kind === "cookies" && count > 0) cookiesChanged = true;
        if ((kind === "cookies" || kind === "passwords") && count > 0) authImportSucceeded = true;
        setImportItems((current) => ({ ...current, [kind]: { status: "success", count, skipped } }));
      } catch (error) {
        setImportItems((current) => ({
          ...current,
          [kind]: { status: "error", count: 0, skipped: 0, error: errorText(error, t("features.dapp-store.browser.importItemFailed")) },
        }));
      }
    }
    setImportPhase("complete");
    setImportBusy(false);
    if (authImportSucceeded) {
      window.localStorage.setItem(CHROME_AUTH_IMPORT_STORAGE_KEY, new Date().toISOString());
      window.dispatchEvent(new Event(CHROME_AUTH_IMPORT_EVENT));
      onChromeAuthImportCompleted?.();
    }
    if (cookiesChanged && tabOpen) await runTabAction("reload");
  };

  const autofillCurrentPage = async () => {
    setMenuOpen(false);
    setAutoFillMenuOpen(false);
    if (!tabOpen) {
      toast.error(t("features.dapp-store.browser.openPageFirst"));
      return;
    }
    try {
      const result = await invoke<{ filled: boolean; username?: string }>("browser_autofill", { tabId: activeTabId });
      if (Object.values(contact).some((value) => value.trim())) {
        await invoke("browser_tab_action", { tabId: activeTabId, action: "autofill-contact", value: JSON.stringify(contact) });
      }
      toast[result.filled ? "success" : "message"](
        result.filled ? t("features.dapp-store.browser.autofillComplete") : t("features.dapp-store.browser.noSavedPassword"),
      );
    } catch (error) {
      toast.error(errorText(error, t("features.dapp-store.browser.autofillFailed")));
    }
  };

  const deletePassword = async (credentialId: string) => {
    try {
      await invoke("browser_password_delete", { credentialId });
      setPasswords((items) => items.filter((item) => item.id !== credentialId));
    } catch (error) {
      toast.error(errorText(error, t("features.dapp-store.browser.passwordDeleteFailed")));
    }
  };

  const clearBrowserData = async () => {
    try {
      if (clearSelection.browsing && tabOpen) await runTabAction("clear-data");
      if (clearSelection.history) setHistory([]);
      if (clearSelection.downloads) setDownloads([]);
      if (clearSelection.passwords) {
        await invoke("browser_passwords_clear");
        setPasswords([]);
      }
      setDialog(null);
      toast.success(t("features.dapp-store.browser.clearComplete"));
    } catch (error) {
      toast.error(errorText(error, t("features.dapp-store.browser.clearFailed")));
    }
  };

  const menuItem = (icon: ReactNode, label: string, onClick: () => void, trailing?: ReactNode) => (
    <button type="button" onClick={onClick} className="flex h-10 w-full items-center gap-3 px-3 text-left text-sm text-gray-200 hover:bg-white/10">
      <span className="text-gray-400">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );

  const importRows: Array<{ kind: ChromeImportKind; label: string; icon: ReactNode; checked: boolean; setChecked: (value: boolean) => void }> = [
    { kind: "passwords", label: t("features.dapp-store.browser.savedPasswords"), icon: <KeyRound className="h-5 w-5" />, checked: importPasswords, setChecked: setImportPasswords },
    { kind: "cookies", label: "Cookie", icon: <Cookie className="h-5 w-5" />, checked: importCookies, setChecked: setImportCookies },
    { kind: "history", label: t("features.dapp-store.browser.history"), icon: <History className="h-5 w-5" />, checked: importHistory, setChecked: setImportHistory },
  ];
  const activeImportRow = importRows.find(({ kind }) => importItems[kind].status === "running");
  const failedImportKinds = importRows.filter(({ kind }) => importItems[kind].status === "error").map(({ kind }) => kind);

  return (
    <div className="relative flex min-w-0 flex-1 items-center gap-1">
      <button type="button" onClick={() => void runTabAction("back")} disabled={!tabOpen} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label={t("features.dapp-store.browser.back")}>
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => void runTabAction("forward")} disabled={!tabOpen} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label={t("features.dapp-store.browser.forward")}>
        <ArrowRight className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => void runTabAction("reload")} disabled={!tabOpen} className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label={t("features.dapp-store.browser.reload")}>
        <RefreshCw className="h-4 w-4" />
      </button>
      {addressField}
      <button
        type="button"
        onClick={() => {
          setMenuOpen((open) => !open);
          setAutoFillMenuOpen(false);
        }}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md text-gray-300 hover:bg-white/10 hover:text-white"
        aria-label={t("features.dapp-store.browser.menu")}
      >
        <EllipsisVertical className="h-5 w-5" />
      </button>

      {findOpen && (
        <div className="absolute right-0 top-11 z-[100] flex w-[min(420px,70vw)] items-center gap-2 rounded-lg border border-white/15 bg-[#20242a] p-2 shadow-2xl">
          <Search className="h-4 w-4 shrink-0 text-gray-400" />
          <input
            autoFocus
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void runTabAction(event.shiftKey ? "find-backward" : "find", findQuery);
              if (event.key === "Escape") setFindOpen(false);
            }}
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
            placeholder={t("features.dapp-store.browser.findPlaceholder")}
          />
          <button type="button" onClick={() => void runTabAction("find-backward", findQuery)} className="h-8 px-2 text-xs text-gray-300 hover:text-white">↑</button>
          <button type="button" onClick={() => void runTabAction("find", findQuery)} className="h-8 px-2 text-xs text-gray-300 hover:text-white">↓</button>
          <button type="button" onClick={() => setFindOpen(false)} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
      )}

      {menuOpen && (
        <div className="absolute right-0 top-11 z-[100] w-72 overflow-visible rounded-lg border border-white/15 bg-[#272a2f] py-1 shadow-2xl">
          {menuItem(<ExternalLink className="h-4 w-4" />, t("features.dapp-store.browser.openInChrome"), () => {
            setMenuOpen(false);
            if (!tabOpen || !currentUrl) {
              toast.error(t("features.dapp-store.browser.openPageFirst"));
              return;
            }
            void openUrlInChrome(currentUrl).catch((error) => {
              toast.error(errorText(error, t("features.dapp-store.browser.openInChromeFailed")));
            });
          })}
          <div className="my-1 border-t border-white/10" />
          {menuItem(<Search className="h-4 w-4" />, t("features.dapp-store.browser.find"), () => { setMenuOpen(false); setFindOpen(true); })}
          {menuItem(<Printer className="h-4 w-4" />, t("features.dapp-store.browser.print"), () => { setMenuOpen(false); void runTabAction("print"); })}
          <div className="flex h-11 items-center gap-2 px-3 text-sm">
            <span className="flex-1 text-gray-200">{t("features.dapp-store.browser.zoom")}</span>
            <button type="button" onClick={() => void changeZoom(zoom - 0.25)} className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/5 hover:bg-white/15"><Minus className="h-3.5 w-3.5" /></button>
            <button type="button" onClick={() => void changeZoom(1)} className="w-12 text-center text-xs text-gray-300">{Math.round(zoom * 100)}%</button>
            <button type="button" onClick={() => void changeZoom(zoom + 0.25)} className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-white/5 hover:bg-white/15"><Plus className="h-3.5 w-3.5" /></button>
          </div>
          {menuItem(<Code2 className="h-4 w-4" />, t("features.dapp-store.browser.devtools"), () => { setMenuOpen(false); void runTabAction("devtools"); })}
          {menuItem(<Camera className="h-4 w-4" />, t("features.dapp-store.browser.screenshot"), async () => {
            setMenuOpen(false);
            try { await invoke("browser_take_screenshot"); } catch (error) { toast.error(errorText(error, t("features.dapp-store.browser.screenshotFailed"))); }
          })}
          <div className="my-1 border-t border-white/10" />
          {menuItem(<Cookie className="h-4 w-4" />, t("features.dapp-store.browser.importChrome"), () => void openDialog("import"))}
          <div className="relative" onMouseEnter={() => setAutoFillMenuOpen(true)} onMouseLeave={() => setAutoFillMenuOpen(false)}>
            {menuItem(<KeyRound className="h-4 w-4" />, t("features.dapp-store.browser.passwordsAndAutofill"), () => setAutoFillMenuOpen((open) => !open), <ChevronRight className="h-4 w-4 text-gray-500" />)}
            {autoFillMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-60 overflow-hidden rounded-lg border border-white/15 bg-[#272a2f] py-1 shadow-2xl sm:right-full sm:top-0 sm:mr-1 sm:mt-0">
                {menuItem(<ShieldCheck className="h-4 w-4" />, t("features.dapp-store.browser.autofillNow"), () => void autofillCurrentPage())}
                {menuItem(<KeyRound className="h-4 w-4" />, t("features.dapp-store.browser.passwordManager"), () => void openDialog("passwords"))}
                {menuItem(<CircleUserRound className="h-4 w-4" />, t("features.dapp-store.browser.contactInfo"), () => void openDialog("contact"))}
              </div>
            )}
          </div>
          {menuItem(<Download className="h-4 w-4" />, t("features.dapp-store.browser.downloads"), () => void openDialog("downloads"))}
          {menuItem(<History className="h-4 w-4" />, t("features.dapp-store.browser.history"), () => void openDialog("history"))}
          {menuItem(<Eraser className="h-4 w-4" />, t("features.dapp-store.browser.clearData"), () => void openDialog("clear"))}
          <div className="my-1 border-t border-white/10" />
          {menuItem(<Settings className="h-4 w-4" />, t("features.dapp-store.browser.settings"), () => void openDialog("settings"))}
        </div>
      )}

      {dialog === "import" && (
        <DialogShell
          title={importPhase === "complete" ? t("features.dapp-store.browser.importCompleteTitle") : t("features.dapp-store.browser.importTitle")}
          onClose={() => { if (!importBusy) setDialog(null); }}
        >
          <p className="mb-4 text-sm text-gray-400">
            {importPhase === "select"
              ? t("features.dapp-store.browser.importHint")
              : importPhase === "running"
                ? t("features.dapp-store.browser.importingItem", { item: activeImportRow?.label ?? t("features.dapp-store.browser.browserData") })
                : t("features.dapp-store.browser.importCompleteHint")}
          </p>
          {profiles.length === 0 ? (
            <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100">{t("features.dapp-store.browser.noChromeProfiles")}</div>
          ) : (
            <div className="space-y-4">
              {importPhase === "select" && (
                <label className="block text-sm">
                  <span className="mb-2 block text-gray-400">{t("features.dapp-store.browser.importFrom")}</span>
                  <select value={profileId} onChange={(event) => setProfileId(event.target.value)} className="h-11 w-full rounded-md border border-white/10 bg-black/30 px-3 outline-none">
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.chrome_name ? ` - ${profile.chrome_name}` : ""}</option>)}
                  </select>
                </label>
              )}
              <div className="divide-y divide-white/10 rounded-lg border border-white/10 bg-black/20 px-4">
                {importRows.map((row) => {
                  const state = importItems[row.kind];
                  return (
                    <div key={row.kind} className="flex min-h-16 items-center gap-3 py-3">
                      <span className="shrink-0 text-gray-400">{row.icon}</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-100">{row.label}</p>
                        {importPhase !== "select" && state.status === "success" && (
                          <p className="mt-0.5 text-xs text-gray-400">
                            {state.skipped > 0
                              ? t("features.dapp-store.browser.importResultSkipped", { count: state.count, skipped: state.skipped })
                              : t("features.dapp-store.browser.importResult", { count: state.count })}
                          </p>
                        )}
                        {state.status === "error" && <p className="mt-0.5 break-words text-xs leading-5 text-red-300">{state.error}</p>}
                      </div>
                      {importPhase === "select" ? (
                        <input
                          type="checkbox"
                          checked={row.checked}
                          onChange={(event) => row.setChecked(event.target.checked)}
                          className="h-5 w-5 shrink-0 accent-sky-400"
                          aria-label={row.label}
                        />
                      ) : state.status === "success" ? (
                        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
                      ) : state.status === "error" ? (
                        <CircleX className="h-5 w-5 shrink-0 text-red-400" />
                      ) : (state.status === "pending" || state.status === "running") ? (
                        <LoaderCircle className="h-5 w-5 shrink-0 animate-spin text-gray-300" />
                      ) : null}
                    </div>
                  );
                })}
              </div>
              {importPhase === "select" && <p className="text-xs leading-5 text-gray-400">{t("features.dapp-store.browser.chromeConcurrentHint")}</p>}
              <div className="flex justify-end gap-2">
                {importPhase === "select" && (
                  <>
                    <button type="button" onClick={() => setDialog(null)} className="h-10 rounded-md border border-white/10 px-4 text-sm hover:bg-white/10">{t("common.cancel")}</button>
                    <button type="button" disabled={!profileId || !(importPasswords || importCookies || importHistory)} onClick={() => void importFromChrome()} className="h-10 rounded-md bg-white px-4 text-sm font-semibold text-black hover:bg-gray-200 disabled:opacity-40">
                      {t("features.dapp-store.browser.import")}
                    </button>
                  </>
                )}
                {importPhase === "running" && (
                  <button type="button" disabled className="inline-flex h-10 items-center gap-2 rounded-md bg-white px-4 text-sm font-semibold text-black opacity-60">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    {t("common.processing")}
                  </button>
                )}
                {importPhase === "complete" && (
                  <>
                    {failedImportKinds.length > 0 && (
                      <button type="button" onClick={() => void importFromChrome(failedImportKinds)} className="h-10 rounded-md border border-white/10 px-4 text-sm hover:bg-white/10">{t("features.dapp-store.browser.retry")}</button>
                    )}
                    <button type="button" onClick={() => setDialog(null)} className="h-10 rounded-md bg-white px-4 text-sm font-semibold text-black hover:bg-gray-200">{t("features.dapp-store.browser.done")}</button>
                  </>
                )}
              </div>
            </div>
          )}
          {selectedProfile && !(selectedProfile.has_cookies || selectedProfile.has_passwords || selectedProfile.has_history) && <p className="mt-3 text-xs text-red-300">{t("features.dapp-store.browser.profileEmpty")}</p>}
        </DialogShell>
      )}

      {dialog === "passwords" && (
        <DialogShell title={t("features.dapp-store.browser.passwordManager")} onClose={() => setDialog(null)}>
          {passwords.length === 0 ? <p className="text-sm text-gray-400">{t("features.dapp-store.browser.noPasswords")}</p> : (
            <div className="divide-y divide-white/10 rounded-lg border border-white/10">
              {passwords.map((item) => (
                <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                  <KeyRound className="h-4 w-4 shrink-0 text-gray-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.origin}</p>
                    <p className="truncate text-xs text-gray-500">{item.username || t("features.dapp-store.browser.noUsername")}</p>
                  </div>
                  <button type="button" onClick={() => void deletePassword(item.id)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-red-400/10 hover:text-red-300" aria-label={t("features.dapp-store.browser.delete")}><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
            </div>
          )}
        </DialogShell>
      )}

      {dialog === "contact" && (
        <DialogShell title={t("features.dapp-store.browser.contactInfo")} onClose={() => setDialog(null)}>
          <div className="grid gap-4 sm:grid-cols-2">
            {([
              ["full_name", t("features.dapp-store.browser.fullName")],
              ["email", t("features.dapp-store.browser.email")],
              ["phone", t("features.dapp-store.browser.phone")],
              ["address", t("features.dapp-store.browser.address")],
            ] as Array<[keyof BrowserContactState, string]>).map(([key, label]) => (
              <label key={key} className={key === "address" ? "sm:col-span-2" : ""}>
                <span className="mb-1.5 block text-xs text-gray-400">{label}</span>
                <input value={contact[key]} onChange={(event) => setContact((current) => ({ ...current, [key]: event.target.value.slice(0, 500) }))} className="h-10 w-full rounded-md border border-white/10 bg-black/30 px-3 text-sm outline-none focus:border-sky-400/50" />
              </label>
            ))}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setContact(EMPTY_BROWSER_CONTACT)} className="h-10 rounded-md border border-white/10 px-4 text-sm hover:bg-white/10">{t("features.dapp-store.browser.clear")}</button>
            <button type="button" onClick={() => { setDialog(null); toast.success(t("features.dapp-store.browser.saved")); }} className="h-10 rounded-md bg-white px-4 text-sm font-semibold text-black">{t("features.dapp-store.browser.save")}</button>
          </div>
        </DialogShell>
      )}

      {dialog === "downloads" && (
        <DialogShell title={t("features.dapp-store.browser.downloads")} onClose={() => setDialog(null)}>
          {downloads.length === 0 ? <p className="text-sm text-gray-400">{t("features.dapp-store.browser.noDownloads")}</p> : (
            <div className="space-y-2">
              {downloads.map((item) => (
                <button key={item.id} type="button" disabled={!item.path || item.status !== "completed"} onClick={() => void invoke("open_download_file_location", { path: item.path }).catch((error) => toast.error(errorText(error, t("features.dapp-store.browser.openDownloadFailed"))))} className="flex w-full items-center gap-3 rounded-lg border border-white/10 px-3 py-3 text-left hover:bg-white/5 disabled:cursor-default">
                  <FileDown className="h-4 w-4 shrink-0 text-gray-500" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm">{item.path.split(/[\\/]/).pop() || hostLabel(item.url)}</p><p className="truncate text-xs text-gray-500">{item.status} · {formatTime(item.updated_at_ms)}</p></div>
                  {item.status === "completed" && <ExternalLink className="h-4 w-4 text-gray-500" />}
                </button>
              ))}
            </div>
          )}
        </DialogShell>
      )}

      {dialog === "history" && (
        <DialogShell title={t("features.dapp-store.browser.history")} onClose={() => setDialog(null)}>
          {history.length === 0 ? <p className="text-sm text-gray-400">{t("features.dapp-store.browser.noHistory")}</p> : (
            <div className="space-y-1">
              {history.slice(0, 500).map((item) => (
                <button key={`${item.url}:${item.visited_at_ms}`} type="button" onClick={() => { setDialog(null); onNavigate(item.url); }} className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-white/5">
                  <Clock3 className="h-4 w-4 shrink-0 text-gray-600" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm">{item.title || hostLabel(item.url)}</p><p className="truncate text-xs text-gray-500">{item.url}</p></div>
                  <span className="shrink-0 text-[11px] text-gray-600">{formatTime(item.visited_at_ms)}</span>
                </button>
              ))}
            </div>
          )}
        </DialogShell>
      )}

      {dialog === "clear" && (
        <DialogShell title={t("features.dapp-store.browser.clearData")} onClose={() => setDialog(null)}>
          <div className="divide-y divide-white/10 rounded-lg border border-white/10 px-4">
            <Toggle checked={clearSelection.browsing} onChange={(checked) => setClearSelection((value) => ({ ...value, browsing: checked }))} label={t("features.dapp-store.browser.cookiesAndCache")} />
            <Toggle checked={clearSelection.history} onChange={(checked) => setClearSelection((value) => ({ ...value, history: checked }))} label={t("features.dapp-store.browser.history")} />
            <Toggle checked={clearSelection.downloads} onChange={(checked) => setClearSelection((value) => ({ ...value, downloads: checked }))} label={t("features.dapp-store.browser.downloadHistory")} />
            <Toggle checked={clearSelection.passwords} onChange={(checked) => setClearSelection((value) => ({ ...value, passwords: checked }))} label={t("features.dapp-store.browser.savedPasswords")} />
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={() => setDialog(null)} className="h-10 rounded-md border border-white/10 px-4 text-sm hover:bg-white/10">{t("common.cancel")}</button>
            <button type="button" onClick={() => void clearBrowserData()} className="h-10 rounded-md bg-red-500 px-4 text-sm font-semibold text-white hover:bg-red-400">{t("features.dapp-store.browser.clear")}</button>
          </div>
        </DialogShell>
      )}

      {dialog === "settings" && (
        <DialogShell title={t("features.dapp-store.browser.settings")} onClose={() => setDialog(null)}>
          <div className="divide-y divide-white/10 rounded-lg border border-white/10 px-4">
            <Toggle checked={settings.autofillPasswords} onChange={(checked) => setSettingsState((value) => ({ ...value, autofillPasswords: checked }))} label={t("features.dapp-store.browser.autofillPasswords")} />
            <Toggle checked={settings.autofillContacts} onChange={(checked) => setSettingsState((value) => ({ ...value, autofillContacts: checked }))} label={t("features.dapp-store.browser.autofillContacts")} />
            <Toggle checked={settings.saveHistory} onChange={(checked) => setSettingsState((value) => ({ ...value, saveHistory: checked }))} label={t("features.dapp-store.browser.saveHistory")} />
          </div>
          <p className="mt-4 text-xs leading-5 text-gray-500">{t("features.dapp-store.browser.securityNote")}</p>
        </DialogShell>
      )}
    </div>
  );
}
