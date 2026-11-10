import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, setCsrfToken, type User } from './api.ts';
import type { Branding } from './branding.ts';
import { Invitation } from './views/Invitation.tsx';
import { Bell } from './views/Bell.tsx';
import { Letterhead, LogoImage } from './views/Letterhead.tsx';
import { NoteDetail } from './views/NoteDetail.tsx';
import { BeingSetUp, Onboarding } from './views/Onboarding.tsx';
import { ApprovalSettings } from './views/ApprovalSettings.tsx';
import { Departments, Domains } from './views/Organisation.tsx';
import { OrganisationScreen } from './views/OrganisationProfile.tsx';
import { Setup } from './views/Setup.tsx';
import { People } from './views/People.tsx';
import { ProjectPage } from './views/ProjectPage.tsx';
import { GoLive } from './views/GoLive.tsx';
import { useGoLiveSummary } from './views/goLiveSummary.ts';
import { Deliveries } from './views/Deliveries.tsx';
import { Notifications } from './views/Notifications.tsx';
import { NotificationsSettings } from './views/NotificationSettings.tsx';
import { Projects } from './views/Projects.tsx';
import { Review } from './views/Review.tsx';
import { HeaderSearch, isSearchHash, Search } from './views/Search.tsx';
import { Spending } from './views/Spending.tsx';

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash || '#/');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function go(path: string): void {
  window.location.hash = path;
}

interface Spend {
  configured: boolean;
  month: { limitMyr: string | null; usedMyr: string; remainingMyr: string } | null;
}

const myr = (v: string): string => `MYR ${Number(v).toFixed(2)}`;

function SpendMeter() {
  const [spend, setSpend] = useState<Spend | null>(null);
  useEffect(() => {
    api.get<Spend>('/ai/spend').then(setSpend, () => setSpend(null));
  }, []);
  if (!spend) return null;
  if (!spend.configured || !spend.month) return <span className="meter meter-warn">AI spending is not set up, so extraction is off</span>;
  const { limitMyr, usedMyr } = spend.month;
  return (
    <span className="meter" title="Counted from the start of the calendar month, UTC+8">
      AI spend this month {myr(usedMyr)} of {limitMyr === null ? 'no allowance' : myr(limitMyr)}
    </span>
  );
}

export function SignIn({
  onSignedIn,
  embedded = false,
  branding = null,
  initialEmail = '',
  intro,
}: {
  onSignedIn: (u: User) => void;
  embedded?: boolean;
  branding?: Branding | null;
  initialEmail?: string;
  intro?: string;
}) {
  // Inside another page (the invitation page) the form is a section with a level-two heading, not a second main landmark.
  const Wrapper = embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/request-code', { email });
      setStep('code');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ user: User; csrfToken: string | null }>('/auth/verify', { email, code: code.trim() });
      setCsrfToken(r.csrfToken);
      onSignedIn(r.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Wrapper className="signin" aria-label={embedded ? "Sign in" : undefined}>
      {branding && !embedded ? (
        <>
          <LogoImage branding={branding} place="signIn" />
          <Heading className="org-heading">{branding.name}</Heading>
          <p className="signin-to">Sign in to Kainow</p>
        </>
      ) : (
        <Heading className="wordmark">Kainow</Heading>
      )}
      <p className="lede">{intro ?? 'Turn meeting notes into decisions and actions you have checked against the page.'}</p>
      {step === 'email' ? (
        <form onSubmit={requestCode} className="stack">
          <label>
            Work email
            <input type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="primary" disabled={busy}>Email me a sign-in code</button>
        </form>
      ) : (
        <form onSubmit={verify} className="stack">
          <p>If {email} has an account, a 6-digit code is on its way. It works once and expires in 10 minutes.</p>
          <label>
            Sign-in code
            <input
              className="code"
              required
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <button className="primary" disabled={busy}>Sign in</button>
          <button type="button" className="quiet" onClick={() => { setStep('email'); setCode(''); setError(null); }}>
            Use a different email
          </button>
        </form>
      )}
    </Wrapper>
  );
}

export function App() {
  const hash = useHash();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [branding, setBranding] = useState<Branding | null>(null);

  // The organisation's name and logos (Kainow's own until setup is finished). Public, so the sign-in page has them.
  const loadBranding = useCallback(() => {
    api.get<Branding>('/organisation/branding').then(setBranding, () => setBranding(null));
  }, []);
  useEffect(loadBranding, [loadBranding]);

  // The browser tab shows the square logo (or Kainow's) and the organisation's name.
  useEffect(() => {
    if (!branding) return;
    document.title = branding.name === 'Kainow' ? 'Kainow' : `${branding.name} · Kainow`;
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) {
      icon = document.createElement('link');
      icon.rel = 'icon';
      document.head.appendChild(icon);
    }
    icon.href = api.url(branding.places.tab.url);
  }, [branding]);

  useEffect(() => {
    api.get<{ user: User; csrfToken: string | null }>('/auth/me').then(
      (r) => {
        setCsrfToken(r.csrfToken);
        setUser(r.user);
      },
      () => setUser(null),
    );
  }, []);

  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    go('#/');
  }, []);

  // Ends every session of this person, on every device (V1.0 sign-in rules §7).
  const signOutEverywhere = useCallback(async () => {
    await api.post('/auth/logout-all').catch(() => undefined);
    setUser(null);
    go('#/');
  }, []);

  const goLive = useGoLiveSummary(!!user && user.role === 'enterprise_administrator');

  if (user === undefined) return <p className="loading">Loading</p>;
  // An invitation link works before sign-in: it shows the invitation and then asks the person to sign in.
  const invitation = /^#\/invitations\/([A-Za-z0-9_-]{20,})$/.exec(hash);
  const setupLink = /^#\/setup\/([A-Za-z0-9_-]{20,})$/.exec(hash);
  if (user === null) {
    if (setupLink) return <Setup token={setupLink[1]} branding={branding} onSignedIn={setUser} />;
    if (invitation) return <Invitation token={invitation[1]} user={null} onSignedIn={setUser} />;
    return <SignIn onSignedIn={setUser} branding={branding} />;
  }

  const isAdmin = user.role === 'enterprise_administrator';
  // Until the organisation is set up, an Administrator sees only onboarding and anyone else a short notice.
  if (branding && !branding.registered) {
    if (!isAdmin) return <BeingSetUp onSignOut={signOut} />;
    return (
      <>
        <header className="bar">
          <Letterhead branding={branding} place="header" />
          <span className="who">
            {user.displayName}
            <button className="quiet" onClick={signOut}>Sign out</button>
          </span>
        </header>
        <div id="main">
          <Onboarding
            onFinished={() => {
              loadBranding();
              go('#/');
            }}
          />
        </div>
      </>
    );
  }
  const note = /^#\/notes\/([0-9a-f-]{36})(?:\/v\/(\d+))?$/i.exec(hash);
  const run = /^#\/runs\/([0-9a-f-]{36})$/i.exec(hash);
  const project = /^#\/projects\/([0-9a-f-]{36})(?:\/(people|notes|work|settings|closing|deadline-review)(?:\/([0-9a-f-]{36}))?)?$/i.exec(hash);
  const searching = isSearchHash(hash);
  const adminPage = /^#\/(people|spending|departments|domains|organisation|approvals|notifications-settings|deliveries|go-live)$/.exec(hash)?.[1];

  let page;
  if (invitation) page = <Invitation token={invitation[1]} user={user} onSignedIn={setUser} />;
  else if (isAdmin && adminPage === 'people') page = <People meId={user.id} />;
  else if (isAdmin && adminPage === 'spending') page = <Spending />;
  else if (isAdmin && adminPage === 'departments') page = <Departments />;
  else if (isAdmin && adminPage === 'domains') page = <Domains />;
  else if (isAdmin && adminPage === 'organisation') page = <OrganisationScreen onBrandingChanged={loadBranding} />;
  else if (isAdmin && adminPage === 'approvals') page = <ApprovalSettings />;
  else if (isAdmin && adminPage === 'notifications-settings') page = <NotificationsSettings />;
  else if (isAdmin && adminPage === 'deliveries') page = <Deliveries />;
  else if (isAdmin && adminPage === 'go-live') page = <GoLive />;
  else if (hash === '#/notifications') page = <Notifications />;
  else if (searching) page = <Search hash={hash} />;
  else if (run) page = <Review runId={run[1]} meId={user.id} />;
  else if (note) page = <NoteDetail sourceId={note[1]} versionNo={note[2] ? Number(note[2]) : null} />;
  else if (project) page = <ProjectPage key={project[1]} projectId={project[1]} meId={user.id} tab={(project[2] as 'people' | 'notes' | 'work' | 'settings' | 'closing' | 'deadline-review' | undefined) ?? 'overview'} itemId={project[3]} />;
  else page = <Projects isAdmin={isAdmin} />;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="bar">
        {branding && <Letterhead branding={branding} place="header" />}
        <a className="wordmark" href="#/">Kainow</a>
        <nav aria-label="Main" className="mainnav">
          <a href="#/" aria-current={!adminPage ? 'page' : undefined}>My Projects</a>
          {isAdmin && (
            <>
              <a href="#/people" aria-current={adminPage === 'people' ? 'page' : undefined}>Administrators</a>
              <a href="#/departments" aria-current={adminPage === 'departments' ? 'page' : undefined}>Departments</a>
              <a href="#/organisation" aria-current={adminPage === 'organisation' ? 'page' : undefined}>Organisation</a>
              <a href="#/approvals" aria-current={adminPage === 'approvals' ? 'page' : undefined}>Approvals</a>
              <a href="#/notifications-settings" aria-current={adminPage === 'notifications-settings' ? 'page' : undefined}>Notifications and email</a>
              <a href="#/deliveries" aria-current={adminPage === 'deliveries' ? 'page' : undefined}>Email delivery</a>
              {goLive && <a href="#/go-live" aria-current={adminPage === 'go-live' ? 'page' : undefined}>Go-live</a>}
              <a href="#/domains" aria-current={adminPage === 'domains' ? 'page' : undefined}>Domains</a>
              <a href="#/spending" aria-current={adminPage === 'spending' ? 'page' : undefined}>AI spending</a>
            </>
          )}
        </nav>
        <HeaderSearch hash={hash} />
        <Bell hash={hash} />
        <SpendMeter />
        <span className="who">
          {user.displayName}
          <button className="quiet" onClick={signOut}>Sign out</button>
          <button className="quiet" onClick={signOutEverywhere}>Sign out everywhere</button>
        </span>
      </header>
      <div id="main">
        {page}
      </div>
      <footer className="foot">Times are shown in UTC+8.</footer>
    </>
  );
}
