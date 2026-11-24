import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { type Meter, formatMyr, meterText, projectIdFromHash, usableMeter } from '../ai.ts';
import type { Branding } from '../branding.ts';
import { Bell } from '../views/Bell.tsx';
import { Letterhead } from '../views/Letterhead.tsx';
import { HeaderSearch } from '../views/Search.tsx';

export interface Spend {
  configured: boolean;
  month?: { limitMyr: string | null; usedMyr: string; remainingMyr: string } | null;
  /** With a project: the project's monthly figures for those who manage its AI use, otherwise the person's own remaining allowance. Null when no personal limit applies. */
  meter?: Meter | null;
}

/**
 * Inside a project the meter is the viewer's own remaining allowance there, or the project's monthly remaining for those who
 * manage its AI use. Outside a project only the Administrator has one: the organisation's month.
 */
export function useSpend(hash: string, isAdmin: boolean): Spend | null {
  const projectId = projectIdFromHash(hash);
  const [spend, setSpend] = useState<Spend | null>(null);
  useEffect(() => {
    if (!projectId && !isAdmin) return setSpend(null);
    let stale = false;
    api.get<Spend>(projectId ? `/ai/spend?projectId=${projectId}` : '/ai/spend').then(
      (s) => !stale && setSpend(s),
      () => !stale && setSpend(null),
    );
    return () => {
      stale = true;
    };
  }, [projectId, isAdmin]);
  return spend;
}

/** The AI spend meter's words; nothing when there is none for this person here. */
export function SpendMeter({ spend, hash, isAdmin, className }: { spend: Spend | null; hash: string; isAdmin: boolean; className: string }) {
  if (!spend) return null;
  const title = 'Counted from the start of the calendar month, UTC+8';
  if (projectIdFromHash(hash) && usableMeter(spend.meter)) {
    return <a className={`spend ${className}`} href="#/my-ai-usage" title={title}>{meterText(spend.meter)}</a>;
  }
  if (!isAdmin) return null;
  if (!spend.configured || !spend.month) return <span className={`spend spend-warn ${className}`}>AI spending is not set up, so extraction is off</span>;
  const { limitMyr, usedMyr } = spend.month;
  return (
    <span className={`spend ${className}`} title={title}>
      AI spend this month {formatMyr(usedMyr)} of {limitMyr === null ? 'no allowance' : formatMyr(limitMyr)}
    </span>
  );
}

const icon = (d: ReactNode) => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

/**
 * The slim top bar (spec 6.2): the Menu button (below 900 px), the organisation's logo and name, search, the bell, the AI
 * spend meter and the person menu. Below 700 px search is an icon button that opens the field on its own row.
 */
export function TopBar({
  hash,
  branding,
  menuId,
  menuOpen,
  onMenu,
  spend,
  person,
}: {
  hash: string;
  branding: Branding | null;
  menuId: string;
  menuOpen: boolean;
  onMenu: () => void;
  spend: ReactNode;
  person: ReactNode;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => setSearchOpen(false), [hash]);
  useEffect(() => {
    if (searchOpen) document.getElementById('header-search-input')?.focus();
  }, [searchOpen]);

  return (
    <header className="topbar">
      <button type="button" id="menu-toggle" className="menu-toggle" aria-expanded={menuOpen} aria-controls={menuId} onClick={onMenu}>
        {icon(<path d="M4 7h16M4 12h16M4 17h16" />)}
        Menu
      </button>
      <a className="topbar-home" href="#/">
        {branding ? <Letterhead branding={branding} place="header" /> : <span className="wordmark">Kainow</span>}
        <span className="visually-hidden">, Home</span>
      </a>
      <button
        type="button"
        id="search-toggle"
        className="search-toggle"
        aria-expanded={searchOpen}
        aria-controls="topbar-search"
        aria-label="Search"
        onClick={() => setSearchOpen((o) => !o)}
      >
        {icon(<><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>)}
      </button>
      <div
        id="topbar-search"
        className={searchOpen ? 'topbar-search open' : 'topbar-search'}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && searchOpen) {
            setSearchOpen(false);
            document.getElementById('search-toggle')?.focus();
          }
        }}
      >
        <HeaderSearch hash={hash} />
      </div>
      {spend}
      <Bell hash={hash} />
      {person}
    </header>
  );
}
