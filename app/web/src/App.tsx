import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, setCsrfToken, type User } from './api.ts';
import type { Branding } from './branding.ts';
import { Invitation } from './views/Invitation.tsx';
import { Bell } from './views/Bell.tsx';
import { Letterhead, LogoImage } from './views/Letterhead.tsx';
import { DeletedItemPage } from './views/DeletedItems.tsx';
import { NoteDetail } from './views/NoteDetail.tsx';
import { BeingSetUp, Onboarding } from './views/Onboarding.tsx';
import { ApprovalSettings } from './views/ApprovalSettings.tsx';
import { EscalatedFeedback } from './views/EscalatedFeedback.tsx';
import { Departments, Domains } from './views/Organisation.tsx';
import { OrganisationScreen } from './views/OrganisationProfile.tsx';
import { CasePage } from './views/HeldReview.tsx';
import { SecurityReviewPage } from './views/SecurityReview.tsx';
import { Setup } from './views/Setup.tsx';
import { People } from './views/People.tsx';
import { ProjectPage } from './views/ProjectPage.tsx';
import { GoLive } from './views/GoLive.tsx';
import { Deliveries } from './views/Deliveries.tsx';
import { Notifications } from './views/Notifications.tsx';
import { NotificationsSettings } from './views/NotificationSettings.tsx';
import { Projects } from './views/Projects.tsx';
import { Review } from './views/Review.tsx';
import { HeaderSearch, isSearchHash, Search } from './views/Search.tsx';
import { AiAdmin } from './views/AiAdmin.tsx';
import { MyAiUsage } from './views/AiUsage.tsx';
import { SummaryPage } from './views/SummaryView.tsx';
import { Thread } from './views/Thread.tsx';
import { type Meter, formatMyr, meterText, projectIdFromHash, usableMeter } from './ai.ts';
import { answerIdFromHash } from './assist.ts';
import { parseThreadHash } from './discussion.ts';
import { Customise } from './views/Customise.tsx';
import { DEFAULT_PREFS, applyAppearance, createPrefsSaver, type Prefs } from './prefs.ts';

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
  month?: { limitMyr: string | null; usedMyr: string; remainingMyr: string } | null;
  /** With a project: the project's monthly figures for those who manage its AI use, otherwise the person's own remaining allowance. Null when no personal limit applies. */
  meter?: Meter | null;
}

/**
 * Inside a project the meter is the viewer's own remaining allowance there, or the project's monthly remaining for those who
 * manage its AI use. Outside a project only the Administrator has one: the organisation's month.
 */
function SpendMeter({ hash, isAdmin }: { hash: string; isAdmin: boolean }) {
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
  if (!spend) return null;
  if (projectId && usableMeter(spend.meter)) {
    return <a className="meter" href="#/my-ai-usage" title="Counted from the start of the calendar month, UTC+8">{meterText(spend.meter)}</a>;
  }
  if (!isAdmin) return null;
  if (!spend.configured || !spend.month) return <span className="meter meter-warn">AI spending is not set up, so extraction is off</span>;
  const { limitMyr, usedMyr } = spend.month;
  return (
    <span className="meter" title="Counted from the start of the calendar month, UTC+8">
      AI spend this month {formatMyr(usedMyr)} of {limitMyr === null ? 'no allowance' : formatMyr(limitMyr)}
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

  // Personal display preferences: loaded once signed in, saved at once on each change, and applied to <html>.
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [customising, setCustomising] = useState(false);
  const saver = useRef(createPrefsSaver((next) => api.put<Prefs>('/me/preferences', next), setPrefs)).current;
  useEffect(() => {
    setPrefsLoaded(false);
    if (!user) {
      saver.loaded(DEFAULT_PREFS);
      setCustomising(false);
      return;
    }
    let stale = false;
    api.get<Prefs>('/me/preferences').then(
      (p) => {
        if (stale) return;
        saver.loaded(p);
        setPrefsLoaded(true);
      },
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [user, saver]);
  useEffect(() => applyAppearance(prefs), [prefs]);
  const savePrefs = saver.save;

  // A designated security reviewer gets the Security review page; anyone else is refused, so the link stays hidden.
  const [reviewer, setReviewer] = useState(false);
  useEffect(() => {
    if (!user) return setReviewer(false);
    api.get('/security/cases').then(() => setReviewer(true), () => setReviewer(false));
  }, [user]);

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
  const project = /^#\/projects\/([0-9a-f-]{36})(?:\/(people|notes|work|drafts|review|settings|ai|feedback|closing|deadline-review|deleted)(?:\/([0-9a-f-]{36}))?)?$/i.exec(hash);
  const deletedItem = /^#\/projects\/([0-9a-f-]{36})\/deleted\/([a-z]+)\/([0-9a-f-]{36})$/i.exec(hash);
  const quarantineCase = /^#\/quarantine\/cases\/([0-9a-f-]{36})(?:\/copies)?$/i.exec(hash);
  const securityPage = /^#\/security\/(cases|grants)$/.test(hash);
  const summary = /^#\/summaries\/([0-9a-f-]{36})$/i.exec(hash);
  const thread = parseThreadHash(hash);
  const searching = isSearchHash(hash);
  const adminPage = /^#\/(people|ai|departments|domains|organisation|approvals|notifications-settings|deliveries|go-live|escalated-feedback)$/.exec(hash)?.[1];

  let page;
  if (invitation) page = <Invitation token={invitation[1]} user={user} onSignedIn={setUser} />;
  else if (isAdmin && adminPage === 'people') page = <People meId={user.id} />;
  else if (isAdmin && adminPage === 'ai') page = <AiAdmin />;
  else if (isAdmin && adminPage === 'departments') page = <Departments />;
  else if (isAdmin && adminPage === 'domains') page = <Domains />;
  else if (isAdmin && adminPage === 'organisation') page = <OrganisationScreen onBrandingChanged={loadBranding} meId={user.id} />;
  else if (isAdmin && adminPage === 'approvals') page = <ApprovalSettings />;
  else if (isAdmin && adminPage === 'notifications-settings') page = <NotificationsSettings />;
  else if (isAdmin && adminPage === 'deliveries') page = <Deliveries />;
  else if (isAdmin && adminPage === 'go-live') page = <GoLive />;
  else if (isAdmin && adminPage === 'escalated-feedback') page = <EscalatedFeedback />;
  else if (quarantineCase) page = <CasePage key={quarantineCase[1]} caseId={quarantineCase[1]} />;
  else if (securityPage) page = <SecurityReviewPage />;
  else if (hash === '#/notifications') page = <Notifications />;
  else if (hash === '#/my-ai-usage') page = <MyAiUsage />;
  else if (searching) page = <Search hash={hash} />;
  else if (summary) page = <SummaryPage key={summary[1]} summaryId={summary[1]} />;
  else if (thread) page = <Thread key={thread.threadId} projectId={thread.projectId} threadId={thread.threadId} meId={user.id} messageNo={thread.messageNo} answerId={answerIdFromHash(hash)} />;
  else if (deletedItem) page = <DeletedItemPage key={deletedItem[3]} projectId={deletedItem[1]} kind={deletedItem[2]} itemId={deletedItem[3]} />;
  else if (run) page = <Review runId={run[1]} meId={user.id} />;
  else if (note) page = <NoteDetail sourceId={note[1]} versionNo={note[2] ? Number(note[2]) : null} />;
  else if (project) page = <ProjectPage key={project[1]} projectId={project[1]} meId={user.id} tab={(project[2] as 'people' | 'notes' | 'work' | 'drafts' | 'review' | 'settings' | 'ai' | 'feedback' | 'closing' | 'deadline-review' | 'deleted' | undefined) ?? 'overview'} itemId={project[3]} />;
  else page = <Projects isAdmin={isAdmin} />;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="bar">
        {branding && <Letterhead branding={branding} place="header" />}
        <a className="wordmark" href="#/">Kainow</a>
        <nav aria-label="Main" className="mainnav">
          <a href="#/" aria-current={!adminPage && !securityPage && hash !== '#/my-ai-usage' ? 'page' : undefined}>My Projects</a>
          <a href="#/my-ai-usage" aria-current={hash === '#/my-ai-usage' ? 'page' : undefined}>My AI use</a>
          {reviewer && <a href="#/security/cases" aria-current={securityPage ? 'page' : undefined}>Security review</a>}
          {isAdmin && (
            <>
              <a href="#/people" aria-current={adminPage === 'people' ? 'page' : undefined}>Administrators</a>
              <a href="#/departments" aria-current={adminPage === 'departments' ? 'page' : undefined}>Departments</a>
              <a href="#/organisation" aria-current={adminPage === 'organisation' ? 'page' : undefined}>Organisation</a>
              <a href="#/approvals" aria-current={adminPage === 'approvals' ? 'page' : undefined}>Approvals</a>
              <a href="#/notifications-settings" aria-current={adminPage === 'notifications-settings' ? 'page' : undefined}>Notifications and email</a>
              <a href="#/deliveries" aria-current={adminPage === 'deliveries' ? 'page' : undefined}>Email delivery</a>
              {/* Always there for Administrators: after closing, the page is the read-only record. */}
              <a href="#/go-live" aria-current={adminPage === 'go-live' ? 'page' : undefined}>Go-live</a>
              <a href="#/domains" aria-current={adminPage === 'domains' ? 'page' : undefined}>Domains</a>
              <a href="#/escalated-feedback" aria-current={adminPage === 'escalated-feedback' ? 'page' : undefined}>Escalated feedback</a>
              <a href="#/ai" aria-current={adminPage === 'ai' ? 'page' : undefined}>AI</a>
            </>
          )}
        </nav>
        <HeaderSearch hash={hash} />
        <Bell hash={hash} />
        <SpendMeter hash={hash} isAdmin={isAdmin} />
        <span className="who">
          {user.displayName}
          <button className="quiet" aria-expanded={customising} onClick={() => setCustomising((c) => !c)}>Customise</button>
          <button className="quiet" onClick={signOut}>Sign out</button>
          <button className="quiet" onClick={signOutEverywhere}>Sign out everywhere</button>
        </span>
      </header>
      {customising && (
        <div className="page narrow">
          <Customise prefs={prefs} ready={prefsLoaded} onChange={savePrefs} onClose={() => setCustomising(false)} />
        </div>
      )}
      <div id="main">
        {page}
      </div>
      <footer className="foot">Times are shown in UTC+8.</footer>
    </>
  );
}
