"use client";

import { useRef, type ReactNode } from "react";
import { Search, X } from "lucide-react";
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
  clearSearchLabel: string;
  children: ReactNode;
}

export function SettingsCenterLayout({
  section, items, groups, search, onSearchChange, onSectionChange,
  title, searchPlaceholder, noResultsLabel, clearSearchLabel, children,
}: SettingsCenterLayoutProps) {
  const visibleItems = items.filter((item) => matchesSettingsSearch(item, search));
  const activeItem = items.find((item) => item.id === section);
  const contentRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectSection = (next: SettingsSection) => {
    if (next === section) return;
    onSectionChange(next);
    contentRef.current?.scrollTo({ top: 0 });
  };

  return (
    <div className="settings-layout">
      <aside className="settings-navigation">
        <div className="settings-navigation-header">
          <h2>{title}</h2>
          <label className="settings-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              aria-label={searchPlaceholder}
              placeholder={searchPlaceholder}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
            {search && <button type="button" aria-label={clearSearchLabel} onClick={() => {
              onSearchChange("");
              searchRef.current?.focus();
            }}><X size={14} aria-hidden="true" /></button>}
          </label>
        </div>
        <nav aria-label={title} className="settings-navigation-list">
          {groups.map((group) => {
            const groupItems = visibleItems.filter((item) => item.group === group.id);
            if (!groupItems.length) return null;
            return <div className="settings-navigation-group" key={group.id}>
              <p className="settings-navigation-group-title" id={`settings-group-${group.id}`}>{group.title}</p>
              <div role="group" aria-labelledby={`settings-group-${group.id}`}>
                {groupItems.map((item) => <button
                  key={item.id}
                  type="button"
                  className="settings-navigation-item"
                  aria-current={section === item.id ? "page" : undefined}
                  aria-controls="settings-detail"
                  title={item.description}
                  onClick={() => selectSection(item.id)}
                >
                  <span className="settings-navigation-icon" aria-hidden="true">{item.icon}</span>
                  <span>{item.title}</span>
                </button>)}
              </div>
            </div>;
          })}
          {!visibleItems.length && <p className="settings-search-empty" role="status">{noResultsLabel}</p>}
        </nav>
      </aside>
      <section ref={contentRef} id="settings-detail" className="settings-detail" aria-labelledby="settings-detail-title" tabIndex={0}>
        <div className="settings-detail-inner">
          <header className="settings-detail-header">
            <div>
              <h2 id="settings-detail-title">{activeItem?.title}</h2>
              {activeItem?.description && <p>{activeItem.description}</p>}
            </div>
            {activeItem?.summary && <span className="settings-detail-summary">{activeItem.summary}</span>}
          </header>
          <div className="settings-content-body">{children}</div>
        </div>
      </section>
    </div>
  );
}
