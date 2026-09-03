import catalog from "../../ai-runtime/skill-catalog.json";

export type AiSkillKind = "skill" | "role";
export type AiSkillCategory = "market" | "defi" | "risk" | "intelligence" | "research" | "role";
export type AiSkillLocale = "zh" | "en";

export interface AiSkillCatalogEntry {
  id: string;
  kind: AiSkillKind;
  category: AiSkillCategory;
  icon: string;
  name: Record<AiSkillLocale, string>;
  description: Record<AiSkillLocale, string>;
  useCases: Record<AiSkillLocale, string[]>;
  sources: string[];
  tools: string[];
}

export const AI_SKILL_CATALOG_VERSION = catalog.version;
export const AI_SKILL_CATALOG = catalog.entries as AiSkillCatalogEntry[];
export const AI_SKILL_COUNT = AI_SKILL_CATALOG.filter((entry) => entry.kind === "skill").length;
export const AI_ROLE_CARD_COUNT = AI_SKILL_CATALOG.length - AI_SKILL_COUNT;

export function filterAiSkillCatalog(
  entries: AiSkillCatalogEntry[],
  locale: AiSkillLocale,
  category: "all" | AiSkillCategory,
  search: string,
): AiSkillCatalogEntry[] {
  const query = search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (category !== "all" && entry.category !== category) return false;
    if (!query) return true;
    return [
      entry.name[locale],
      entry.name[locale === "zh" ? "en" : "zh"],
      entry.description[locale],
      ...entry.useCases[locale],
      ...entry.sources,
      ...entry.tools,
    ].join(" ").toLocaleLowerCase().includes(query);
  });
}
