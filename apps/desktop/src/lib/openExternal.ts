import { invoke } from "@tauri-apps/api/core";
import { isSafeUrlHostname } from "@/lib/appStorage";

function isTauriWebview(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Open a URL in the system default browser (Tauri) or a new tab (web). */
export async function openExternalUrl(url: string): Promise<void> {
  return openValidatedExternalUrl(url, "open_external_url");
}

/** Open a URL in Google Chrome, preserving the web fallback for local development. */
export async function openUrlInChrome(url: string): Promise<void> {
  return openValidatedExternalUrl(url, "open_url_in_chrome");
}

async function openValidatedExternalUrl(
  url: string,
  command: "open_external_url" | "open_url_in_chrome",
): Promise<void> {
  const target = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error("invalid external URL");
  }
  if (
    parsed.protocol !== "https:" ||
    !isSafeUrlHostname(parsed.hostname) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("only https URLs can be opened externally");
  }

  if (isTauriWebview()) {
    await invoke(command, { url: target });
    return;
  }

  const opened = window.open(target, "_blank", "noopener,noreferrer");
  if (!opened) {
    throw new Error("failed to open external browser");
  }
}
