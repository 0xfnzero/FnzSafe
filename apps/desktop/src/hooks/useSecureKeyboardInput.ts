"use client";

import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

function isTauriWebview(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isPasswordInput(target: EventTarget | null): target is HTMLInputElement {
  return target instanceof HTMLInputElement && target.type === "password";
}

export function useSecureKeyboardInput(): void {
  useEffect(() => {
    if (!isTauriWebview()) return;

    let desired = false;
    let applied = false;
    let syncing = false;

    const applyDesiredState = async () => {
      if (syncing) return;
      syncing = true;
      try {
        while (applied !== desired) {
          const next = desired;
          try {
            await invoke("set_secure_keyboard_input", { enabled: next });
          } catch {
            // The native command is best-effort; never block password entry.
          }
          applied = next;
        }
      } finally {
        syncing = false;
      }
    };

    const setDesiredState = (enabled: boolean) => {
      desired = enabled;
      void applyDesiredState();
    };
    const syncWithFocus = () => {
      setDesiredState(
        document.visibilityState === "visible" &&
          document.hasFocus() &&
          isPasswordInput(document.activeElement),
      );
    };
    const handleFocusOut = () => queueMicrotask(syncWithFocus);
    const disable = () => setDesiredState(false);

    document.addEventListener("focusin", syncWithFocus);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("visibilitychange", syncWithFocus);
    window.addEventListener("focus", syncWithFocus);
    window.addEventListener("blur", disable);
    window.addEventListener("pagehide", disable);
    syncWithFocus();

    return () => {
      document.removeEventListener("focusin", syncWithFocus);
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("visibilitychange", syncWithFocus);
      window.removeEventListener("focus", syncWithFocus);
      window.removeEventListener("blur", disable);
      window.removeEventListener("pagehide", disable);
      disable();
    };
  }, []);
}
