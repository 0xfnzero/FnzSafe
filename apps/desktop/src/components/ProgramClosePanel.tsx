"use client";

import { useRef, useState } from "react";
import { useTranslations } from "@/hooks/useTranslations";
import { apiFetch } from "@/lib/apiFetch";
import { canConfirmProgramClose, lamportsAsSol, type ProgramClosePreview } from "@/lib/programClose";

interface Props {
  initiallyOpen?: boolean;
  walletId: string;
  walletAddress: string;
  network: string;
  expectedGenesisHash: string;
  onClosed: () => void;
}

interface Discovery {
  wallet_id: string;
  authority: string;
  network: string;
  genesis_hash: string;
  programs: { program_id: string; programdata_address: string; refundable_lamports: string }[];
}

interface Receipt {
  signature: string;
  finalized_slot: number;
  program_id: string;
  recipient: string;
  expected_refund_lamports: string;
  actual_refunded_lamports: string | null;
  fee_lamports: string | null;
  readback_verified: boolean;
  status: string;
}

async function post<T>(path: string, body: object): Promise<T> {
  const response = await apiFetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data as T;
}

export function ProgramClosePanel({ initiallyOpen = false, walletId, walletAddress, network, expectedGenesisHash, onClosed }: Props) {
  const t = useTranslations();
  const [programId, setProgramId] = useState("");
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [preview, setPreview] = useState<ProgramClosePreview | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const pending = useRef(false);
  const inputClass = "w-full rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-gray-100";
  const label = (key: string) => t(`features.program-close.${key}`);

  const discover = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError(""); setDiscovery(null); setPreview(null); setPassword("");
    setConfirmation(""); setAcknowledged(false); setReceipt(null);
    try {
      const result = await post<Discovery>("program/close/discover", {
        wallet_id: walletId, network, expected_genesis_hash: expectedGenesisHash,
      });
      if (result.wallet_id !== walletId || result.authority !== walletAddress
        || result.network !== network || result.genesis_hash !== expectedGenesisHash) {
        throw new Error(label("previewMismatch"));
      }
      setDiscovery(result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  };

  const inspect = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setPreview(null); setConfirmation(""); setAcknowledged(false); setError(""); setReceipt(null); setPassword("");
    try {
      const result = await post<ProgramClosePreview>("program/close/preview", {
        wallet_id: walletId, program_id: programId.trim(), network, expected_genesis_hash: expectedGenesisHash,
      });
      if (result.wallet_id !== walletId || result.authority !== walletAddress || result.recipient !== walletAddress
        || result.program_id !== programId.trim() || result.network !== network || result.genesis_hash !== expectedGenesisHash) {
        throw new Error(label("previewMismatch"));
      }
      setPreview(result);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  };

  const close = async () => {
    if (pending.current || !canConfirmProgramClose(preview, walletId, programId.trim(), confirmation, acknowledged)) return;
    pending.current = true;
    setBusy(true); setError("");
    try {
      const result = await post<Receipt>("program/close/submit", {
        preview_id: preview!.preview_id, wallet_id: walletId, confirmation_program_id: confirmation,
        acknowledge_permanent_close: acknowledged, ...(password ? { password } : {}),
      });
      setReceipt(result);
      setDiscovery(null);
      onClosed();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally {
      setPassword(""); setPreview(null); setConfirmation(""); setAcknowledged(false);
      pending.current = false; setBusy(false);
    }
  };

  const downloadReceipt = () => {
    if (!receipt) return;
    const blob = new Blob([JSON.stringify({ ...receipt, network, genesis_hash: expectedGenesisHash }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `program-close-${receipt.program_id}.json`; link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <details open={initiallyOpen} className="rounded-xl border border-red-400/20 bg-red-400/5 p-4">
      <summary className="cursor-pointer text-sm font-semibold text-red-200">{label("title")}</summary>
      <div className="mt-4 space-y-3">
        <p className="text-sm text-red-200">{label("warning")}</p>
        <p className="break-all text-xs text-gray-400">{network} · {label("wallet")}: {walletAddress || "—"}</p>
        <p className="text-xs text-gray-400">{label("discoverHelp")}</p>
        <button type="button" disabled={busy || !walletId || !walletAddress}
          className="rounded-lg bg-white/10 px-3 py-2 text-sm disabled:opacity-40" onClick={() => void discover()}>
          {busy ? label("processing") : label("discover")}
        </button>
        {discovery && <div className="space-y-2">
          <p role="status" className="text-xs text-gray-400">{discovery.programs.length ? label("discovered") : label("noPrograms")}</p>
          {discovery.programs.map((program) => <button key={program.program_id} type="button" disabled={busy}
            className={`block w-full break-all rounded-lg border p-3 text-left text-xs ${programId === program.program_id ? "border-red-300/50 bg-red-400/10" : "border-white/10 bg-black/20"}`}
            onClick={() => { setProgramId(program.program_id); setPreview(null); setConfirmation(""); setAcknowledged(false); setPassword(""); setReceipt(null); setError(""); }}>
            <span className="block font-mono">{program.program_id}</span>
            <span className="mt-1 block text-gray-400">{label("refund")}: {lamportsAsSol(program.refundable_lamports)} SOL</span>
          </button>)}
        </div>}
        <label className="block space-y-1 text-xs text-gray-300">
          <span>Program ID</span>
          <input aria-label="Program ID" className={inputClass} value={programId} disabled={busy} autoComplete="off"
            onChange={(e) => { setProgramId(e.target.value); setPreview(null); setConfirmation(""); setAcknowledged(false); setPassword(""); setReceipt(null); setError(""); }} />
        </label>
        <button type="button" disabled={busy || !walletId || !walletAddress || !programId.trim()}
          className="rounded-lg bg-white/10 px-3 py-2 text-sm disabled:opacity-40" onClick={() => void inspect()}>
          {busy ? label("processing") : label("inspect")}
        </button>
        {preview && <div className="space-y-3 rounded-lg bg-black/20 p-3">
          <dl className="space-y-2 break-all text-xs text-gray-300">
            <div><dt>Upgrade Authority / {label("recipient")}</dt><dd>{preview.recipient}</dd></div>
            <div><dt>ProgramData</dt><dd>{preview.programdata_address}</dd></div>
            <div><dt>{label("refund")}</dt><dd className="text-base text-green-300">{lamportsAsSol(preview.refundable_lamports)} SOL</dd></div>
            <div><dt>{label("fee")}</dt><dd>{lamportsAsSol(preview.estimated_fee_lamports)} SOL</dd></div>
            <div><dt>{label("net")}</dt><dd>{lamportsAsSol((BigInt(preview.refundable_lamports) - BigInt(preview.estimated_fee_lamports)).toString())} SOL</dd></div>
            <div><dt>{label("retained")}</dt><dd>{lamportsAsSol(preview.retained_program_lamports)} SOL</dd></div>
            <div><dt>Genesis hash / finalized slot</dt><dd>{preview.genesis_hash} / {preview.context_slot}</dd></div>
          </dl>
          <p className="text-xs text-gray-400">{label("scope")}</p>
          <label className="flex items-start gap-2 text-sm text-red-200">
            <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} />
            {label("acknowledge")}
          </label>
          <label className="block space-y-1 text-xs text-gray-300"><span>{label("typeId")}</span>
            <input className={inputClass} value={confirmation} disabled={busy} autoComplete="off" spellCheck={false} onChange={(e) => setConfirmation(e.target.value)} />
          </label>
          <label className="block space-y-1 text-xs text-gray-300"><span>{label("password")}</span>
            <input type="password" data-sensitive-field="password" className={inputClass} value={password} disabled={busy}
              autoComplete="off" onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button type="button" disabled={busy || !canConfirmProgramClose(preview, walletId, programId.trim(), confirmation, acknowledged)}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm text-white disabled:opacity-40" onClick={() => void close()}>
            {busy ? label("processing") : label("submit")}
          </button>
        </div>}
        {error && <p role="alert" className="break-all whitespace-pre-wrap text-sm text-red-200">{error}</p>}
        {receipt && <div role="status" className="space-y-2 break-all text-sm text-gray-200">
          <p>{receipt.readback_verified ? label("success") : label("readbackMismatch")}</p>
          <p>{label("signature")}: {receipt.signature}</p>
          <p>{label(receipt.actual_refunded_lamports !== null ? "actualRefund" : "refund")}: {lamportsAsSol(receipt.actual_refunded_lamports ?? receipt.expected_refund_lamports)} SOL</p>
          <button type="button" onClick={downloadReceipt} className="rounded-lg bg-white/10 px-3 py-2">{label("download")}</button>
        </div>}
      </div>
    </details>
  );
}
