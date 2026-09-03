import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BROWSER_DOWNLOADS,
  MAX_BROWSER_HISTORY,
  parseBrowserContact,
  parseBrowserDownloads,
  parseBrowserHistory,
  parseBrowserSettings,
} from "./browserStorage.ts";

test("browser storage parsers reject malformed shapes and unsafe URLs", () => {
  assert.deepEqual(parseBrowserHistory({ url: "https://example.com" }), []);
  assert.deepEqual(parseBrowserHistory([
    { url: "javascript:alert(1)", title: "bad", visited_at_ms: 1 },
    { url: "https://example.com/path", title: " Example ", visited_at_ms: 2 },
  ]), [{ url: "https://example.com/path", title: "Example", visited_at_ms: 2 }]);
  assert.deepEqual(parseBrowserDownloads([{ id: "one", tab_id: "tab", url: "file:///tmp/a", path: "/tmp/a", status: "completed", updated_at_ms: 1 }]), []);
  assert.equal(parseBrowserDownloads([{ id: "one", tab_id: "tab", url: "blob:https://example.com/id", path: "/tmp/a", status: "completed", updated_at_ms: 1 }]).length, 1);
});

test("browser storage parsers cap collections and preserve only typed preferences", () => {
  const history = Array.from({ length: MAX_BROWSER_HISTORY + 20 }, (_, index) => ({
    url: `https://example.com/${index}`,
    title: String(index),
    visited_at_ms: index + 1,
  }));
  assert.equal(parseBrowserHistory(history).length, MAX_BROWSER_HISTORY);
  const downloads = Array.from({ length: MAX_BROWSER_DOWNLOADS + 20 }, (_, index) => ({
    id: String(index), tab_id: "tab", url: `https://example.com/${index}`, path: `/tmp/${index}`,
    status: "completed", updated_at_ms: index + 1,
  }));
  assert.equal(parseBrowserDownloads(downloads).length, MAX_BROWSER_DOWNLOADS);
  assert.deepEqual(parseBrowserSettings({ autofillPasswords: false, autofillContacts: "no", saveHistory: false }), {
    autofillPasswords: false, autofillContacts: true, saveHistory: false,
  });
  assert.deepEqual(parseBrowserContact(["not", "an", "object"]), {
    full_name: "", email: "", phone: "", address: "",
  });
});
