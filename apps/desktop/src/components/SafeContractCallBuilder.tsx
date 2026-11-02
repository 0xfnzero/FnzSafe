"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { abiTypeLabel, functionSignature, type AbiParam } from "@/lib/evmAbi";
import { loadEvmAbiProjects, type EvmAbiProject } from "@/lib/evmAbiProjects";
import {
  abiErrorKey, arrayItem, emptySafeAbiDraft, initialSafeAbiValue, MAX_ABI_BYTES, MAX_ARRAY_ITEMS,
  resolveSafeAbiDraft, safeAbiArgumentError, safeAbiFunctions, supportsSafeAbiForm,
  type SafeAbiDraft, type SafeAbiValue, type SafeCallMetadata,
} from "@/lib/safeAbi";

const inputClass = "mt-1 w-full rounded-lg border border-white/15 bg-black/20 p-2.5 text-sm";
const buttonClass = "rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
type Translate = (key: string) => string;

export function SafeContractCallBuilder({ draft, onChange, chainId, t }: {
  draft: SafeAbiDraft; onChange: (draft: SafeAbiDraft, target?: string) => void; chainId: number; t: Translate;
}) {
  const [projects, setProjects] = useState<EvmAbiProject[]>([]);
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(false);
  const loadVersion = useRef(0);
  useEffect(() => {
    setProjects(loadEvmAbiProjects().filter(p => p.chainId === chainId));
    const versionRef = loadVersion;
    return () => { versionRef.current++; };
  }, [chainId]);
  const parsed = useMemo(() => {
    if (!draft.text) return { functions: [] };
    try { return { functions: safeAbiFunctions(draft.text) }; }
    catch (e) { return { functions: [], error: abiErrorKey(e) }; }
  }, [draft.text]);
  const selected = parsed.functions.find(fn => functionSignature(fn) === draft.signature);
  const resolved = resolveSafeAbiDraft(draft);
  function load(text: string, fileName: string, target?: string) {
    // Replacing an ABI always invalidates the old function and its arguments, even on failure.
    onChange({ ...emptySafeAbiDraft(), text, fileName }, target);
  }
  return <section className="space-y-4 rounded-xl border border-white/15 p-4 sm:p-5" aria-label={t("abiTitle")}>
    <div><h3 className="font-semibold">{t("abiTitle")}</h3><p className="mt-1 text-sm text-muted-foreground">{t("abiIntro")}</p></div>
    {projects.length > 0 && <label className="block text-sm">{t("abiSavedProject")}
      <select className={inputClass} value="" onChange={e => {
        loadVersion.current++; setLoading(false); setFileError("");
        const project = projects.find(p => p.id === e.target.value);
        if (project) load(project.abiJsonText, project.abiFileName, project.contractAddress);
      }}><option value="">{t("abiSelectProject")}</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name} · {p.contractAddress}</option>)}</select>
    </label>}
    <label className="block rounded-lg border border-dashed border-white/25 p-4 text-sm">
      <span className="block font-medium">{t("abiUpload")}</span>
      <span className="mb-3 mt-1 block text-xs text-muted-foreground">{t("abiFileHint")}</span>
      <input type="file" accept=".json,.abi,application/json" aria-label={t("abiUpload")} className="block w-full text-[0px] file:text-sm file:mr-3 file:rounded-md file:border-0 file:bg-emerald-500/15 file:px-3 file:py-2 file:text-emerald-400" onChange={e => {
        const file = e.target.files?.[0]; e.target.value = "";
        if (!file) return;
        const version = ++loadVersion.current;
        setFileError(""); onChange(emptySafeAbiDraft());
        if (file.size > MAX_ABI_BYTES) { setLoading(false); setFileError("abiTooLarge"); return; }
        setLoading(true);
        void file.text().then(text => { if (version === loadVersion.current) load(text, file.name); })
          .catch(() => { if (version === loadVersion.current) setFileError("abiReadFailed"); })
          .finally(() => { if (version === loadVersion.current) setLoading(false); });
      }} />
      {draft.fileName && <span className="mt-2 block break-all text-emerald-400">{draft.fileName}</span>}
    </label>
    <details><summary className="cursor-pointer text-sm text-muted-foreground">{t("abiPaste")}</summary>
      <textarea aria-label={t("abiJson")} className={`${inputClass} font-mono text-xs`} rows={6} value={draft.text} maxLength={MAX_ABI_BYTES} spellCheck={false} onChange={e => {
        loadVersion.current++; setLoading(false); setFileError(""); load(e.target.value, "");
      }} />
    </details>
    {loading && <p role="status" className="text-sm">{t("working")}</p>}
    {(fileError || parsed.error) && <p role="alert" className="text-sm text-red-400">{t(fileError || parsed.error!)}</p>}
    {parsed.functions.length > 0 && <>
      <label className="block text-sm">{t("abiMethod")}
        <select className={`${inputClass} font-mono`} value={draft.signature} onChange={e => {
          const fn = parsed.functions.find(fn => functionSignature(fn) === e.target.value);
          onChange({ ...draft, signature: e.target.value, args: fn?.inputs.map(initialSafeAbiValue) || [] });
        }}><option value="">{t("abiChooseMethod")}</option>{parsed.functions.map(fn => <option key={functionSignature(fn)} value={functionSignature(fn)} disabled={fn.inputs.length > 64 || fn.inputs.some(p => !supportsSafeAbiForm(p))}>{functionSignature(fn)} · {fn.stateMutability}{fn.inputs.some(p => !supportsSafeAbiForm(p)) ? ` · ${t("abiUnsupported")}` : ""}</option>)}</select>
      </label>
      {selected && <div key={draft.signature} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-medium">{t("abiArguments")}</h4><span className="rounded-md bg-white/5 px-2 py-1 text-xs">{selected.stateMutability}</span></div>
        {selected.inputs.length === 0 && <p className="text-sm text-muted-foreground">{t("abiNoArguments")}</p>}
        {selected.inputs.map((param, index) => <AbiField key={index} param={param} value={draft.args[index]} name={param.name || `arg${index}`} t={t} onChange={value => onChange({ ...draft, args: draft.args.map((v, i) => i === index ? value : v) })} />)}
        <p className="text-xs text-muted-foreground">{selected.stateMutability === "payable" ? t("abiPayableHint") : t("abiNonpayableHint")}</p>
      </div>}
      {resolved.data && <details className="rounded-lg bg-emerald-500/5 p-3"><summary className="cursor-pointer text-sm text-emerald-400">{t("abiEncoded")}</summary>
        <textarea aria-label={t("abiEncoded")} className={`${inputClass} font-mono text-xs`} readOnly rows={4} value={resolved.data} />
      </details>}
    </>}
  </section>;
}

function AbiField({ param, value, name, onChange, t }: { param: AbiParam; value: SafeAbiValue; name: string; onChange: (value: SafeAbiValue) => void; t: Translate }) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const item = arrayItem(param);
  const error = safeAbiArgumentError(param, value);
  if (item || param.type === "tuple") {
    const values = Array.isArray(value) ? value : [];
    return <fieldset className="min-w-0 space-y-3 rounded-lg border border-white/10 p-3">
      <legend className="max-w-full break-words px-1 text-sm">{name} <span className="text-xs text-muted-foreground">{abiTypeLabel(param)}</span></legend>
      {values.map((v, index) => <div key={index} className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><AbiField param={item?.param || param.components![index]} value={v} name={item ? `${name}[${index}]` : `${name}.${param.components![index].name || index}`} t={t} onChange={next => onChange(values.map((old, i) => i === index ? next : old))} /></div>
        {item && item.length === undefined && <button type="button" className={buttonClass} aria-label={`${t("abiRemoveItem")} ${name}[${index}]`} onClick={() => onChange(values.filter((_, i) => i !== index))}>×</button>}
      </div>)}
      {item && item.length === undefined && <div className="flex items-center gap-3"><button type="button" className={buttonClass} disabled={values.length >= MAX_ARRAY_ITEMS} onClick={() => onChange([...values, initialSafeAbiValue(item.param)])}>{t("abiAddItem")}</button><span className="text-xs text-muted-foreground">{values.length} / {MAX_ARRAY_ITEMS}</span></div>}
    </fieldset>;
  }
  const text = typeof value === "string" ? value : "";
  const props = { id, className: inputClass, value: text, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange(e.target.value), onBlur: () => setTouched(true), "aria-invalid": touched && !!error, "aria-describedby": `${id}-hint` };
  return <div>
    <label htmlFor={id} className="block text-sm">{name} <span className="ml-1 text-xs text-muted-foreground">{abiTypeLabel(param)}</span></label>
    {param.type === "bool" ? <select {...props}><option value="">{t("abiChooseBool")}</option><option value="true">true</option><option value="false">false</option></select> :
      param.type === "string" || param.type === "bytes" ? <textarea {...props} rows={2} spellCheck={false} /> : <input {...props} type="text" spellCheck={false} autoComplete="off" placeholder={param.type === "address" || param.type.startsWith("bytes") ? "0x…" : ""} />}
    <p id={`${id}-hint`} className={`mt-1 text-xs ${touched && error ? "text-red-400" : "text-muted-foreground"}`}>{touched && error ? t(error) : /^u?int/.test(param.type) ? t("abiIntegerHint") : param.type.startsWith("bytes") ? t("abiBytesHint") : ""}</p>
  </div>;
}

export function SafeCallSummary({ call, t }: { call: SafeCallMetadata; t: Translate }) {
  return <section className="space-y-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4">
    <h3 className="text-sm font-medium">{t("abiCallSummary")}</h3>
    <p className="break-all font-mono text-sm">{functionSignature(call.fn)}</p>
    <dl className="space-y-2">{call.fn.inputs.map((param, index) => <div key={index}><dt className="text-xs text-muted-foreground">{param.name || `arg${index}`} · {abiTypeLabel(param)}</dt><dd className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-sm">{typeof call.args[index] === "string" ? JSON.stringify(call.args[index]) : JSON.stringify(call.args[index], null, 2)}</dd></div>)}</dl>
    <p className="text-xs text-muted-foreground">{t("abiSummaryHint")}</p>
  </section>;
}
