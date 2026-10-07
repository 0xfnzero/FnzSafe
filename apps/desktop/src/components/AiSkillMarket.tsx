"use client";

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Activity,
  BarChart3,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Coins,
  Database,
  Download,
  ExternalLink,
  Flame,
  Layers3,
  LoaderCircle,
  Newspaper,
  PackageCheck,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  AI_ROLE_CARD_COUNT,
  AI_SKILL_CATALOG,
  AI_SKILL_COUNT,
  filterAiSkillCatalog,
  type AiSkillCategory,
  type AiSkillLocale,
} from "@/lib/aiSkillCatalog";
import { openExternalUrl } from "@/lib/openExternal";

type BinanceSkill = {
  id: string;
  name: string;
  description: string;
  version: string;
  sourcePath: string;
  collection: "binance-web3" | "binance";
  runtimeMode: "knowledge";
  hasRemoteCode: boolean;
  installed: boolean;
  installedVersion: string;
  installedCommit: string;
  updateAvailable: boolean;
};

type BinanceSkillCatalog = {
  source: string;
  sourceUrl: string;
  commit: string;
  fetchedAt: number;
  skills: BinanceSkill[];
};

const SKILL_ICONS: Record<string, typeof Sparkles> = {
  activity: Activity,
  bot: Bot,
  brain: BrainCircuit,
  chart: BarChart3,
  check: CheckCircle2,
  coins: Coins,
  database: Database,
  flame: Flame,
  layers: Layers3,
  news: Newspaper,
  radio: Radio,
  search: Search,
  shield: ShieldCheck,
  trending: TrendingUp,
};

const CATEGORY_STYLES: Record<AiSkillCategory, { icon: string; badge: string }> = {
  market: { icon: "bg-cyan-400/10 text-cyan-200", badge: "border-cyan-300/20 text-cyan-200" },
  defi: { icon: "bg-emerald-400/10 text-emerald-200", badge: "border-emerald-300/20 text-emerald-200" },
  risk: { icon: "bg-rose-400/10 text-rose-200", badge: "border-rose-300/20 text-rose-200" },
  intelligence: { icon: "bg-amber-400/10 text-amber-200", badge: "border-amber-300/20 text-amber-200" },
  research: { icon: "bg-blue-400/10 text-blue-200", badge: "border-blue-300/20 text-blue-200" },
  role: { icon: "bg-violet-400/10 text-violet-200", badge: "border-violet-300/20 text-violet-200" },
};

const COPY = {
  zh: {
    all: "全部", market: "市场", defi: "DeFi", risk: "风险", intelligence: "情报", research: "研究", role: "角色",
    search: "搜索技能、用途、数据源或工具", builtIn: "内置", ready: "可用", skill: "技能", roleCard: "角色卡",
    sources: "数据源", tools: "工具入口", noTools: "编排与判断能力", noResults: "没有匹配的技能",
    title: "Web3 AI 技能市场", hint: "币安技能自动同步自官方 Skills Hub；已安装技能固定到同步时的提交版本。",
    binance: "币安官方", fnzsafe: "FnzSafe 内置", official: "官方", install: "安装", update: "更新", installed: "已安装",
    installing: "安装中", refreshing: "正在同步币安技能", refresh: "刷新币安技能", unavailable: "仅桌面版支持同步和安装",
    syncFailed: "币安技能同步失败", installFailed: "技能安装失败", installComplete: "技能安装完成", updated: "技能更新完成",
    version: "版本", synced: "同步于", commit: "提交", remoteEmpty: "币安官方技能列表为空",
    knowledge: "知识型", noRemoteCode: "仅安装文档，不执行远程脚本", exchange: "Binance", web3: "Binance Web3",
  },
  en: {
    all: "All", market: "Market", defi: "DeFi", risk: "Risk", intelligence: "Intelligence", research: "Research", role: "Roles",
    search: "Search skills, use cases, sources, or tools", builtIn: "Built in", ready: "Available", skill: "Skill", roleCard: "Role card",
    sources: "Sources", tools: "Tool access", noTools: "Reasoning and orchestration", noResults: "No skills match this search",
    title: "Web3 AI Skill Market", hint: "Binance skills sync from the official Skills Hub and installed versions are pinned to the synced commit.",
    binance: "Binance official", fnzsafe: "FnzSafe built in", official: "Official", install: "Install", update: "Update", installed: "Installed",
    installing: "Installing", refreshing: "Syncing Binance skills", refresh: "Refresh Binance skills", unavailable: "Sync and installation require the desktop app",
    syncFailed: "Binance skill sync failed", installFailed: "Skill installation failed", installComplete: "Skill installed", updated: "Skill updated",
    version: "Version", synced: "Synced", commit: "Commit", remoteEmpty: "No official Binance skills are available",
    knowledge: "Knowledge", noRemoteCode: "Documentation only; remote scripts are never executed", exchange: "Binance", web3: "Binance Web3",
  },
} as const;

function errorText(error: unknown) {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function AiSkillMarket({ locale, desktop }: { locale: AiSkillLocale; desktop: boolean }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | AiSkillCategory>("all");
  const [source, setSource] = useState<"binance" | "fnzsafe">("binance");
  const [catalog, setCatalog] = useState<BinanceSkillCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [syncError, setSyncError] = useState("");
  const initialized = useRef(false);
  const copy = COPY[locale];
  const categories: Array<{ id: "all" | AiSkillCategory; label: string }> = [
    { id: "all", label: copy.all },
    { id: "market", label: copy.market },
    { id: "defi", label: copy.defi },
    { id: "risk", label: copy.risk },
    { id: "intelligence", label: copy.intelligence },
    { id: "research", label: copy.research },
    { id: "role", label: copy.role },
  ];
  const visibleBuiltInSkills = useMemo(
    () => filterAiSkillCatalog(AI_SKILL_CATALOG, locale, category, search),
    [category, locale, search],
  );
  const visibleBinanceSkills = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return catalog?.skills ?? [];
    return (catalog?.skills ?? []).filter((skill) =>
      `${skill.id} ${skill.name} ${skill.description} ${skill.version}`.toLocaleLowerCase().includes(query),
    );
  }, [catalog, search]);
  const installedCount = catalog?.skills.filter((skill) => skill.installed).length ?? 0;

  const syncCatalog = useCallback(async (force: boolean) => {
    if (!desktop) return;
    setLoading(true);
    setSyncError("");
    try {
      setCatalog(await invoke<BinanceSkillCatalog>("binance_skill_market_sync", { force }));
    } catch (error) {
      const message = errorText(error);
      setSyncError(message);
      if (force) toast.error(`${COPY[locale].syncFailed}: ${message}`);
    } finally {
      setLoading(false);
    }
  }, [desktop, locale]);

  useEffect(() => {
    if (!desktop || initialized.current) return;
    initialized.current = true;
    void syncCatalog(false);
  }, [desktop, syncCatalog]);

  const installSkill = useCallback(async (skill: BinanceSkill) => {
    if (!desktop || !catalog || installing) return;
    setInstalling(skill.id);
    try {
      await invoke("binance_skill_install", {
        request: { skillId: skill.id, commit: catalog.commit, sourcePath: skill.sourcePath },
      });
      await syncCatalog(false);
      toast.success(skill.installed ? copy.updated : copy.installComplete);
    } catch (error) {
      toast.error(`${copy.installFailed}: ${errorText(error)}`);
    } finally {
      setInstalling(null);
    }
  }, [catalog, copy, desktop, installing, syncCatalog]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <h3 className="text-sm font-semibold text-gray-100">{copy.title}</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500">{copy.hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs">
          <div><span className="block text-lg font-semibold text-gray-100">{source === "binance" ? catalog?.skills.length ?? "-" : AI_SKILL_COUNT}</span><span className="text-gray-500">{copy.skill}</span></div>
          <div className="h-8 w-px bg-white/10" />
          <div><span className="block text-lg font-semibold text-gray-100">{source === "binance" ? installedCount : AI_ROLE_CARD_COUNT}</span><span className="text-gray-500">{source === "binance" ? copy.installed : copy.roleCard}</span></div>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={copy.title}>
            <button type="button" role="tab" aria-selected={source === "binance"} onClick={() => setSource("binance")} className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${source === "binance" ? "bg-white text-black" : "text-gray-400 hover:bg-white/[0.07] hover:text-gray-200"}`}>{copy.binance}</button>
            <button type="button" role="tab" aria-selected={source === "fnzsafe"} onClick={() => setSource("fnzsafe")} className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${source === "fnzsafe" ? "bg-white text-black" : "text-gray-400 hover:bg-white/[0.07] hover:text-gray-200"}`}>{copy.fnzsafe}</button>
          </div>
          {source === "binance" && (
            <button type="button" onClick={() => void syncCatalog(true)} disabled={!desktop || loading} aria-label={copy.refresh} title={copy.refresh} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/10 text-gray-300 hover:bg-white/[0.07] disabled:cursor-not-allowed disabled:opacity-40">
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
        <label className="relative block">
          <span className="sr-only">{copy.search}</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={copy.search} className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-10 pr-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-white/20 focus:ring-2 focus:ring-white/10" />
        </label>
        {source === "fnzsafe" && (
          <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={copy.fnzsafe}>
            {categories.map((option) => (
              <button key={option.id} type="button" role="tab" aria-selected={category === option.id} onClick={() => setCategory(option.id)} className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${category === option.id ? "bg-white text-black" : "text-gray-400 hover:bg-white/[0.07] hover:text-gray-200"}`}>{option.label}</button>
            ))}
          </div>
        )}
      </div>

      {source === "binance" ? (
        <div className="space-y-3">
          {catalog && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
              <button type="button" onClick={() => void openExternalUrl(catalog.sourceUrl).catch((error) => toast.error(errorText(error)))} className="inline-flex items-center gap-1 text-amber-200 hover:text-amber-100">{catalog.source}<ExternalLink className="h-3 w-3" /></button>
              <span>{copy.commit} <button type="button" onClick={() => void openExternalUrl(`${catalog.sourceUrl}/commit/${catalog.commit}`).catch((error) => toast.error(errorText(error)))} className="font-mono text-gray-400 hover:text-gray-200">{catalog.commit.slice(0, 8)}</button></span>
              <span>{copy.synced} {new Date(catalog.fetchedAt).toLocaleString(locale === "zh" ? "zh-CN" : "en-US")}</span>
            </div>
          )}
          {!desktop && <div className="rounded-lg border border-amber-300/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-100">{copy.unavailable}</div>}
          {loading && !catalog && <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500"><LoaderCircle className="h-4 w-4 animate-spin" />{copy.refreshing}</div>}
          {syncError && !catalog && <div className="rounded-lg border border-red-300/20 bg-red-400/[0.05] px-4 py-3 text-xs leading-5 text-red-200">{copy.syncFailed}: {syncError}</div>}
          {catalog && visibleBinanceSkills.length > 0 && (
            <div className="grid items-stretch gap-3 md:grid-cols-2">
              {visibleBinanceSkills.map((skill) => {
                const busy = installing === skill.id;
                let ActionIcon = Download;
                let actionLabel: string = copy.install;
                if (busy) {
                  ActionIcon = LoaderCircle;
                  actionLabel = copy.installing;
                } else if (skill.updateAvailable) {
                  actionLabel = copy.update;
                } else if (skill.installed) {
                  ActionIcon = CheckCircle2;
                  actionLabel = copy.installed;
                }
                return (
                  <article key={skill.id} className="flex min-h-[210px] flex-col rounded-lg border border-white/10 bg-white/[0.035] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.05]">
                    <div className="flex items-start gap-3">
                      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 text-amber-200"><Sparkles className="h-5 w-5" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5"><h4 className="min-w-0 break-words text-sm font-semibold leading-5 text-gray-100">{skill.name}</h4><span className="rounded border border-amber-300/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200">{copy.official}</span><span className="rounded border border-cyan-300/20 px-1.5 py-0.5 text-[10px] font-medium text-cyan-200">{copy.knowledge}</span></div>
                        <p className="mt-1 break-all font-mono text-[10px] text-gray-600">{skill.id}</p>
                      </div>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-gray-400">{skill.description}</p>
                    <div className="mt-auto flex flex-wrap items-end justify-between gap-3 border-t border-white/[0.08] pt-3">
                      <div className="text-[11px] text-gray-500">
                        <span>{skill.collection === "binance-web3" ? copy.web3 : copy.exchange} · {copy.version} {skill.version}</span>
                        {skill.installed && <span className="ml-2 inline-flex items-center gap-1 text-emerald-300"><PackageCheck className="h-3.5 w-3.5" />{copy.installed}</span>}
                        {skill.hasRemoteCode && <span className="mt-1 block text-amber-200/70">{copy.noRemoteCode}</span>}
                      </div>
                      <button type="button" onClick={() => void installSkill(skill)} disabled={!desktop || Boolean(installing) || (skill.installed && !skill.updateAvailable)} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold text-black hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-45">
                        <ActionIcon className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
                        {actionLabel}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
          {catalog && visibleBinanceSkills.length === 0 && <div className="py-16 text-center text-sm text-gray-500">{search ? copy.noResults : copy.remoteEmpty}</div>}
        </div>
      ) : visibleBuiltInSkills.length > 0 ? (
        <div className="grid items-stretch gap-3 md:grid-cols-2">
          {visibleBuiltInSkills.map((skill) => {
            const SkillIcon = SKILL_ICONS[skill.icon] ?? Sparkles;
            const categoryStyle = CATEGORY_STYLES[skill.category];
            const categoryLabel = categories.find((option) => option.id === skill.category)?.label ?? skill.category;
            return (
              <article key={skill.id} className="flex min-h-[250px] flex-col rounded-lg border border-white/10 bg-white/[0.035] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.05]">
                <div className="flex items-start gap-3">
                  <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${categoryStyle.icon}`}><SkillIcon className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5"><h4 className="min-w-0 text-sm font-semibold leading-5 text-gray-100">{skill.name[locale]}</h4><span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${categoryStyle.badge}`}>{categoryLabel}</span></div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-500"><span>{skill.kind === "role" ? copy.roleCard : copy.skill}</span><span className="h-1 w-1 rounded-full bg-gray-700" /><span>{copy.builtIn}</span><span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3 w-3" />{copy.ready}</span></div>
                  </div>
                </div>
                <p className="mt-3 text-xs leading-5 text-gray-400">{skill.description[locale]}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">{skill.useCases[locale].map((useCase) => <span key={useCase} className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-gray-300">{useCase}</span>)}</div>
                <div className="mt-auto space-y-2 border-t border-white/[0.08] pt-3 text-[11px]">
                  <div className="flex items-start gap-2"><Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-600" /><span className="shrink-0 text-gray-600">{copy.sources}</span><span className="min-w-0 text-gray-400">{skill.sources.join(" · ")}</span></div>
                  <div className="flex items-center gap-2"><Activity className="h-3.5 w-3.5 shrink-0 text-gray-600" /><span className="text-gray-600">{copy.tools}</span><span className="text-gray-400">{skill.tools.length > 0 ? skill.tools.length : copy.noTools}</span></div>
                </div>
              </article>
            );
          })}
        </div>
      ) : <div className="py-16 text-center text-sm text-gray-500">{copy.noResults}</div>}
    </div>
  );
}
