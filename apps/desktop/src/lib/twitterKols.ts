import { normalizePublicWebUrl } from "./publicWebUrl.ts";

export interface TwitterKolProfile {
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  followersLabel?: string;
  followingLabel?: string;
  location?: string;
  website?: string;
  joinedLabel?: string;
  verified?: boolean;
  addedAt: string;
  updatedAt?: string;
}

export interface CapturedTwitterProfile {
  handle: string;
  display_name?: string;
  avatar_url?: string | null;
  bio?: string | null;
  followers_label?: string | null;
  following_label?: string | null;
  location?: string | null;
  website?: string | null;
  joined_label?: string | null;
  verified?: boolean;
}

interface CapturedTwitterAuthor {
  author_handle: string;
  author_name?: string;
  avatar_url?: string | null;
}

const TWITTER_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const MAX_STORED_TWITTER_KOLS = 500;

export type AppendTwitterKolResult = {
  profiles: TwitterKolProfile[];
  status: "added" | "duplicate" | "full";
};

export function appendTwitterKol(
  profiles: TwitterKolProfile[],
  profile: TwitterKolProfile,
): AppendTwitterKolResult {
  if (profiles.some((candidate) => candidate.handle === profile.handle)) {
    return { profiles, status: "duplicate" };
  }
  if (profiles.length >= MAX_STORED_TWITTER_KOLS) {
    return { profiles, status: "full" };
  }
  return { profiles: [...profiles, profile], status: "added" };
}

export function normalizeTwitterKolHandle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let candidate = trimmed.replace(/^@+/, "").replace(/\/+$/, "");
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (/^(?:www\.)?(?:x|twitter)\.com$/i.test(url.hostname)) {
      candidate = url.pathname.split("/").filter(Boolean)[0] || "";
    }
  } catch {
    // A plain handle is expected to fail URL parsing and is validated below.
  }
  return TWITTER_HANDLE_RE.test(candidate) ? candidate.toLowerCase() : "";
}

export function twitterKolProfileUrl(handle: string): string {
  return `https://x.com/${encodeURIComponent(normalizeTwitterKolHandle(handle))}`;
}

export function twitterWatchedUsersFromKols(kols: TwitterKolProfile[]): string {
  return kols.map((kol) => `@${kol.handle}`).join(", ");
}

export function createTwitterKolProfile(handle: string, now = new Date()): TwitterKolProfile | null {
  const normalized = normalizeTwitterKolHandle(handle);
  if (!normalized) return null;
  return { handle: normalized, addedAt: now.toISOString() };
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function storedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().slice(0, maxLength);
  return cleaned || undefined;
}

function storedDate(value: unknown): string | undefined {
  const candidate = storedString(value, 64);
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

export function parseStoredTwitterKols(value: unknown): TwitterKolProfile[] {
  if (!Array.isArray(value)) return [];
  const profiles = new Map<string, TwitterKolProfile>();
  for (const candidate of value.slice(0, MAX_STORED_TWITTER_KOLS)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const handle = typeof item.handle === "string" ? normalizeTwitterKolHandle(item.handle) : "";
    const addedAt = storedDate(item.addedAt);
    if (!handle || !addedAt || profiles.has(handle)) continue;
    profiles.set(handle, {
      handle,
      addedAt,
      displayName: storedString(item.displayName, 80),
      avatarUrl: normalizePublicWebUrl(item.avatarUrl),
      bio: storedString(item.bio, 400),
      followersLabel: storedString(item.followersLabel, 80),
      followingLabel: storedString(item.followingLabel, 80),
      location: storedString(item.location, 120),
      website: normalizePublicWebUrl(item.website, 512),
      joinedLabel: storedString(item.joinedLabel, 120),
      verified: typeof item.verified === "boolean" ? item.verified : undefined,
      updatedAt: storedDate(item.updatedAt),
    });
    if (profiles.size >= MAX_STORED_TWITTER_KOLS) break;
  }
  return Array.from(profiles.values());
}

export function mergeCapturedTwitterProfile(
  kols: TwitterKolProfile[],
  profile: CapturedTwitterProfile,
  capturedAt: Date,
): TwitterKolProfile[] {
  const handle = normalizeTwitterKolHandle(profile.handle);
  if (!handle) return kols;
  let changed = false;
  const next = kols.map((kol) => {
    if (kol.handle !== handle) return kol;
    changed = true;
    return {
      ...kol,
      displayName: cleanOptional(profile.display_name) ?? kol.displayName,
      avatarUrl: normalizePublicWebUrl(profile.avatar_url) ?? kol.avatarUrl,
      bio: cleanOptional(profile.bio) ?? kol.bio,
      followersLabel: cleanOptional(profile.followers_label) ?? kol.followersLabel,
      followingLabel: cleanOptional(profile.following_label) ?? kol.followingLabel,
      location: cleanOptional(profile.location) ?? kol.location,
      website: normalizePublicWebUrl(profile.website, 512) ?? kol.website,
      joinedLabel: cleanOptional(profile.joined_label) ?? kol.joinedLabel,
      verified: profile.verified ?? kol.verified,
      updatedAt: capturedAt.toISOString(),
    };
  });
  return changed ? next : kols;
}

export function mergeCapturedTwitterAuthors(
  kols: TwitterKolProfile[],
  tweets: CapturedTwitterAuthor[],
  capturedAt: Date,
): TwitterKolProfile[] {
  const authors = new Map<string, CapturedTwitterAuthor>();
  for (const tweet of tweets) {
    const handle = normalizeTwitterKolHandle(tweet.author_handle);
    if (handle) authors.set(handle, tweet);
  }
  let changed = false;
  const next = kols.map((kol) => {
    const author = authors.get(kol.handle);
    if (!author) return kol;
    const displayName = cleanOptional(author.author_name) ?? kol.displayName;
    const avatarUrl = normalizePublicWebUrl(author.avatar_url) ?? kol.avatarUrl;
    if (displayName === kol.displayName && avatarUrl === kol.avatarUrl) return kol;
    changed = true;
    return { ...kol, displayName, avatarUrl, updatedAt: capturedAt.toISOString() };
  });
  return changed ? next : kols;
}
