"use client";

import {useState} from "react";
import {useTranslations} from "@/hooks/useTranslations";

export function EvmRpcEditor({rpcUrl, defaultRpcUrl, onSave}: {
  rpcUrl: string;
  defaultRpcUrl?: string;
  onSave: (url: string) => Promise<void>;
}) {
  const translate = useTranslations();
  const t = (key: string) => translate(`features.settings.${key}`);
  const [url, setUrl] = useState(rpcUrl);
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);

  async function save(value: string) {
    setBusy(true);
    setMessage("");
    try {
      await onSave(value);
      setUrl(value);
      setFailed(false);
      setMessage(t("evmRpcSaved"));
    } catch {
      // Provider errors can contain API keys from the URL.
      setFailed(true);
      setMessage(t("evmRpcFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="mt-3 space-y-2">
    <label className="block text-xs text-gray-300">
      {t("evmRpcLabel")}
      <input type={visible ? "text" : "password"} value={url}
        onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false}
        disabled={busy} maxLength={2048}
        className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-black/20 px-3 text-sm text-white" />
    </label>
    <p className="text-xs text-gray-500">{t("evmRpcHint")}</p>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => setVisible((value) => !value)} className="rounded-lg border border-white/10 px-3 py-2 text-xs">{t(visible ? "evmRpcHide" : "evmRpcShow")}</button>
      <button type="button" disabled={busy || !url.trim()} onClick={() => void save(url.trim())} className="rounded-lg bg-white px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">{t(busy ? "evmRpcChecking" : "evmRpcSave")}</button>
      {defaultRpcUrl && <button type="button" disabled={busy || rpcUrl === defaultRpcUrl} onClick={() => void save(defaultRpcUrl)} className="rounded-lg border border-white/10 px-3 py-2 text-xs disabled:opacity-50">{t("evmRpcReset")}</button>}
    </div>
    {message && <p role={failed ? "alert" : "status"} className={failed ? "text-xs text-red-300" : "text-xs text-emerald-300"}>{message}</p>}
  </div>;
}
