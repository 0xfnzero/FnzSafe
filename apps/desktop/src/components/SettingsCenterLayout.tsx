"use client";

import { EmptyState } from "./LoadingState";
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
        <div className="settings-home mx-auto space-y-6">
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

          <div className="settings-groups">{groups.map((group) => {
            const groupItems = visibleItems.filter((item) => item.group === group.id);
            if (groupItems.length === 0) return null;
            return (
              <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
                <h3 id={`settings-group-${group.id}`} className="mb-2 px-1 text-xs font-semibold text-gray-500">
                  {group.title}
                </h3>
                <div className="settings-group-list">
                  {groupItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSectionChange(item.id)}
                      className="settings-item group"
                    >
                      <span className="settings-item-icon">
                        {item.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-gray-100">{item.title}</span>
                        {item.description && <span className="mt-1.5 block text-xs leading-relaxed text-gray-400">{item.description}</span>}
                        {item.summary && <span className="mt-2 inline-block max-w-full truncate rounded-md bg-white/5 px-2 py-1 text-[11px] text-gray-400">{item.summary}</span>}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-gray-600 transition-transform group-hover:translate-x-0.5 group-hover:text-gray-400" />
                    </button>
                  ))}
                </div>
              </section>
            );
          })}</div>

          {visibleItems.length === 0 && <EmptyState title={noResultsLabel} search />}
        </div>
      ) : (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => onSectionChange("root")}
            className="settings-section-header group flex min-h-14 w-full items-center gap-3 text-left"
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
