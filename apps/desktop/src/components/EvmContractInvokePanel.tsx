"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  FileJson2,
  FolderPlus,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/apiFetch";
import {
  abiTypeLabel,
  decodeFunctionResult,
  defaultTokenDecimalsForArg,
  encodeFunctionCalldata,
  formatUintToDecimalAmount,
  isLikelyEvmAddress,
  isPayableAbiFunction,
  isReadableAbiFunction,
  isUnsignedIntegerAbiType,
  isUnsupportedAbiType,
  parseAbiJson,
  parseDecimalAmountToUint,
  type AbiFunctionItem,
} from "@/lib/evmAbi";
import {
  deleteEvmAbiProject,
  loadEvmAbiProjects,
  saveEvmAbiProjects,
  shortContractAddress,
  upsertEvmAbiProject,
  type EvmAbiProject,
} from "@/lib/evmAbiProjects";

export interface EvmContractChainConfig {
  chain_id: number;
  name: string;
  native_symbol: string;
  rpc_url: string;
  explorer_url?: string | null;
  testnet: boolean;
}

export interface EvmContractSavedWallet {
  id: string;
  name: string;
  evm_address?: string | null;
}

interface EvmContractInvokePanelProps {
  chain: EvmContractChainConfig | null;
  walletAddress: string | null;
  walletId: string | null;
  wallets: EvmContractSavedWallet[];
  t: (key: string, values?: Record<string, string | number>) => string;
  tf: (key: string, fallback: string, values?: Record<string, string | number>) => string;
}

type WalletPickerTarget =
  | { kind: "contract" }
  | { kind: "arg"; name: string };

/** Common Robinhood Chain (4663) tokens for ABI arg shortcuts. */
const ROBINHOOD_QUICK_TOKENS = [
  { symbol: "WETH", address: "0x0Bd7D308f8E1639FAb988df18A8011F41EAcAD73" },
  { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" },
] as const;

/** Hint-only: ABI cannot prove address semantics; we only surface token shortcuts when names look token-like. */
function looksLikeTokenAddressArgName(name: string): boolean {
  return /(token|asset|currency|coin|erc20)/i.test(name.trim());
}

type PanelView = "list" | "editor" | "invoke";
type AbiFunctionFilter = "write" | "read" | "all";
type UintInputMode = "raw" | "decimal";

interface InvokeResult {
  status: string;
  resultHex?: string;
  decodedOutputs?: string[];
  transactionHash?: string;
  gasLimit?: string;
  error?: string;
  logs: string[];
}

function shortEvmLabel(wallet: EvmContractSavedWallet): string {
  const address = String(wallet.evm_address || "").trim();
  if (!address) return wallet.name;
  return `${wallet.name} - ${address.slice(0, 4)}...${address.slice(-4)}`;
}

function isAddressAbiInput(type: string): boolean {
  return type === "address";
}

function sortAbiFunctions(items: AbiFunctionItem[]): AbiFunctionItem[] {
  return [...items].sort((a, b) => {
    const aWrite = isReadableAbiFunction(a) ? 1 : 0;
    const bWrite = isReadableAbiFunction(b) ? 1 : 0;
    if (aWrite !== bWrite) return aWrite - bWrite;
    return a.name.localeCompare(b.name);
  });
}

function isLikelyAutoGetter(fn: AbiFunctionItem): boolean {
  if (!isReadableAbiFunction(fn)) return false;
  if (fn.inputs.length !== 0) return false;
  return /^[A-Z][A-Z0-9_]*$/.test(fn.name);
}

function filterAbiFunctions(
  items: AbiFunctionItem[],
  filter: AbiFunctionFilter,
  query: string,
): AbiFunctionItem[] {
  const needle = query.trim().toLowerCase();
  return items.filter((fn) => {
    if (filter === "write" && isReadableAbiFunction(fn)) return false;
    if (filter === "read" && !isReadableAbiFunction(fn)) return false;
    if (!needle) return true;
    return fn.name.toLowerCase().includes(needle);
  });
}

function pickDefaultFunction(items: AbiFunctionItem[]): AbiFunctionItem | undefined {
  return (
    items.find((fn) => !isReadableAbiFunction(fn) && /withdraw/i.test(fn.name)) ||
    items.find((fn) => !isReadableAbiFunction(fn)) ||
    items[0]
  );
}

function formatUpdatedAt(value: number): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

export function EvmContractInvokePanel({
  chain,
  walletAddress,
  walletId,
  wallets,
  t,
  tf,
}: EvmContractInvokePanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [view, setView] = useState<PanelView>("list");
  const [projects, setProjects] = useState<EvmAbiProject[]>([]);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const [projectName, setProjectName] = useState("");
  const [abiFileName, setAbiFileName] = useState("");
  const [abiJsonText, setAbiJsonText] = useState("");
  const [functions, setFunctions] = useState<AbiFunctionItem[]>([]);
  const [functionFilter, setFunctionFilter] = useState<AbiFunctionFilter>("all");
  const [functionQuery, setFunctionQuery] = useState("");
  const [selectedFunction, setSelectedFunction] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [valueWei, setValueWei] = useState("0");
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [uintInputModes, setUintInputModes] = useState<Record<string, UintInputMode>>({});
  const [uintDecimalAmounts, setUintDecimalAmounts] = useState<Record<string, string>>({});
  const [uintDecimals, setUintDecimals] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<InvokeResult>();
  const [walletPickerTarget, setWalletPickerTarget] = useState<WalletPickerTarget | null>(null);

  useEffect(() => {
    setProjects(loadEvmAbiProjects());
  }, []);

  const persistProjects = (next: EvmAbiProject[]) => {
    setProjects(next);
    saveEvmAbiProjects(next);
  };

  const writeCount = useMemo(
    () => functions.filter((fn) => !isReadableAbiFunction(fn)).length,
    [functions],
  );
  const readCount = useMemo(
    () => functions.filter((fn) => isReadableAbiFunction(fn)).length,
    [functions],
  );
  const visibleFunctions = useMemo(
    () => filterAbiFunctions(functions, functionFilter, functionQuery),
    [functions, functionFilter, functionQuery],
  );
  const selected = useMemo(
    () => functions.find((item) => item.name === selectedFunction),
    [functions, selectedFunction],
  );
  const readable = selected ? isReadableAbiFunction(selected) : false;
  const payable = selected ? isPayableAbiFunction(selected) : false;
  const evmWallets = useMemo(
    () => wallets.filter((wallet) => isLikelyEvmAddress(String(wallet.evm_address || ""))),
    [wallets],
  );
  const activeProject = useMemo(
    () => projects.find((item) => item.id === activeProjectId) || null,
    [projects, activeProjectId],
  );

  const applySelectedFunction = (fn: AbiFunctionItem | undefined) => {
    setSelectedFunction(fn?.name || "");
    setArgValues(Object.fromEntries((fn?.inputs || []).map((input) => [input.name, ""])));
    const nextModes: Record<string, UintInputMode> = {};
    const nextDecimals: Record<string, string> = {};
    const nextAmounts: Record<string, string> = {};
    for (const input of fn?.inputs || []) {
      if (!isUnsignedIntegerAbiType(input.type)) continue;
      nextModes[input.name] = "decimal";
      nextDecimals[input.name] = String(defaultTokenDecimalsForArg(input.name));
      nextAmounts[input.name] = "";
    }
    setUintInputModes(nextModes);
    setUintDecimals(nextDecimals);
    setUintDecimalAmounts(nextAmounts);
  };

  const syncDecimalAmountToRaw = (name: string, amount: string, decimalsText: string) => {
    const decimals = Number(decimalsText);
    if (!Number.isInteger(decimals)) {
      setArgValues((current) => ({ ...current, [name]: "" }));
      return;
    }
    try {
      const raw = parseDecimalAmountToUint(amount, decimals);
      setArgValues((current) => ({ ...current, [name]: raw }));
    } catch {
      setArgValues((current) => ({ ...current, [name]: "" }));
    }
  };

  const setUintMode = (name: string, mode: UintInputMode) => {
    const currentRaw = argValues[name] || "";
    const decimalsText = uintDecimals[name] || String(defaultTokenDecimalsForArg(name));
    const decimals = Number(decimalsText);
    if (mode === "decimal") {
      let amount = "";
      if (currentRaw.trim() && Number.isInteger(decimals)) {
        try {
          amount = formatUintToDecimalAmount(currentRaw, decimals);
        } catch {
          amount = "";
        }
      }
      setUintDecimalAmounts((current) => ({ ...current, [name]: amount }));
      setUintDecimals((current) => ({ ...current, [name]: decimalsText }));
    }
    setUintInputModes((current) => ({ ...current, [name]: mode }));
    setResult(undefined);
  };

  const resetInvokeState = () => {
    setFunctionFilter("all");
    setFunctionQuery("");
    setValueWei("0");
    setResult(undefined);
    setError(undefined);
  };

  const loadAbiText = (text: string, fileName: string, options?: { keepAddress?: boolean }) => {
    try {
      const parsed = sortAbiFunctions(parseAbiJson(text));
      const first = pickDefaultFunction(parsed);
      setAbiJsonText(text);
      setAbiFileName(fileName);
      setFunctions(parsed);
      setFunctionFilter("all");
      setFunctionQuery("");
      applySelectedFunction(first);
      if (!options?.keepAddress) {
        // keep current address when editing a project / reloading same ABI
      }
      setError(undefined);
      setResult(undefined);
      return parsed;
    } catch (loadError) {
      setFunctions([]);
      setSelectedFunction("");
      setArgValues({});
      setFunctionQuery("");
      const code = loadError instanceof Error ? loadError.message : "";
      setError(
        code === "invalid-abi-empty"
          ? tf("features.evm-contract-invoke.noFunctions", "ABI 中没有可调用的函数")
          : code === "invalid-abi"
            ? tf(
                "features.evm-contract-invoke.abiShapeInvalid",
                "无法识别 ABI 格式（支持纯 ABI 数组或 Foundry/Hardhat 的 { abi: [...] } 产物）",
              )
            : tf("features.evm-contract-invoke.abiLoadFailed", "无法解析 ABI JSON"),
      );
      return null;
    }
  };

  const handleAbiFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = loadAbiText(text, file.name, { keepAddress: true });
    if (parsed && !projectName.trim()) {
      const stem = file.name.replace(/\.json$/i, "");
      setProjectName(stem || file.name);
    }
  };

  const openCreate = () => {
    setEditingProjectId(null);
    setActiveProjectId(null);
    setProjectName("");
    setAbiFileName("");
    setAbiJsonText("");
    setFunctions([]);
    setSelectedFunction("");
    setArgValues({});
    setContractAddress("");
    resetInvokeState();
    setView("editor");
  };

  const openEdit = (project: EvmAbiProject) => {
    setEditingProjectId(project.id);
    setActiveProjectId(null);
    setProjectName(project.name);
    setContractAddress(project.contractAddress);
    resetInvokeState();
    loadAbiText(project.abiJsonText, project.abiFileName, { keepAddress: true });
    setView("editor");
  };

  const openInvoke = (project: EvmAbiProject) => {
    setEditingProjectId(null);
    setActiveProjectId(project.id);
    setProjectName(project.name);
    setContractAddress(project.contractAddress);
    resetInvokeState();
    const parsed = loadAbiText(project.abiJsonText, project.abiFileName, { keepAddress: true });
    if (!parsed) {
      toast.error(tf("features.evm-contract-invoke.abiLoadFailed", "无法解析 ABI JSON"));
      return;
    }
    setView("invoke");
  };

  const goList = () => {
    setView("list");
    setEditingProjectId(null);
    setActiveProjectId(null);
    setError(undefined);
    setResult(undefined);
  };

  const saveProject = () => {
    const name = projectName.trim();
    if (!name) {
      toast.error(tf("features.evm-contract-invoke.projectNameRequired", "请填写项目名称"));
      return;
    }
    if (!chain) {
      toast.error(tf("features.evm-contract-invoke.selectChain", "请先选择 EVM 网络"));
      return;
    }
    if (!isLikelyEvmAddress(contractAddress)) {
      toast.error(t("features.evm-contract-invoke.invalidContract"));
      return;
    }
    if (!abiJsonText || functions.length === 0) {
      toast.error(tf("features.evm-contract-invoke.abiRequired", "请先选择并成功解析 ABI JSON"));
      return;
    }
    const { projects: next, project } = upsertEvmAbiProject(
      projects,
      {
        name,
        chainId: chain.chain_id,
        chainName: chain.name,
        contractAddress: contractAddress.trim(),
        abiJsonText,
        abiFileName: abiFileName || "abi.json",
        functionCount: functions.length,
      },
      editingProjectId || undefined,
    );
    persistProjects(next);
    toast.success(
      editingProjectId
        ? tf("features.evm-contract-invoke.projectUpdated", "项目已更新")
        : tf("features.evm-contract-invoke.projectCreated", "项目已创建"),
    );
    openInvoke(project);
  };

  const removeProject = (project: EvmAbiProject) => {
    const ok = window.confirm(
      tf(
        "features.evm-contract-invoke.confirmDeleteProject",
        "确定删除项目「{name}」吗？",
        { name: project.name },
      ),
    );
    if (!ok) return;
    const next = deleteEvmAbiProject(projects, project.id);
    persistProjects(next);
    if (activeProjectId === project.id || editingProjectId === project.id) {
      goList();
    }
    toast.success(tf("features.evm-contract-invoke.projectDeleted", "项目已删除"));
  };

  const selectFunction = (fn: AbiFunctionItem) => {
    applySelectedFunction(fn);
    setResult(undefined);
  };

  const applyWalletAddress = (address: string) => {
    const target = walletPickerTarget;
    if (!target) return;
    const normalized = address.trim();
    if (target.kind === "contract") {
      setContractAddress(normalized);
    } else {
      setArgValues((current) => ({ ...current, [target.name]: normalized }));
    }
    setResult(undefined);
    setWalletPickerTarget(null);
  };

  const fillCurrentWallet = (target: WalletPickerTarget) => {
    const address = String(walletAddress || "").trim();
    if (!isLikelyEvmAddress(address)) {
      toast.error(tf("features.evm-contract-invoke.selectWallet", "请先选择带 EVM 地址的钱包"));
      return;
    }
    if (target.kind === "contract") {
      setContractAddress(address);
    } else {
      setArgValues((current) => ({ ...current, [target.name]: address }));
    }
    setResult(undefined);
  };

  const runInvoke = async (mode: "call" | "send") => {
    if (!chain) {
      toast.error(tf("features.evm-contract-invoke.selectChain", "请先选择 EVM 网络"));
      return;
    }
    if (!walletAddress || !walletId) {
      toast.error(tf("features.evm-contract-invoke.selectWallet", "请先选择带 EVM 地址的钱包"));
      return;
    }
    if (!selected) {
      toast.error(t("features.evm-contract-invoke.noFunction"));
      return;
    }
    if (!isLikelyEvmAddress(contractAddress)) {
      toast.error(t("features.evm-contract-invoke.invalidContract"));
      return;
    }
    if (selected.inputs.some((input) => isUnsupportedAbiType(input))) {
      toast.error(t("features.evm-contract-invoke.unsupportedType"));
      return;
    }
    if (mode === "send" && readable) {
      toast.error(tf("features.evm-contract-invoke.readOnlySendBlocked", "只读函数请使用 eth_call"));
      return;
    }

    let encoded;
    try {
      encoded = encodeFunctionCalldata(selected, argValues);
    } catch {
      toast.error(t("features.evm-contract-invoke.encodeFailed"));
      return;
    }

    setLoading(true);
    setResult(undefined);
    try {
      const response = await apiFetch("evm/contract/invoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet_id: mode === "send" ? walletId : undefined,
          chain,
          wallet_address: walletAddress,
          contract_address: contractAddress.trim(),
          data: encoded.data,
          value_wei: payable ? valueWei.trim() || "0" : "0",
          mode,
          keystore_json: "",
          password: "",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || t("features.evm-contract-invoke.error"));
      }
      const resultHex = typeof data.result_hex === "string" ? data.result_hex : undefined;
      const decodedOutputs = resultHex && selected.outputs.length > 0
        ? decodeFunctionResult(selected, resultHex)
        : undefined;
      const next: InvokeResult = {
        status: String(data.status || mode),
        resultHex,
        decodedOutputs,
        transactionHash: typeof data.transaction_hash === "string" ? data.transaction_hash : undefined,
        gasLimit: typeof data.gas_limit === "string" ? data.gas_limit : undefined,
        logs: [
          `${selected.name} ${encoded.signature}`,
          `selector ${encoded.selector}`,
          `calldata ${encoded.data}`,
          ...(resultHex ? [`result ${resultHex}`] : []),
          ...(decodedOutputs || []).map((value, index) => {
            const output = selected.outputs[index];
            return `output[${output?.name || index}] ${value}`;
          }),
          ...(typeof data.transaction_hash === "string"
            ? [t("features.evm-contract-invoke.txHashLog", { hash: data.transaction_hash })]
            : []),
        ],
      };
      setResult(next);
      toast.success(
        mode === "send"
          ? t("features.evm-contract-invoke.sendSucceeded")
          : t("features.evm-contract-invoke.callSucceeded"),
      );
    } catch (invokeError) {
      const message = invokeError instanceof Error
        ? invokeError.message
        : t("features.evm-contract-invoke.error");
      setResult({ status: "failed", error: message, logs: [message] });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const renderAddressField = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    target: WalletPickerTarget,
    options?: { showTokenQuickPick?: boolean },
  ) => (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-gray-400">{label}</span>
      <div className="flex flex-wrap gap-2">
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="0x..."
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="h-10 min-w-0 flex-1 basis-[12rem] rounded-lg border border-white/10 bg-black/30 px-3 font-mono text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
        />
        {options?.showTokenQuickPick &&
          ROBINHOOD_QUICK_TOKENS.map((token) => {
            const active = value.trim().toLowerCase() === token.address.toLowerCase();
            return (
              <button
                key={token.symbol}
                type="button"
                onClick={() => {
                  onChange(token.address);
                  setResult(undefined);
                }}
                className={`shrink-0 rounded-lg px-3 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-emerald-400/15 text-emerald-100"
                    : "bg-white/10 text-gray-200 hover:bg-white/20"
                }`}
                title={token.address}
              >
                {token.symbol}
              </button>
            );
          })}
        <button
          type="button"
          onClick={() => fillCurrentWallet(target)}
          disabled={!walletAddress}
          className="shrink-0 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20 disabled:opacity-40"
        >
          {tf("features.evm-contract-invoke.currentWallet", "当前钱包")}
        </button>
        <button
          type="button"
          onClick={() => setWalletPickerTarget(target)}
          className="shrink-0 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
        >
          {tf("features.evm-contract-invoke.chooseWallet", "选择钱包")}
        </button>
      </div>
      {options?.showTokenQuickPick && (
        <p className="text-[11px] text-gray-500">
          {tf(
            "features.evm-contract-invoke.tokenQuickPickHint",
            "可快捷填入 WETH / USDG，也可手动输入或从客户端钱包选择地址。",
          )}
        </p>
      )}
    </div>
  );

  const walletPickerPortal = walletPickerTarget &&
    typeof document !== "undefined" &&
    createPortal(
      <div
        className="fixed inset-0 z-[195] flex items-end bg-black/60"
        onClick={() => setWalletPickerTarget(null)}
      >
        <div
          className="relative max-h-[85vh] w-full overflow-y-auto border-t border-white/10 bg-zinc-950 px-4 py-5 shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mx-auto max-w-xl space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h3 className="text-lg font-semibold">
                  {tf("features.evm-contract-invoke.walletPickerTitle", "选择钱包")}
                </h3>
                <p className="mt-1 text-sm text-gray-400">
                  {tf(
                    "features.evm-contract-invoke.walletPickerHint",
                    "选择客户端里已保存的 EVM 钱包地址，选中后会自动填入当前输入框。",
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setWalletPickerTarget(null)}
                className="rounded-lg bg-white/10 p-2 text-gray-300 hover:bg-white/20"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {evmWallets.length === 0 ? (
              <p className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-gray-400">
                {tf("features.evm-contract-invoke.noSavedWallets", "当前客户端还没有带 EVM 地址的已保存钱包。")}
              </p>
            ) : (
              <div className="space-y-2">
                {evmWallets.map((wallet) => {
                  const address = String(wallet.evm_address || "").trim();
                  const isCurrent = Boolean(
                    walletId === wallet.id
                      || (walletAddress && address.toLowerCase() === walletAddress.toLowerCase()),
                  );
                  return (
                    <button
                      key={wallet.id}
                      type="button"
                      onClick={() => applyWalletAddress(address)}
                      className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-3 text-left hover:bg-white/10"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span
                          className="min-w-0 cursor-text truncate text-sm font-semibold text-gray-100 select-text"
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                        >
                          {shortEvmLabel(wallet)}
                        </span>
                        {isCurrent && (
                          <span className="shrink-0 rounded bg-cyan-400/15 px-2 py-0.5 text-[11px] text-cyan-100">
                            {tf("features.evm-contract-invoke.currentWallet", "当前钱包")}
                          </span>
                        )}
                      </span>
                      <code className="mt-1 block break-all text-xs text-gray-500">
                        {address}
                      </code>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>,
      document.body,
    );

  if (view === "list") {
    return (
      <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <section className="shrink-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-gray-100">
                {tf("features.evm-contract-invoke.projectsTitle", "ABI 调用项目")}
              </p>
              <p className="text-xs text-gray-500">
                {tf(
                  "features.evm-contract-invoke.projectsHint",
                  "先创建项目：选择 ABI、填写合约地址并保存。之后从列表进入即可调用函数。",
                )}
              </p>
              {chain && (
                <p className="text-xs text-gray-400">
                  {chain.name} · chainId {chain.chain_id}
                  {walletAddress ? ` · ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : ""}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-400/90 px-3 text-xs font-semibold text-slate-950 hover:bg-emerald-300"
            >
              <Plus className="h-3.5 w-3.5" />
              {tf("features.evm-contract-invoke.createProject", "创建项目")}
            </button>
          </div>
        </section>

        <section className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03] p-3 scrollbar-thin">
          {projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 px-4 py-16 text-center">
              <FolderPlus className="h-8 w-8 text-gray-500" />
              <p className="text-sm text-gray-300">
                {tf("features.evm-contract-invoke.emptyProjects", "还没有 ABI 项目")}
              </p>
              <p className="max-w-md text-xs text-gray-500">
                {tf(
                  "features.evm-contract-invoke.emptyProjectsHint",
                  "创建一个项目来保存合约地址与 ABI，下次打开直接调用。",
                )}
              </p>
              <button
                type="button"
                onClick={openCreate}
                className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
              >
                <Plus className="h-3.5 w-3.5" />
                {tf("features.evm-contract-invoke.createProject", "创建项目")}
              </button>
            </div>
          ) : (
            projects.map((project) => (
              <div
                key={project.id}
                className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 transition-colors hover:bg-white/[0.05]"
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <button
                    type="button"
                    onClick={() => openInvoke(project)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm font-semibold text-gray-100">{project.name}</div>
                    <div className="mt-1 space-y-0.5 text-[11px] text-gray-500">
                      <p>
                        {project.chainName} · chainId {project.chainId}
                        {" · "}
                        {tf("features.evm-contract-invoke.functionCountLabel", "{count} 个函数", {
                          count: project.functionCount,
                        })}
                      </p>
                      <p className="font-mono text-gray-400">
                        {shortContractAddress(project.contractAddress)}
                      </p>
                      <p>
                        {project.abiFileName}
                        {" · "}
                        {tf("features.evm-contract-invoke.updatedAt", "更新于 {time}", {
                          time: formatUpdatedAt(project.updatedAt),
                        })}
                      </p>
                    </div>
                  </button>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => openInvoke(project)}
                      className="inline-flex min-h-8 items-center justify-center rounded-lg bg-emerald-400/90 px-3 text-xs font-semibold text-slate-950 hover:bg-emerald-300"
                    >
                      {tf("features.evm-contract-invoke.openProject", "打开")}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(project)}
                      className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
                    >
                      <Pencil className="h-3 w-3" />
                      {tf("features.evm-contract-invoke.editProject", "编辑")}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeProject(project)}
                      className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-lg bg-rose-400/10 px-3 text-xs font-semibold text-rose-100 hover:bg-rose-400/20"
                    >
                      <Trash2 className="h-3 w-3" />
                      {tf("features.evm-contract-invoke.deleteProject", "删除")}
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </section>
      </div>
    );
  }

  if (view === "editor") {
    return (
      <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <section className="shrink-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <div className="min-w-0 space-y-1">
            <button
              type="button"
              onClick={goList}
              className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-200"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {tf("features.evm-contract-invoke.backToProjects", "返回项目列表")}
            </button>
            <p className="text-sm font-semibold text-gray-100">
              {editingProjectId
                ? tf("features.evm-contract-invoke.editProjectTitle", "编辑 ABI 项目")
                : tf("features.evm-contract-invoke.createProjectTitle", "创建 ABI 项目")}
            </p>
            <p className="text-xs text-gray-500">
              {tf(
                "features.evm-contract-invoke.editorHint",
                "填写项目名、合约地址，并选择 ABI JSON。保存后可随时从列表打开调用。",
              )}
            </p>
            {chain && (
              <p className="text-xs text-gray-400">
                {chain.name} · chainId {chain.chain_id}
              </p>
            )}
          </div>
          {error && (
            <p className="rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              {error}
            </p>
          )}
        </section>

        <section className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border border-white/10 bg-white/[0.03] p-3 scrollbar-thin">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => void handleAbiFile(event)}
          />

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-gray-400">
              {tf("features.evm-contract-invoke.projectName", "项目名称")}
            </span>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder={tf("features.evm-contract-invoke.projectNamePlaceholder", "例如 ArbExecutor")}
              spellCheck={false}
              className="h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
            />
          </label>

          {renderAddressField(
            t("features.evm-contract-invoke.contractAddress"),
            contractAddress,
            setContractAddress,
            { kind: "contract" },
          )}

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-gray-400">
              {tf("features.evm-contract-invoke.abiFileField", "ABI JSON")}
            </span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
              >
                <Upload className="h-3.5 w-3.5" />
                {abiFileName
                  ? tf("features.evm-contract-invoke.changeAbiFile", "更换 ABI")
                  : tf("features.evm-contract-invoke.chooseAbiFile", "选择 ABI JSON")}
              </button>
              {abiFileName && (
                <div className="flex min-w-0 flex-1 items-center rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-xs text-gray-300">
                  <FileJson2 className="mr-2 h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{abiFileName}</span>
                  {functions.length > 0 && (
                    <span className="ml-2 shrink-0 text-emerald-200/90">
                      {tf("features.evm-contract-invoke.functionCountLabel", "{count} 个函数", {
                        count: functions.length,
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>
            <p className="text-[11px] text-gray-500">
              {abiFileName
                ? tf("features.evm-contract-invoke.abiFileReady", "已读取 ABI：{file}", { file: abiFileName })
                : tf(
                    "features.evm-contract-invoke.abiFileFieldHint",
                    "支持纯 ABI 数组或 Foundry/Hardhat 的 { abi: [...] } 编译产物。",
                  )}
              {functions.length > 0 && (
                <span className="ml-1 text-emerald-200/80">
                  {tf("features.evm-contract-invoke.functionCounts", "写 {write} · 读 {read}", {
                    write: writeCount,
                    read: readCount,
                  })}
                </span>
              )}
            </p>
          </div>

          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              onClick={saveProject}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-400/90 px-4 text-sm font-semibold text-slate-950 hover:bg-emerald-300"
            >
              {tf("features.evm-contract-invoke.saveProject", "保存项目")}
            </button>
          </div>
        </section>
        {walletPickerPortal}
      </div>
    );
  }

  // invoke view
  return (
    <div className="space-y-4 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col xl:space-y-0 xl:gap-4">
      <section className="shrink-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0 space-y-1">
            <button
              type="button"
              onClick={goList}
              className="mb-1 inline-flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-200"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {tf("features.evm-contract-invoke.backToProjects", "返回项目列表")}
            </button>
            <p className="text-sm font-semibold text-gray-100">
              {activeProject?.name || projectName || tf("features.evm-contract-invoke.standaloneTitle", "ABI 合约调用")}
            </p>
            <p className="text-xs text-gray-500">
              {abiFileName
                ? tf("features.evm-contract-invoke.abiFileReady", "已读取 ABI：{file}", { file: abiFileName })
                : tf("features.evm-contract-invoke.abiFileHint", "选择 Solidity ABI JSON，填写合约地址与参数后执行 eth_call 或发送交易。")}
            </p>
            <p className="font-mono text-xs text-gray-400">
              {shortContractAddress(contractAddress)}
              {chain ? ` · ${chain.name} · chainId ${chain.chain_id}` : ""}
              {walletAddress ? ` · ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {activeProject && (
              <button
                type="button"
                onClick={() => openEdit(activeProject)}
                className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20"
              >
                <Pencil className="h-3.5 w-3.5" />
                {tf("features.evm-contract-invoke.editProject", "编辑")}
              </button>
            )}
            <button
              type="button"
              onClick={() => loadAbiText(abiJsonText, abiFileName || "abi.json", { keepAddress: true })}
              disabled={loading || !abiJsonText}
              className="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white/10 px-3 text-xs font-semibold text-gray-200 hover:bg-white/20 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              {tf("features.evm-contract-invoke.reloadAbi", "重新解析")}
            </button>
          </div>
        </div>
        {error && (
          <p className="rounded-lg border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
            {error}
          </p>
        )}
      </section>

      <div className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col space-y-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
          <div className="flex shrink-0 items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-200">
              {t("features.evm-contract-invoke.functions")}
            </h3>
            {functions.length > 0 && (
              <span className="text-[11px] text-gray-500">
                {tf(
                  "features.evm-contract-invoke.functionCounts",
                  "写 {write} · 读 {read}",
                  { write: writeCount, read: readCount },
                )}
              </span>
            )}
          </div>
          {functions.length ? (
            <>
              <div className="flex shrink-0 flex-wrap gap-1">
                {(
                  [
                    ["write", tf("features.evm-contract-invoke.filterWrite", "可写"), writeCount],
                    ["read", tf("features.evm-contract-invoke.filterRead", "只读"), readCount],
                    ["all", tf("features.evm-contract-invoke.filterAll", "全部"), functions.length],
                  ] as const
                ).map(([id, label, count]) => {
                  const active = functionFilter === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setFunctionFilter(id)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                        active
                          ? "bg-emerald-400/15 text-emerald-100"
                          : "bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] hover:text-gray-200"
                      }`}
                    >
                      {label} ({count})
                    </button>
                  );
                })}
              </div>
              <input
                value={functionQuery}
                onChange={(event) => setFunctionQuery(event.target.value)}
                placeholder={tf("features.evm-contract-invoke.searchFunctions", "搜索函数，例如 withdraw")}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                className="h-9 w-full shrink-0 rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
              />
              <div className="min-h-0 max-h-[min(28rem,55vh)] flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1 scrollbar-thin">
                {visibleFunctions.length ? (
                  visibleFunctions.map((fn) => {
                    const active = fn.name === selectedFunction;
                    const autoGetter = isLikelyAutoGetter(fn);
                    return (
                      <button
                        key={`${fn.name}-${fn.inputs.map((input) => input.type).join(",")}`}
                        type="button"
                        onClick={() => selectFunction(fn)}
                        className={`block w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                          active
                            ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-50"
                            : "border-transparent bg-white/[0.03] text-gray-300 hover:bg-white/[0.06]"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <FileJson2 className="h-3.5 w-3.5 shrink-0 opacity-70" />
                          <span className="truncate text-sm font-medium">{fn.name}</span>
                        </div>
                        <p className="mt-1 text-[11px] text-gray-500">
                          {isReadableAbiFunction(fn) ? "view/pure" : fn.stateMutability}
                          {autoGetter
                            ? ` · ${tf("features.evm-contract-invoke.autoGetter", "immutable 自动 getter")}`
                            : ""}
                          {" · "}
                          {t("features.evm-contract-invoke.functionMeta", {
                            args: fn.inputs.length,
                            outputs: fn.outputs.length,
                          })}
                        </p>
                      </button>
                    );
                  })
                ) : (
                  <p className="px-1 py-3 text-xs text-gray-500">
                    {tf(
                      "features.evm-contract-invoke.noMatchingFunctions",
                      "当前筛选下没有匹配的函数。可切换到「全部」或清空搜索。",
                    )}
                  </p>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-gray-500">{t("features.evm-contract-invoke.noAbi")}</p>
          )}
        </section>

        <section className="min-w-0 space-y-3 rounded-lg border border-white/10 bg-white/[0.03] p-3 xl:overflow-y-auto">
          <div className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
            <p className="text-xs font-medium text-gray-400">
              {t("features.evm-contract-invoke.contractAddress")}
            </p>
            <code className="mt-1 block break-all text-xs text-gray-200">{contractAddress}</code>
          </div>

          {payable && (
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-gray-400">
                {t("features.evm-contract-invoke.valueWei")}
              </span>
              <input
                value={valueWei}
                onChange={(event) => setValueWei(event.target.value)}
                placeholder="0"
                spellCheck={false}
                className="h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
              />
            </label>
          )}

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-gray-200">
              {t("features.evm-contract-invoke.parameters")}
            </h4>
            {selected?.inputs.length ? (
              selected.inputs.map((input) => {
                const unsupported = isUnsupportedAbiType(input);
                const supportsWalletPicker = !unsupported && isAddressAbiInput(input.type);
                const supportsDecimalUint = !unsupported && isUnsignedIntegerAbiType(input.type);
                if (supportsWalletPicker) {
                  return (
                    <div key={input.name}>
                      {renderAddressField(
                        `${input.name || "arg"} · ${abiTypeLabel(input)}`,
                        argValues[input.name] || "",
                        (next) => {
                          setArgValues((current) => ({ ...current, [input.name]: next }));
                          setResult(undefined);
                        },
                        { kind: "arg", name: input.name },
                        { showTokenQuickPick: looksLikeTokenAddressArgName(input.name) },
                      )}
                    </div>
                  );
                }
                if (supportsDecimalUint) {
                  const mode = uintInputModes[input.name] || "decimal";
                  const decimalsText = uintDecimals[input.name]
                    || String(defaultTokenDecimalsForArg(input.name));
                  const decimalAmount = uintDecimalAmounts[input.name] || "";
                  const rawValue = argValues[input.name] || "";
                  return (
                    <div key={input.name} className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-400">
                          {input.name || "arg"} · {abiTypeLabel(input)}
                        </span>
                        <div className="flex gap-1">
                          {(
                            [
                              ["decimal", tf("features.evm-contract-invoke.amountModeDecimal", "小数")],
                              ["raw", tf("features.evm-contract-invoke.amountModeRaw", "整数")],
                            ] as const
                          ).map(([id, label]) => {
                            const active = mode === id;
                            return (
                              <button
                                key={id}
                                type="button"
                                onClick={() => setUintMode(input.name, id)}
                                className={`rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors ${
                                  active
                                    ? "bg-emerald-400/15 text-emerald-100"
                                    : "bg-white/[0.04] text-gray-400 hover:bg-white/[0.08] hover:text-gray-200"
                                }`}
                              >
                                {label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      {mode === "decimal" ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            <input
                              value={decimalAmount}
                              onChange={(event) => {
                                const nextAmount = event.target.value;
                                setUintDecimalAmounts((current) => ({
                                  ...current,
                                  [input.name]: nextAmount,
                                }));
                                syncDecimalAmountToRaw(input.name, nextAmount, decimalsText);
                                setResult(undefined);
                              }}
                              placeholder={tf(
                                "features.evm-contract-invoke.decimalAmountPlaceholder",
                                "例如 1.5",
                              )}
                              spellCheck={false}
                              className="h-10 min-w-0 flex-1 basis-[10rem] rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
                            />
                            <input
                              value={decimalsText}
                              onChange={(event) => {
                                const nextDecimals = event.target.value.replace(/[^\d]/g, "");
                                setUintDecimals((current) => ({
                                  ...current,
                                  [input.name]: nextDecimals,
                                }));
                                syncDecimalAmountToRaw(input.name, decimalAmount, nextDecimals);
                                setResult(undefined);
                              }}
                              placeholder="decimals"
                              spellCheck={false}
                              className="h-10 w-24 rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
                            />
                          </div>
                          <p className="text-[11px] text-gray-500">
                            {tf(
                              "features.evm-contract-invoke.decimalAmountHint",
                              "左边填人类可读金额，右边填 decimals（USDG=6，ETH=18）。",
                            )}
                            {rawValue ? (
                              <span className="ml-1 font-mono text-emerald-200/80">
                                → {rawValue}
                              </span>
                            ) : null}
                          </p>
                          <div className="flex flex-wrap gap-1">
                            {[6, 8, 18].map((preset) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => {
                                  const nextDecimals = String(preset);
                                  setUintDecimals((current) => ({
                                    ...current,
                                    [input.name]: nextDecimals,
                                  }));
                                  syncDecimalAmountToRaw(input.name, decimalAmount, nextDecimals);
                                  setResult(undefined);
                                }}
                                className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                  decimalsText === String(preset)
                                    ? "bg-sky-400/15 text-sky-100"
                                    : "bg-white/[0.04] text-gray-400 hover:bg-white/[0.08]"
                                }`}
                              >
                                {preset}
                              </button>
                            ))}
                          </div>
                        </>
                      ) : (
                        <input
                          value={rawValue}
                          onChange={(event) => {
                            setArgValues((current) => ({
                              ...current,
                              [input.name]: event.target.value,
                            }));
                            setResult(undefined);
                          }}
                          placeholder={t("features.evm-contract-invoke.argPlaceholder", {
                            type: input.type,
                          })}
                          spellCheck={false}
                          className="h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40"
                        />
                      )}
                    </div>
                  );
                }
                return (
                  <label key={input.name} className="block space-y-1.5">
                    <span className="text-xs font-medium text-gray-400">
                      {input.name || "arg"} · {abiTypeLabel(input)}
                      {unsupported ? ` · ${t("features.evm-contract-invoke.unsupportedType")}` : ""}
                    </span>
                    <input
                      value={argValues[input.name] || ""}
                      onChange={(event) =>
                        setArgValues((current) => ({ ...current, [input.name]: event.target.value }))
                      }
                      placeholder={
                        input.type.endsWith("[]") || input.type === "tuple"
                          ? tf("features.evm-contract-invoke.jsonPlaceholder", "JSON，例如 [\"0x...\"]")
                          : t("features.evm-contract-invoke.argPlaceholder", { type: input.type })
                      }
                      spellCheck={false}
                      disabled={unsupported}
                      className="h-10 w-full rounded-lg border border-white/10 bg-black/30 px-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-emerald-300/40 disabled:opacity-40"
                    />
                  </label>
                );
              })
            ) : (
              <p className="text-xs text-gray-500">{t("features.evm-contract-invoke.noParameters")}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              disabled={loading || !selected}
              onClick={() => void runInvoke("call")}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-sky-400/90 px-4 text-sm font-semibold text-slate-950 hover:bg-sky-300 disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? t("features.evm-contract-invoke.calling") : t("features.evm-contract-invoke.callButton")}
            </button>
            <button
              type="button"
              disabled={loading || !selected || readable}
              onClick={() => void runInvoke("send")}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-emerald-400/90 px-4 text-sm font-semibold text-slate-950 hover:bg-emerald-300 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
              {loading ? t("features.evm-contract-invoke.sending") : t("features.evm-contract-invoke.sendButton")}
            </button>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-gray-200">{t("features.evm-contract-invoke.logs")}</h4>
            <pre className="max-h-64 overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-xs text-gray-300 scrollbar-thin">
              {(result?.logs && result.logs.length > 0)
                ? result.logs.join("\n")
                : t("features.evm-contract-invoke.noLogs")}
            </pre>
            {result?.error && (
              <p className="rounded-lg border border-rose-300/20 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
                {result.error}
              </p>
            )}
          </div>
        </section>
      </div>
      {walletPickerPortal}
    </div>
  );
}
