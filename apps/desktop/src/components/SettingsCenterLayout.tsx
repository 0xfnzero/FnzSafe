"use client";

import type { ReactNode } from "react";
import { ArrowLeft, ChevronRight, Search } from "lucide-react";
import { matchesSettingsSearch, type SettingsSearchItem, type SettingsSection } from "@/lib/settingsCenter";

export interface SettingsNavigationItem extends SettingsSearchItem {
  id: Exclude<SettingsSection, "root">;
  group: string;
  icon: ReactNode;
}

export interface SettingsNavigationGroup {
  id: string;
  title: string;
}

interface SettingsCenterLayoutProps {
  section: SettingsSection;
  items: SettingsNavigationItem[];
  groups: SettingsNavigationGroup[];
  search: string;
  onSearchChange: (value: string) => void;
  onSectionChange: (section: SettingsSection) => void;
  title: string;
  searchPlaceholder: string;
  noResultsLabel: string;
  backLabel: string;
  children: ReactNode;
}

export function SettingsCenterLayout({
  section,
  items,
  groups,
  search,
  onSearchChange,
  onSectionChange,
  title,
  searchPlaceholder,
  noResultsLabel,
  backLabel,
  children,
}: SettingsCenterLayoutProps) {
  const visibleItems = items.filter((item) => matchesSettingsSearch(item, search));
  const activeItem = items.find((item) => item.id === section);

  return (
    <div className="mx-auto w-full max-w-5xl">
      {section === "root" ? (
        <div className="mx-auto max-w-3xl space-y-5">
          <label className="relative block">
            <span className="sr-only">{searchPlaceholder}</span>
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" />
            <input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder={searchPlaceholder}
              className="h-11 w-full rounded-lg border border-white/10 bg-white/[0.045] pl-10 pr-3 text-sm text-gray-100 outline-none placeholder:text-gray-600 focus:border-white/20 focus:ring-2 focus:ring-white/10"
            />
          </label>

          {groups.map((group) => {
            const groupItems = visibleItems.filter((item) => item.group === group.id);
            if (groupItems.length === 0) return null;
            return (
              <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
                <h3 id={`settings-group-${group.id}`} className="mb-2 px-1 text-xs font-semibold text-gray-500">
                  {group.title}
                </h3>
                <div className="divide-y divide-white/[0.08] overflow-hidden rounded-lg border border-white/10 bg-white/[0.035]">
                  {groupItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSectionChange(item.id)}
                      className="group flex min-h-14 w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none"
                    >
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-gray-300">
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-100">{item.title}</span>
                      {item.summary && (
                        <span className="hidden max-w-[45%] shrink-0 truncate text-xs text-gray-500 sm:block">
                          {item.summary}
                        </span>
                      )}
                      <ChevronRight className="h-4 w-4 shrink-0 text-gray-600 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-400" />
                    </button>
                  ))}
                </div>
              </section>
            );
          })}

          {visibleItems.length === 0 && <div className="py-16 text-center text-sm text-gray-500">{noResultsLabel}</div>}
        </div>
      ) : (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => onSectionChange("root")}
            className="group inline-flex min-h-10 max-w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/10"
            aria-label={backLabel}
          >
            <ArrowLeft className="h-4 w-4 shrink-0 text-gray-500 transition-transform group-hover:-translate-x-0.5 group-hover:text-gray-300" />
            <span className="min-w-0">
              <span className="block text-[11px] text-gray-500">{title}</span>
              <span className="block truncate text-base font-semibold text-gray-100">{activeItem?.title}</span>
            </span>
          </button>
          {children}
        </div>
      )}
    </div>
  );
}
