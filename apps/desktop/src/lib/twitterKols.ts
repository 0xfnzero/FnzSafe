import { normalizePublicWebUrl } from "./publicWebUrl.ts";

export interface TwitterKolProfile {
  handle: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  followersLabel?: string;
  fomoFollowersLabel?: string;
  fomoFollowersUpdatedAt?: string;
  followingLabel?: string;
  location?: string;
  website?: string;
  joinedLabel?: string;
  verified?: boolean;
  addedAt: string;
  updatedAt?: string;
  sources?: TwitterKolSource[];
}

export type TwitterKolSource = "x" | "fomo";

export function filterTwitterKolsBySource(
  kols: TwitterKolProfile[],
  source: "all" | TwitterKolSource,
): TwitterKolProfile[] {
  if (source === "all") return kols;
  return kols.filter((kol) => (kol.sources || ["x"]).includes(source));
}

export interface CapturedFomoKolProfile {
  author: string;
  authorName?: string;
  avatarUrl?: string;
}

export interface CapturedFomoProfile {
  user_handle: string;
  display_name?: string | null;
  profile_picture_url?: string | null;
  followers: number;
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
  followed_by_viewer?: boolean;
}

interface CapturedTwitterAuthor {
  author_handle: string;
  author_name?: string;
  avatar_url?: string | null;
}

const TWITTER_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const FOMO_HANDLE_RE = /^[A-Za-z0-9_]{1,40}$/;
export const MAX_STORED_TWITTER_KOLS = 500;
export const AUTO_KOL_FOLLOWER_THRESHOLD = 20_000;

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

export function normalizeFomoKolHandle(value: string): string {
  const candidate = value.trim().replace(/^@+/, "").replace(/\/+$/, "");
  return FOMO_HANDLE_RE.test(candidate) ? candidate.toLowerCase() : "";
}

export function fomoKolProfileUrl(handle: string): string {
  return `https://fomo.family/profile/${encodeURIComponent(normalizeFomoKolHandle(handle))}`;
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
  return { handle: normalized, addedAt: now.toISOString(), sources: ["x"] };
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

export function twitterFollowerCount(value: string | null | undefined): number | null {
  const normalized = value
    ?.trim()
    .replace(/[,_\s]/g, "")
    .toUpperCase();
  if (!normalized) return null;
  const match = normalized.match(/(\d+(?:\.\d+)?)([KMB]|万|亿)?/u);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = {
    K: 1_000,
    M: 1_000_000,
    B: 1_000_000_000,
    "万": 10_000,
    "亿": 100_000_000,
  }[match[2] || ""] ?? 1;
  const followers = amount * multiplier;
  return Number.isFinite(followers) ? followers : null;
}

export function isAutomaticTwitterKol(profile: CapturedTwitterProfile): boolean {
  const followers = twitterFollowerCount(profile.followers_label);
  return followers !== null && followers >= AUTO_KOL_FOLLOWER_THRESHOLD;
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
    const storedSources = Array.isArray(item.sources) ? item.sources : undefined;
    const handle = typeof item.handle === "string"
      ? storedSources?.includes("fomo")
        ? normalizeFomoKolHandle(item.handle)
        : normalizeTwitterKolHandle(item.handle)
      : "";
    const addedAt = storedDate(item.addedAt);
    if (!handle || !addedAt || profiles.has(handle)) continue;
    profiles.set(handle, {
      handle,
      addedAt,
      displayName: storedString(item.displayName, 80),
      avatarUrl: normalizePublicWebUrl(item.avatarUrl),
      bio: storedString(item.bio, 400),
      followersLabel: storedString(item.followersLabel, 80),
      fomoFollowersLabel: storedString(item.fomoFollowersLabel, 80),
      fomoFollowersUpdatedAt: storedDate(item.fomoFollowersUpdatedAt),
      followingLabel: storedString(item.followingLabel, 80),
      location: storedString(item.location, 120),
      website: normalizePublicWebUrl(item.website, 512),
      joinedLabel: storedString(item.joinedLabel, 120),
      verified: typeof item.verified === "boolean" ? item.verified : undefined,
      updatedAt: storedDate(item.updatedAt),
      sources: storedSources
        ? (["x", "fomo"] as const).filter((source) => storedSources.includes(source))
        : ["x"],
    });
    if (profiles.size >= MAX_STORED_TWITTER_KOLS) break;
  }
  return Array.from(profiles.values());
}

export function fomoFollowersLabel(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return `${new Intl.NumberFormat("en-US", {
    notation: value >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 1_000 ? 1 : 0,
  }).format(value)} Followers`;
}

export function mergeCapturedFomoKols(
  kols: TwitterKolProfile[],
  profiles: CapturedFomoKolProfile[],
  capturedAt: Date,
): TwitterKolProfile[] {
  const capturedByHandle = new Map<string, CapturedFomoKolProfile>();
  for (const profile of profiles) {
    const handle = normalizeFomoKolHandle(profile.author);
    if (handle) capturedByHandle.set(handle, profile);
  }
  if (capturedByHandle.size === 0) return kols;

  const timestamp = capturedAt.toISOString();
  const next = kols.map((kol) => {
    const captured = capturedByHandle.get(kol.handle);
    if (!captured) return kol;
    capturedByHandle.delete(kol.handle);
    return {
      ...kol,
      displayName: cleanOptional(captured.authorName) ?? kol.displayName,
      avatarUrl: normalizePublicWebUrl(captured.avatarUrl) ?? kol.avatarUrl,
      sources: Array.from(new Set<TwitterKolSource>([...(kol.sources || ["x"]), "fomo"])),
      updatedAt: timestamp,
    };
  });
  for (const [handle, captured] of capturedByHandle) {
    if (next.length >= MAX_STORED_TWITTER_KOLS) break;
    next.push({
      handle,
      displayName: cleanOptional(captured.authorName),
      avatarUrl: normalizePublicWebUrl(captured.avatarUrl),
      sources: ["fomo"],
      addedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  return next;
}

export function mergeCapturedFomoProfile(
  kols: TwitterKolProfile[],
  expectedHandle: string,
  profile: CapturedFomoProfile,
  capturedAt: Date,
): { profiles: TwitterKolProfile[]; matched: boolean } {
  const expected = normalizeFomoKolHandle(expectedHandle);
  const handle = normalizeFomoKolHandle(profile.user_handle);
  const matched = Boolean(expected) && handle === expected;
  if (!matched) return { profiles: kols, matched: false };
  const timestamp = capturedAt.toISOString();
  let found = false;
  const profiles = kols.map((kol) => {
    if (normalizeFomoKolHandle(kol.handle) !== handle) return kol;
    found = true;
    return {
      ...kol,
      displayName: cleanOptional(profile.display_name) ?? kol.displayName,
      avatarUrl: normalizePublicWebUrl(profile.profile_picture_url) ?? kol.avatarUrl,
      fomoFollowersLabel: fomoFollowersLabel(profile.followers) ?? kol.fomoFollowersLabel,
      fomoFollowersUpdatedAt: timestamp,
      sources: Array.from(new Set<TwitterKolSource>([...(kol.sources || []), "fomo"])),
      updatedAt: timestamp,
    };
  });
  return { profiles: found ? profiles : kols, matched: found };
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
      sources: Array.from(new Set<TwitterKolSource>([...(kol.sources || []), "x"])),
      updatedAt: capturedAt.toISOString(),
    };
  });
  if (changed) return next;
  if (!isAutomaticTwitterKol(profile) || kols.length >= MAX_STORED_TWITTER_KOLS) {
    return kols;
  }
  const timestamp = capturedAt.toISOString();
  return [...kols, {
    handle,
    displayName: cleanOptional(profile.display_name),
    avatarUrl: normalizePublicWebUrl(profile.avatar_url),
    bio: cleanOptional(profile.bio),
    followersLabel: cleanOptional(profile.followers_label),
    followingLabel: cleanOptional(profile.following_label),
    location: cleanOptional(profile.location),
    website: normalizePublicWebUrl(profile.website, 512),
    joinedLabel: cleanOptional(profile.joined_label),
    verified: profile.verified,
    sources: ["x"],
    addedAt: timestamp,
    updatedAt: timestamp,
  }];
}

export function mergeDiscoveredTwitterProfile(
  kols: TwitterKolProfile[],
  expectedHandle: string,
  profile: CapturedTwitterProfile,
  capturedAt: Date,
): { profiles: TwitterKolProfile[]; matched: boolean; retained: boolean } {
  const expected = normalizeTwitterKolHandle(expectedHandle);
  const matched = Boolean(expected) && normalizeTwitterKolHandle(profile.handle) === expected;
  const profiles = matched ? mergeCapturedTwitterProfile(kols, profile, capturedAt) : kols;
  return {
    profiles,
    matched,
    retained: matched && profiles.some((kol) => kol.handle === expected),
  };
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
    const sources = Array.from(new Set<TwitterKolSource>([...(kol.sources || []), "x"]));
    if (displayName === kol.displayName && avatarUrl === kol.avatarUrl
      && sources.length === kol.sources?.length) return kol;
    changed = true;
    return { ...kol, displayName, avatarUrl, sources, updatedAt: capturedAt.toISOString() };
  });
  for (const [handle, author] of authors) {
    if (next.some((kol) => kol.handle === handle) || next.length >= MAX_STORED_TWITTER_KOLS) continue;
    changed = true;
    next.push({
      handle,
      displayName: cleanOptional(author.author_name),
      avatarUrl: normalizePublicWebUrl(author.avatar_url),
      sources: ["x"],
      addedAt: capturedAt.toISOString(),
      updatedAt: capturedAt.toISOString(),
    });
  }
  return changed ? next : kols;
}
