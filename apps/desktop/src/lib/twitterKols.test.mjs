import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTwitterKol,
  createTwitterKolProfile,
  filterTwitterKolsBySource,
  isAutomaticTwitterKol,
  mergeCapturedTwitterProfile,
  mergeCapturedFomoKols,
  mergeCapturedFomoProfile,
  mergeDiscoveredTwitterProfile,
  normalizeTwitterKolHandle,
  parseStoredTwitterKols,
  twitterFollowerCount,
  twitterWatchedUsersFromKols,
} from "./twitterKols.ts";

test("offers only accounts belonging to the selected signal source", () => {
  const kols = [
    { handle: "xonly", addedAt: "2026-09-05T00:00:00.000Z", sources: ["x"] },
    { handle: "fomoonly", addedAt: "2026-09-05T00:00:00.000Z", sources: ["fomo"] },
    { handle: "shared", addedAt: "2026-09-05T00:00:00.000Z", sources: ["x", "fomo"] },
  ];

  assert.deepEqual(filterTwitterKolsBySource(kols, "x").map(({ handle }) => handle), ["xonly", "shared"]);
  assert.deepEqual(filterTwitterKolsBySource(kols, "fomo").map(({ handle }) => handle), ["fomoonly", "shared"]);
  assert.equal(filterTwitterKolsBySource(kols, "all"), kols);
});

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

test("parses localized follower counts and accepts at least 20,000 for automatic KOLs", () => {
  assert.equal(twitterFollowerCount("20,001 Followers"), 20_001);
  assert.equal(twitterFollowerCount("20.1K Followers"), 20_100);
  assert.equal(twitterFollowerCount("2.1万 粉丝"), 21_000);
  assert.equal(twitterFollowerCount("1.25M Followers"), 1_250_000);
  assert.equal(twitterFollowerCount("unknown"), null);
  assert.equal(isAutomaticTwitterKol({ followers_label: "20K Followers", followed_by_viewer: false }), true);
  assert.equal(isAutomaticTwitterKol({ followers_label: "2万 粉丝" }), true);
  assert.equal(isAutomaticTwitterKol({ followers_label: "20,001 Followers", followed_by_viewer: true }), true);
  assert.equal(isAutomaticTwitterKol({ followers_label: "19,999 Followers", followed_by_viewer: true }), false);
});

test("automatically adds a captured profile with more than 20,000 followers", () => {
  const result = mergeCapturedTwitterProfile([], {
    handle: "SignalAuthor",
    display_name: "Signal Author",
    followers_label: "20.1K Followers",
    verified: true,
    followed_by_viewer: false,
  }, new Date("2026-09-04T00:00:00.000Z"));
  assert.equal(result.length, 1);
  assert.equal(result[0].handle, "signalauthor");
  assert.equal(result[0].followersLabel, "20.1K Followers");
  assert.equal(result[0].addedAt, "2026-09-04T00:00:00.000Z");

  assert.deepEqual(mergeCapturedTwitterProfile([], {
    handle: "threshold",
    followers_label: "20K Followers",
    followed_by_viewer: false,
  }, new Date()).map(({ handle }) => handle), ["threshold"]);
});

test("adds Fomo users and combines source categories for an existing X KOL", () => {
  const existing = createTwitterKolProfile("chefjin", new Date("2026-09-04T00:00:00.000Z"));
  assert.ok(existing);
  const result = mergeCapturedFomoKols([existing], [{
    author: "@chefjin",
    authorName: "Chef Jin",
    avatarUrl: "https://example.com/chef.png",
  }, {
    author: "@fomoonly",
    authorName: "Fomo Only",
  }], new Date("2026-09-05T00:00:00.000Z"));

  assert.equal(result.length, 2);
  assert.deepEqual(result[0].sources, ["x", "fomo"]);
  assert.equal(result[0].followersLabel, undefined);
  assert.equal(result[0].fomoFollowersLabel, undefined);
  assert.deepEqual(result[1].sources, ["fomo"]);
  assert.equal(result[1].fomoFollowersLabel, undefined);

  const enriched = mergeCapturedFomoProfile(result, "chefjin", {
    user_handle: "ChefJin",
    display_name: "Chef Jin on Fomo",
    followers: 12_345,
  }, new Date("2026-09-05T00:01:30.000Z"));
  assert.equal(enriched.matched, true);
  assert.equal(enriched.profiles[0].fomoFollowersLabel, "12.3K Followers");
  assert.equal(enriched.profiles[0].followersLabel, undefined);
  assert.equal(enriched.profiles[0].fomoFollowersUpdatedAt, "2026-09-05T00:01:30.000Z");
});

test("rejects a discovered profile when navigation returns a different handle", () => {
  const profile = {
    handle: "redirected",
    followers_label: "1M Followers",
    followed_by_viewer: true,
  };
  const current = [];
  const mismatch = mergeDiscoveredTwitterProfile(current, "expected", profile, new Date());
  assert.equal(mismatch.matched, false);
  assert.equal(mismatch.retained, false);
  assert.strictEqual(mismatch.profiles, current);
  const match = mergeDiscoveredTwitterProfile(current, "redirected", profile, new Date());
  assert.equal(match.matched, true);
  assert.equal(match.retained, true);
  assert.equal(match.profiles.length, 1);
});

test("allows an under-threshold discovered profile to be checked again later", () => {
  const belowThreshold = mergeDiscoveredTwitterProfile([], "growing", {
    handle: "growing",
    followers_label: "19,999 Followers",
  }, new Date("2026-09-04T00:00:00.000Z"));
  assert.equal(belowThreshold.matched, true);
  assert.equal(belowThreshold.retained, false);

  const reachedThreshold = mergeDiscoveredTwitterProfile(belowThreshold.profiles, "growing", {
    handle: "growing",
    followers_label: "20K Followers",
  }, new Date("2026-09-05T00:00:00.000Z"));
  assert.equal(reachedThreshold.retained, true);
  assert.equal(reachedThreshold.profiles.length, 1);
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

test("preserves Fomo-only handles and platform follower metadata", () => {
  const [record] = parseStoredTwitterKols([{
    handle: "Long_Fomo_Profile_Handle_123",
    addedAt: "2026-09-05T00:00:00.000Z",
    sources: ["fomo"],
    followersLabel: "99K Followers",
    fomoFollowersLabel: "321 Followers",
    fomoFollowersUpdatedAt: "2026-09-05T00:01:30.000Z",
  }]);
  assert.equal(record.handle, "long_fomo_profile_handle_123");
  assert.equal(record.followersLabel, "99K Followers");
  assert.equal(record.fomoFollowersLabel, "321 Followers");
  assert.deepEqual(record.sources, ["fomo"]);
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
