import { useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export type Theme = 'system' | 'light' | 'dark';
const key = 'fnzsafe-appearance';
const media = window.matchMedia('(prefers-color-scheme: dark)');
function preference(): Theme {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system'; }
  catch { return 'system'; }
}
function applyTheme() {
  const value = preference();
  document.documentElement.dataset.theme = value === 'system' ? media.matches ? 'dark' : 'light' : value;
}
applyTheme();
media.addEventListener('change', applyTheme);
window.addEventListener('storage', applyTheme);
function subscribe(listener: () => void) {
  window.addEventListener('storage', listener);
  window.addEventListener('fnzsafe-theme', listener);
  return () => { window.removeEventListener('storage', listener); window.removeEventListener('fnzsafe-theme', listener); };
}
function change(value: Theme) {
  localStorage.setItem(key, value);
  applyTheme();
  window.dispatchEvent(new Event('fnzsafe-theme'));
}
export function ThemeControl() {
  const theme = useSyncExternalStore(subscribe, preference);
  return <label className="theme-control" title="Appearance">
    {theme === 'dark' ? <Moon size={17} /> : theme === 'light' ? <Sun size={17} /> : <Monitor size={17} />}
    <select aria-label="Appearance" value={theme} onChange={e => change(e.target.value as Theme)}>
      <option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>
    </select>
  </label>;
}
export function ThemeSettings() {
  const theme = useSyncExternalStore(subscribe, preference);
  return <section className="settings-panel appearance-panel"><div className="panel-heading"><h3>Appearance</h3><span>Make it yours</span></div>
    <div className="theme-options" role="group" aria-label="Wallet theme">
      {(['light', 'dark', 'system'] as const).map(value => <button key={value} aria-pressed={theme === value} className={`theme-option ${theme === value ? 'selected' : ''}`} onClick={() => change(value)}>
        <span className={`theme-swatch ${value}`} aria-hidden="true"><i /><i /><i /></span>
        <span>{value === 'light' ? <Sun size={14} /> : value === 'dark' ? <Moon size={14} /> : <Monitor size={14} />}{value[0].toUpperCase() + value.slice(1)}</span>
      </button>)}
    </div>
    <p className="fine-print">Your choice also applies to transaction confirmations.</p>
  </section>;
}
