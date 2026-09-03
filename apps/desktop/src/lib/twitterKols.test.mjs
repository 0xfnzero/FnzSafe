import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTwitterKol,
  createTwitterKolProfile,
  mergeCapturedTwitterProfile,
  normalizeTwitterKolHandle,
  parseStoredTwitterKols,
  twitterWatchedUsersFromKols,
} from "./twitterKols.ts";

test("normalizes handles and X profile URLs", () => {
  assert.equal(normalizeTwitterKolHandle("@0xSun"), "0xsun");
  assert.equal(normalizeTwitterKolHandle("https://x.com/VegaHao/"), "vegahao");
  assert.equal(normalizeTwitterKolHandle("not a handle"), "");
});

test("creates a stable watched-user filter from KOL records", () => {
  const first = createTwitterKolProfile("@0xSun", new Date("2026-09-02T00:00:00.000Z"));
  const second = createTwitterKolProfile("VegaHao", new Date("2026-09-02T00:00:00.000Z"));
  assert.ok(first);
  assert.ok(second);
  assert.equal(twitterWatchedUsersFromKols([first, second]), "@0xsun, @vegahao");
});

test("merges captured profile metadata only into a matching KOL", () => {
  const kol = createTwitterKolProfile("0xSun", new Date("2026-09-01T00:00:00.000Z"));
  assert.ok(kol);
  const result = mergeCapturedTwitterProfile([kol], {
    handle: "0xSun",
    display_name: "0xSun",
    bio: "Crypto research",
    followers_label: "128.4K Followers",
    following_label: "512 Following",
    verified: true,
  }, new Date("2026-09-02T00:00:00.000Z"));
  assert.equal(result[0].displayName, "0xSun");
  assert.equal(result[0].followersLabel, "128.4K Followers");
  assert.equal(result[0].updatedAt, "2026-09-02T00:00:00.000Z");
});

test("parses stored KOLs defensively, normalizes handles, and removes duplicates", () => {
  const records = parseStoredTwitterKols([
    { handle: "@0xSun", addedAt: "2026-09-01T00:00:00.000Z", displayName: "  0xSun  ", verified: true },
    { handle: "0XSUN", addedAt: "2026-09-02T00:00:00.000Z" },
    { handle: "valid_two", addedAt: "not-a-date" },
    { handle: "valid_three", addedAt: "2026-09-02T00:00:00.000Z", bio: { broken: true } },
    null,
  ]);

  assert.deepEqual(records.map(({ handle, addedAt }) => ({ handle, addedAt })), [
    { handle: "0xsun", addedAt: "2026-09-01T00:00:00.000Z" },
    { handle: "valid_three", addedAt: "2026-09-02T00:00:00.000Z" },
  ]);
  assert.equal(records[0].displayName, "0xSun");
  assert.equal(records[0].verified, true);
  assert.equal(records[1].bio, undefined);
});

test("bounds the stored KOL cache", () => {
  const records = parseStoredTwitterKols(Array.from({ length: 600 }, (_, index) => ({
    handle: `k${index}`,
    addedAt: "2026-09-02T00:00:00.000Z",
  })));
  assert.equal(records.length, 500);
});

test("appends KOLs without duplicates or exceeding the ingest limit", () => {
  const first = createTwitterKolProfile("first", new Date("2026-09-02T00:00:00.000Z"));
  assert.ok(first);
  const added = appendTwitterKol([], first);
  assert.equal(added.status, "added");
  assert.equal(appendTwitterKol(added.profiles, first).status, "duplicate");

  const full = Array.from({ length: 500 }, (_, index) => ({
    handle: `k${index}`,
    addedAt: "2026-09-02T00:00:00.000Z",
  }));
  const overflow = appendTwitterKol(full, first);
  assert.equal(overflow.status, "full");
  assert.strictEqual(overflow.profiles, full);
});

test("drops unsafe cached and captured profile URLs", () => {
  const [stored] = parseStoredTwitterKols([{
    handle: "first",
    addedAt: "2026-09-02T00:00:00.000Z",
    avatarUrl: "javascript:alert(1)",
    website: "https://user:secret@example.com/",
  }]);
  assert.equal(stored.avatarUrl, undefined);
  assert.equal(stored.website, undefined);

  const merged = mergeCapturedTwitterProfile([stored], {
    handle: "first",
    avatar_url: "data:image/svg+xml,bad",
    website: "https://example.com/profile",
  }, new Date("2026-09-03T00:00:00.000Z"));
  assert.equal(merged[0].avatarUrl, undefined);
  assert.equal(merged[0].website, "https://example.com/profile");
});
