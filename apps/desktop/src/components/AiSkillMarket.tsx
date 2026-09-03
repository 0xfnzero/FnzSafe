"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  BrainCircuit,
  CheckCircle2,
  Coins,
  Database,
  Flame,
  Layers3,
  Newspaper,
  Radio,
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
    sources: "数据源", tools: "工具入口", noTools: "编排与判断能力", noResults: "没有匹配的内置技能",
    title: "Web3 AI 能力目录", hint: "所有能力随钱包提供，由 AI 按问题自动选择，无需安装。工具只读取公开市场数据或本地 KOL 证据。",
  },
  en: {
    all: "All", market: "Market", defi: "DeFi", risk: "Risk", intelligence: "Intelligence", research: "Research", role: "Roles",
    search: "Search skills, use cases, sources, or tools", builtIn: "Built in", ready: "Available", skill: "Skill", roleCard: "Role card",
    sources: "Sources", tools: "Tool access", noTools: "Reasoning and orchestration", noResults: "No built-in skills match this search",
    title: "Web3 AI capability catalog", hint: "Every capability ships with the wallet and is selected automatically by the AI. Tools only read public market data or local KOL evidence.",
  },
} as const;

export function AiSkillMarket({ locale }: { locale: AiSkillLocale }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | AiSkillCategory>("all");
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
  const visibleSkills = useMemo(
    () => filterAiSkillCatalog(AI_SKILL_CATALOG, locale, category, search),
    [category, locale, search],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-2xl">
          <h3 className="text-sm font-semibold text-gray-100">{copy.title}</h3>
          <p className="mt-1 text-xs leading-5 text-gray-500">{copy.hint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-4 text-xs">
          <div><span className="block text-lg font-semibold text-gray-100">{AI_SKILL_COUNT}</span><span className="text-gray-500">{copy.skill}</span></div>
          <div className="h-8 w-px bg-white/10" />
          <div><span className="block text-lg font-semibold text-gray-100">{AI_ROLE_CARD_COUNT}</span><span className="text-gray-500">{copy.roleCard}</span></div>
        </div>
      </div>

      <div className="space-y-3">
        <label className="relative block">
          <span className="sr-only">{copy.search}</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={copy.search}
            className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.035] pl-10 pr-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-white/20 focus:ring-2 focus:ring-white/10"
          />
        </label>
        <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-white/10 bg-black/20 p-1" role="tablist" aria-label={copy.title}>
          {categories.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={category === option.id}
              onClick={() => setCategory(option.id)}
              className={`h-8 shrink-0 rounded-md px-3 text-xs font-medium transition-colors ${category === option.id ? "bg-white text-black" : "text-gray-400 hover:bg-white/[0.07] hover:text-gray-200"}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {visibleSkills.length > 0 ? (
        <div className="grid items-stretch gap-3 md:grid-cols-2">
          {visibleSkills.map((skill) => {
            const SkillIcon = SKILL_ICONS[skill.icon] ?? Sparkles;
            const categoryStyle = CATEGORY_STYLES[skill.category];
            const categoryLabel = categories.find((option) => option.id === skill.category)?.label ?? skill.category;
            return (
              <article key={skill.id} className="flex min-h-[250px] flex-col rounded-lg border border-white/10 bg-white/[0.035] p-4 transition-colors hover:border-white/20 hover:bg-white/[0.05]">
                <div className="flex items-start gap-3">
                  <span className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${categoryStyle.icon}`}>
                    <SkillIcon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="min-w-0 text-sm font-semibold leading-5 text-gray-100">{skill.name[locale]}</h4>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${categoryStyle.badge}`}>{categoryLabel}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                      <span>{skill.kind === "role" ? copy.roleCard : copy.skill}</span>
                      <span className="h-1 w-1 rounded-full bg-gray-700" />
                      <span>{copy.builtIn}</span>
                      <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3 w-3" />{copy.ready}</span>
                    </div>
                  </div>
                </div>

                <p className="mt-3 text-xs leading-5 text-gray-400">{skill.description[locale]}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {skill.useCases[locale].map((useCase) => (
                    <span key={useCase} className="rounded-md bg-black/25 px-2 py-1 text-[11px] text-gray-300">{useCase}</span>
                  ))}
                </div>

                <div className="mt-auto space-y-2 border-t border-white/[0.08] pt-3 text-[11px]">
                  <div className="flex items-start gap-2">
                    <Database className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-600" />
                    <span className="shrink-0 text-gray-600">{copy.sources}</span>
                    <span className="min-w-0 text-gray-400">{skill.sources.join(" · ")}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Activity className="h-3.5 w-3.5 shrink-0 text-gray-600" />
                    <span className="text-gray-600">{copy.tools}</span>
                    <span className="text-gray-400">{skill.tools.length > 0 ? skill.tools.length : copy.noTools}</span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="py-16 text-center text-sm text-gray-500">{copy.noResults}</div>
      )}
    </div>
  );
}
