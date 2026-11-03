'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { locales, localeNames, type Locale } from '@/i18n/config';
import { ChevronDown, Globe2, Languages } from 'lucide-react';

function LocaleIcon({ locale }: { locale: Locale }) {
  return locale === 'zh' ? <Languages className="h-4 w-4" /> : <Globe2 className="h-4 w-4" />;
}

export default function LanguageSwitcher({ compact = true }: { compact?: boolean }) {
  const params = useParams();
  const locale = (params?.locale as string) || 'en';
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const switchLocale = (newLocale: Locale) => {
    // Replace the current locale in the pathname
    const segments = pathname.split('/');
    segments[1] = newLocale;
    const newPath = segments.join('/');
    setOpen(false);
    router.push(newPath);
  };

  return (
    <div ref={switcherRef} className="app-language-switcher relative">
      <button
        type="button"
        onClick={() => setOpen((nextOpen) => !nextOpen)}
        className={`app-language-menu-button inline-flex h-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-gray-200 transition-colors hover:bg-white/10 hover:text-white ${compact ? "w-10" : "min-w-36 gap-2 px-3 text-sm"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={localeNames[locale as Locale]}
        title={localeNames[locale as Locale]}
      >
        <LocaleIcon locale={locale as Locale} />
        {!compact && <><span className="flex-1 text-left">{localeNames[locale as Locale]}</span><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></>}
      </button>
      {open && (
      <div role="menu" className={`absolute bottom-full z-50 mb-2 w-40 ${compact ? "left-0" : "right-0"}`}>
        <div className="app-language-menu bg-black/90 backdrop-blur-xl rounded-lg border border-white/10 shadow-xl overflow-hidden">
          {locales.map((loc) => (
            <button type="button"
              key={loc}
              onClick={() => switchLocale(loc)}
              role="menuitemradio"
              aria-checked={locale === loc}
              className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-white/10 transition-colors ${
                locale === loc ? 'bg-purple-500/20 text-purple-400' : 'text-gray-300'
              }`}
            >
              <LocaleIcon locale={loc} />
              <span className="truncate">{localeNames[loc]}</span>
            </button>
          ))}
        </div>
      </div>
      )}
    </div>
  );
}
