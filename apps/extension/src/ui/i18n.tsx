import { useSyncExternalStore } from 'react';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

export type Locale = 'en' | 'zh-CN' | 'zh-TW';
type Preference = Locale | 'system';
const storageKey = 'fnzsafe-language';
const dictionaries: Record<string, Record<string, string>> = { 'zh-CN': zhCN, 'zh-TW': zhTW };
export function detectLocale(language: string): Locale {
  return /^zh-(TW|HK|MO|Hant)/i.test(language) ? 'zh-TW' : /^zh/i.test(language) ? 'zh-CN' : 'en';
}
function preference(): Preference {
  try { const value = localStorage.getItem(storageKey); return value === 'en' || value === 'zh-CN' || value === 'zh-TW' ? value : 'system'; }
  catch { return 'system'; }
}
function locale(): Locale { const value = preference(); return value === 'system' ? detectLocale(navigator.language) : value; }
export function translate(language: Locale, key: string, values: Record<string, string | number> = {}): string {
  const text = dictionaries[language]?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match);
}
export function t(key: string, values?: Record<string, string | number>): string { return translate(locale(), key, values); }
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener); window.addEventListener('fnzsafe-language', listener); window.addEventListener('languagechange', listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener('fnzsafe-language', listener); window.removeEventListener('languagechange', listener); };
}
export function useLocale() {
  const value = useSyncExternalStore(subscribe, () => `${preference()}:${locale()}`);
  document.documentElement.lang = locale();
  return value;
}
export function LanguageSettings() {
  useLocale();
  return <section className="settings-panel"><label>{t('Language')}<select aria-label={t('Language')} value={preference()} onChange={e => { localStorage.setItem(storageKey, e.target.value); window.dispatchEvent(new Event('fnzsafe-language')); }}><option value="system">{t('Follow browser')}</option><option value="en">English</option><option value="zh-CN">简体中文</option><option value="zh-TW">繁體中文</option></select></label><p className="fine-print">{t('Language also applies to approval windows.')}</p></section>;
}
