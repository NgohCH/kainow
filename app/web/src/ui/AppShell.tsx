import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { Branding } from '../branding.ts';
import type { PersonalDashboard } from '../dashboard.ts';
import { homeQuery } from '../dashboard.ts';
import { DEFAULT_PREFS, type Prefs } from '../prefs.ts';
import { Customise } from '../views/Customise.tsx';
import { OpsBanner } from '../views/OpsBanner.tsx';
import { reviewItems } from './home.ts';
import { PROJECTS_CHANGED, currentMenuHref, menuProjects, sideMenuGroups, type MenuContext, type MenuItem } from './menu.ts';
import { PERSON_BUTTON_ID, PersonMenu } from './PersonMenu.tsx';
import { SideMenu } from './SideMenu.tsx';
import { SpendMeter, TopBar, useSpend } from './TopBar.tsx';

const MENU_ID = 'side-menu';

type MenuData = { reviewCount: number; projects: { items: MenuItem[]; more: boolean } };

/**
 * Reviews' badge and the menu's projects, from one read of the personal dashboard: on load, again on each arrival at Home
 * or Reviews (where the person acts on review items), and when a project is created, duplicated or changes
 * (PROJECTS_CHANGED). A failed read leaves the menu as it was.
 */
function useMenuData(hash: string): MenuData {
  const [data, setData] = useState<MenuData>({ reviewCount: 0, projects: { items: [], more: false } });
  const [changes, setChanges] = useState(0);
  const readFor = useRef(-1);
  const latest = useRef(0);
  useEffect(() => {
    const bump = () => setChanges((n) => n + 1);
    window.addEventListener(PROJECTS_CHANGED, bump);
    return () => window.removeEventListener(PROJECTS_CHANGED, bump);
  }, []);
  useEffect(() => {
    if (readFor.current === changes && hash !== '#/' && hash !== '#/reviews') return;
    readFor.current = changes;
    // Only the latest read is shown. A read is not dropped when the page changes meanwhile (a new project opens at once).
    const mine = ++latest.current;
    api.get<PersonalDashboard>(`/dashboard/me?${homeQuery(DEFAULT_PREFS.home, false)}`).then(
      (d) => mine === latest.current && setData({ reviewCount: reviewItems(d.needsYou).length, projects: menuProjects(d.projects) }),
      () => undefined,
    );
  }, [hash, changes]);
  return data;
}

/**
 * The signed-in frame of every page (spec 5.2, 6.1, 6.2): side menu, slim top bar, notices, the page and the footer.
 * Below 900 px the side menu is closed behind the Menu button; it closes again on Escape and when the page changes.
 */
export function AppShell({
  hash,
  branding,
  userName,
  access,
  prefs,
  prefsLoaded,
  prefsFailed,
  onPrefs,
  onSignOut,
  onSignOutEverywhere,
  children,
}: {
  hash: string;
  branding: Branding | null;
  userName: string;
  access: Omit<MenuContext, 'reviewCount'>;
  prefs: Prefs;
  prefsLoaded: boolean;
  prefsFailed: boolean;
  onPrefs: (next: Prefs) => Promise<void>;
  onSignOut: () => void;
  onSignOutEverywhere: () => void;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [customising, setCustomising] = useState(false);
  const customiseHeading = useRef<HTMLHeadingElement>(null);
  const menu = useMenuData(hash);
  const projectHrefs = menu.projects.items.flatMap((i) => (i.href ? [i.href] : []));
  const spend = useSpend(hash, access.isAdmin);
  const orgColour = branding?.colour ?? null;

  useEffect(() => setMenuOpen(false), [hash]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      document.getElementById('menu-toggle')?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  useEffect(() => {
    if (customising) customiseHeading.current?.focus();
  }, [customising]);

  return (
    <div className="shell">
      {/* The address is the page's route, so following "#main" would leave the page: move focus to the content instead. */}
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <TopBar
        hash={hash}
        branding={branding}
        menuId={MENU_ID}
        menuOpen={menuOpen}
        onMenu={() => setMenuOpen((o) => !o)}
        spend={<SpendMeter spend={spend} hash={hash} isAdmin={access.isAdmin} className="topbar-spend" />}
        person={
          <PersonMenu
            name={userName}
            hash={hash}
            onCustomise={() => setCustomising(true)}
            onSignOut={onSignOut}
            onSignOutEverywhere={onSignOutEverywhere}
            extra={<SpendMeter spend={spend} hash={hash} isAdmin={access.isAdmin} className="person-spend" />}
          />
        }
      />
      <SideMenu
        id={MENU_ID}
        groups={sideMenuGroups({ ...access, reviewCount: menu.reviewCount, projects: menu.projects })}
        current={currentMenuHref(hash, projectHrefs)}
        open={menuOpen}
      />
      <div className="shell-body">
        <OpsBanner hash={hash} isAdmin={access.isAdmin} />
        {customising && (
          <div className="page narrow">
            <Customise
              prefs={prefs}
              ready={prefsLoaded}
              failed={prefsFailed}
              onChange={onPrefs}
              orgColour={orgColour}
              show={['home', 'leadership']}
              headingRef={customiseHeading}
              onClose={() => {
                setCustomising(false);
                document.getElementById(PERSON_BUTTON_ID)?.focus();
              }}
            />
          </div>
        )}
        <div id="main" tabIndex={-1}>{children}</div>
        <footer className="foot">Times are shown in UTC+8.</footer>
      </div>
    </div>
  );
}
