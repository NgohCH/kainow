import { meaningVar } from './StatusLabel.tsx';
import type { Meaning } from './meanings.ts';

export interface BinderTab { key: string; href: string; text: string; badge?: { count: number; meaning: Meaning } }

/** Project section navigation: links (they change the address), the open one filled and joined to the page. */
export function BinderTabs({ label, tabs, current }: { label: string; tabs: BinderTab[]; current: string }) {
  return (
    <nav className="binder-tabs" aria-label={label}>
      <ul>
        {tabs.map((t) => (
          <li key={t.key}>
            <a href={t.href} className={t.key === current ? 'open' : undefined} aria-current={t.key === current ? 'page' : undefined}>
              {t.text}
              {t.badge && t.badge.count > 0 && (
                <span className={`tab-badge m-${meaningVar(t.badge.meaning)}`}>
                  {t.badge.count}<span className="visually-hidden"> need attention</span>
                </span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
