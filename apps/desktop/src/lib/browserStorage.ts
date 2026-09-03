import { normalizePublicWebUrl } from "./publicWebUrl.ts";

export const MAX_BROWSER_HISTORY = 5_000;
export const MAX_BROWSER_DOWNLOADS = 500;

export interface BrowserHistoryEntry {
  url: string;
  title: string;
  visited_at_ms: number;
}

export interface BrowserDownloadEntry {
  id: string;
  tab_id: string;
  url: string;
  path: string;
  status: "started" | "completed" | "failed";
  updated_at_ms: number;
}

export interface BrowserSettingsState {
  autofillPasswords: boolean;
  autofillContacts: boolean;
  saveHistory: boolean;
}

export interface BrowserContactState {
  full_name: string;
  email: string;
  phone: string;
  address: string;
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettingsState = {
  autofillPasswords: true,
  autofillContacts: true,
  saveHistory: true,
};

export const EMPTY_BROWSER_CONTACT: BrowserContactState = {
  full_name: "",
  email: "",
  phone: "",
  address: "",
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function positiveTimestamp(value: unknown): number | null {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function normalizeDownloadSourceUrl(value: unknown): string | undefined {
  const candidate = boundedString(value, 2_048);
  const publicUrl = normalizePublicWebUrl(candidate);
  if (publicUrl) return publicUrl;
  try {
    const url = new URL(candidate);
    return url.protocol === "blob:" && normalizePublicWebUrl(url.pathname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function parseBrowserHistory(value: unknown): BrowserHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_BROWSER_HISTORY).flatMap((candidate) => {
    const item = recordValue(candidate);
    const url = normalizePublicWebUrl(item?.url);
    const visitedAt = positiveTimestamp(item?.visited_at_ms);
    if (!item || !url || visitedAt === null) return [];
    return [{ url, title: boundedString(item.title, 512), visited_at_ms: visitedAt }];
  });
}

export function mergeBrowserHistory(
  current: BrowserHistoryEntry[],
  incoming: BrowserHistoryEntry[],
): BrowserHistoryEntry[] {
  const byUrl = new Map<string, BrowserHistoryEntry>();
  for (const item of [...incoming, ...current]) {
    if (!item.url || byUrl.has(item.url)) continue;
    byUrl.set(item.url, item);
  }
  return [...byUrl.values()]
    .sort((left, right) => right.visited_at_ms - left.visited_at_ms)
    .slice(0, MAX_BROWSER_HISTORY);
}

export function parseBrowserDownloads(value: unknown): BrowserDownloadEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_BROWSER_DOWNLOADS).flatMap((candidate) => {
    const item = recordValue(candidate);
    const id = boundedString(item?.id, 4_096);
    const tabId = boundedString(item?.tab_id, 160);
    const url = normalizeDownloadSourceUrl(item?.url);
    const path = boundedString(item?.path, 4_096);
    const updatedAt = positiveTimestamp(item?.updated_at_ms);
    const status = item?.status;
    if (!id || !tabId || !url || !path || updatedAt === null || !["started", "completed", "failed"].includes(String(status))) {
      return [];
    }
    return [{ id, tab_id: tabId, url, path, status: status as BrowserDownloadEntry["status"], updated_at_ms: updatedAt }];
  });
}

export function parseBrowserSettings(value: unknown): BrowserSettingsState {
  const item = recordValue(value);
  return {
    autofillPasswords: typeof item?.autofillPasswords === "boolean" ? item.autofillPasswords : true,
    autofillContacts: typeof item?.autofillContacts === "boolean" ? item.autofillContacts : true,
    saveHistory: typeof item?.saveHistory === "boolean" ? item.saveHistory : true,
  };
}

export function parseBrowserContact(value: unknown): BrowserContactState {
  const item = recordValue(value);
  return {
    full_name: boundedString(item?.full_name, 500),
    email: boundedString(item?.email, 500),
    phone: boundedString(item?.phone, 500),
    address: boundedString(item?.address, 500),
  };
}
