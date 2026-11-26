import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, api, setCsrfToken, type User } from './api.ts';
import { type Branding, memberOf } from './branding.ts';
import { Invitation } from './views/Invitation.tsx';
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
import { ProjectPage, RunInProject, type ProjectView } from './views/ProjectPage.tsx';
import { GoLive } from './views/GoLive.tsx';
import { Deliveries } from './views/Deliveries.tsx';
import { Notifications } from './views/Notifications.tsx';
import { NotificationsSettings } from './views/NotificationSettings.tsx';
import { Projects } from './views/Projects.tsx';
import { Home } from './views/Home.tsx';
import { MyTasks } from './views/MyTasks.tsx';
import { Reviews } from './views/Reviews.tsx';
import { isSearchHash, Search } from './views/Search.tsx';
import { AiAdmin } from './views/AiAdmin.tsx';
import { MyProfile } from './views/MyProfile.tsx';
import { MyAiUsage } from './views/AiUsage.tsx';
import { SummaryPage } from './views/SummaryView.tsx';
import { Thread } from './views/Thread.tsx';
import { answerIdFromHash } from './assist.ts';
import { parseThreadHash } from './discussion.ts';
import { Leadership } from './views/Leadership.tsx';
import { LeadershipGrants } from './views/LeadershipGrants.tsx';
import { AccessSettings } from './views/AccessSettings.tsx';
import { Analytics } from './views/Analytics.tsx';
import { StorageSettings } from './views/StorageSettings.tsx';
import { ReportTypes } from './views/ReportTypes.tsx';
import { Operations } from './views/Operations.tsx';
import { OpsBanner, ProtectiveLine } from './views/OpsBanner.tsx';
import { parseHistoryHash } from './ui/home.ts';
import { AppShell } from './ui/AppShell.tsx';
import { PROFILE_HREF } from './ui/menu.ts';
import { parseNoteHash, parseRunHash } from './proposalLinks.ts';
import { parseDuplicateHash } from './duplicate.ts';
import { leaveGuard } from './ui/leaveGuard.ts';
import { DuplicateProject } from './views/DuplicateProject.tsx';
import { parseProjectHash } from './ui/projectTabs.ts';
import { SettingsHub } from './views/SettingsHub.tsx';
import { Definitions } from './views/Definitions.tsx';
import { StageTemplates } from './views/StageTemplates.tsx';
import { ResourceAdmin } from './views/ResourceAdmin.tsx';
import { ResourceCatalogue } from './views/ResourceCatalogue.tsx';
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

  const form = (
    <Wrapper className={embedded ? 'signin box' : 'signin auth-card'} aria-label={embedded ? 'Sign in' : undefined}>
      {branding && !embedded ? (
        <>
          <LogoImage branding={branding} place="signIn" />
          <Heading className="org-heading">{branding.name}</Heading>
          <p className="signin-to">Sign in to Kainow</p>
        </>
      ) : (
        <Heading className={embedded ? 'box-title' : 'wordmark'}>{embedded ? 'Sign in to answer' : 'Kainow'}</Heading>
      )}
      <p className="lede">{intro ?? 'Turn meeting notes into decisions and actions you have checked against the page.'}</p>
      {!embedded && <ProtectiveLine />}
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
  return embedded ? form : <AuthFrame>{form}</AuthFrame>;
}

/**
 * The frame of the pages seen before sign-in (sign-in, the setup link, an invitation): no side menu, a band in the
 * installation's scheme colour (Red, or the organisation's colour) and the page in one box on it (spec 7.10).
 */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="auth-frame">
      <div className="auth-band" aria-hidden="true" />
      {children}
    </div>
  );
}

export function App() {
  const hash = useHash();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [brandingRead, setBrandingRead] = useState(false);

  // The organisation's name and logos (Kainow's own until setup is finished). Public, so the sign-in page has them.
  const loadBranding = useCallback(() => {
    api.get<Branding>('/organisation/branding').then(setBranding, () => setBranding(null)).finally(() => setBrandingRead(true));
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

  // Until the organisation is set up the server refuses everything below; it is read once setup is finished.
  const member = memberOf(user, brandingRead, branding);

  // Personal display preferences: loaded once signed in, saved at once on each change, and applied to <html>.
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [prefsFailed, setPrefsFailed] = useState(false);
  const saver = useRef(createPrefsSaver((next) => api.put<Prefs>('/me/preferences', next), setPrefs)).current;
  useEffect(() => {
    setPrefsLoaded(false);
    setPrefsFailed(false);
    if (!member) {
      saver.loaded(DEFAULT_PREFS);
      return;
    }
    let stale = false;
    api.get<Prefs>('/me/preferences').then(
      (p) => {
        if (stale) return;
        saver.loaded(p);
        setPrefsLoaded(true);
      },
      () => !stale && setPrefsFailed(true),
    );
    return () => {
      stale = true;
    };
  }, [member, saver]);
  useEffect(() => applyAppearance(prefs, branding?.colour ?? null), [prefs, branding]);
  const savePrefs = saver.save;

  // A designated security reviewer gets the Security review page; for anyone else the link stays hidden.
  const [reviewer, setReviewer] = useState(false);
  useEffect(() => {
    if (!member) return setReviewer(false);
    api.get<{ reviewer: boolean }>('/security/me').then((r) => setReviewer(r.reviewer), () => setReviewer(false));
  }, [member]);

  // "Leadership" shows only for someone holding an Active leadership grant.
  const [hasGrant, setHasGrant] = useState(false);
  useEffect(() => {
    if (!member) return setHasGrant(false);
    let stale = false;
    api.get<{ hasGrant: boolean }>('/leadership/me').then((r) => !stale && setHasGrant(r.hasGrant), () => !stale && setHasGrant(false));
    return () => {
      stale = true;
    };
  }, [member, hash === '#/leadership']);

  // "Resource catalogue" shows for the Administrator and for people the Administrator named as catalogue maintainers.
  const [maintainer, setMaintainer] = useState(false);
  useEffect(() => {
    if (!member) return setMaintainer(false);
    let stale = false;
    api.get<{ maintainer: boolean }>('/resources/catalogue/me').then((r) => !stale && setMaintainer(r.maintainer), () => !stale && setMaintainer(false));
    return () => {
      stale = true;
    };
  }, [member]);

  const signOut = useCallback(async () => {
    if (!leaveGuard.mayLeave()) return;
    await api.post('/auth/logout').catch(() => undefined);
    setUser(null);
    go('#/');
  }, []);

  // Ends every session of this person, on every device (V1.0 sign-in rules §7).
  const signOutEverywhere = useCallback(async () => {
    if (!leaveGuard.mayLeave()) return;
    await api.post('/auth/logout-all').catch(() => undefined);
    setUser(null);
    go('#/');
  }, []);

  if (user === undefined || (user !== null && !brandingRead)) return <p className="loading">Loading</p>;
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
        <header className="topbar onboarding-bar">
          <Letterhead branding={branding} place="header" />
          <span className="topbar-who">
            {user.displayName}
            <button className="quiet" onClick={signOut}>Sign out</button>
          </span>
        </header>
        <OpsBanner hash={hash} isAdmin settingUp />
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
  const note = parseNoteHash(hash);
  const run = parseRunHash(hash);
  const project = parseProjectHash(hash);
  const duplicating = parseDuplicateHash(hash);
  const deletedItem = /^#\/projects\/([0-9a-f-]{36})\/deleted\/([a-z]+)\/([0-9a-f-]{36})$/i.exec(hash);
  const quarantineCase = /^#\/quarantine\/cases\/([0-9a-f-]{36})(?:\/copies)?$/i.exec(hash);
  const securityPage = /^#\/security\/(cases|grants)$/.test(hash);
  const summary = /^#\/summaries\/([0-9a-f-]{36})$/i.exec(hash);
  const thread = parseThreadHash(hash);
  const searching = isSearchHash(hash);
  const adminPage = /^#\/(people|ai|departments|domains|organisation|approvals|notifications-settings|deliveries|go-live|escalated-feedback|leadership-grants|access-settings|storage|report-types|stage-templates|resources-admin|ai\/usage|admin\/analytics|admin\/analytics\/definitions|admin\/operations)$/.exec(hash)?.[1];

  let page;
  if (invitation) page = <Invitation token={invitation[1]} user={user} onSignedIn={setUser} />;
  else if (isAdmin && adminPage === 'people') page = <People meId={user.id} />;
  else if (isAdmin && adminPage === 'ai') page = <AiAdmin key="ai" />;
  else if (isAdmin && adminPage === 'ai/usage') page = <AiAdmin key="ai-usage" initialTab="usage" />;
  else if (isAdmin && adminPage === 'departments') page = <Departments />;
  else if (isAdmin && adminPage === 'domains') page = <Domains />;
  else if (isAdmin && adminPage === 'organisation') page = <OrganisationScreen onBrandingChanged={loadBranding} meId={user.id} />;
  else if (isAdmin && adminPage === 'approvals') page = <ApprovalSettings />;
  else if (isAdmin && adminPage === 'notifications-settings') page = <NotificationsSettings />;
  else if (isAdmin && adminPage === 'deliveries') page = <Deliveries />;
  else if (isAdmin && adminPage === 'go-live') page = <GoLive />;
  else if (isAdmin && adminPage === 'escalated-feedback') page = <EscalatedFeedback />;
  else if (isAdmin && adminPage === 'leadership-grants') page = <LeadershipGrants meId={user.id} />;
  else if (isAdmin && adminPage === 'access-settings') page = <AccessSettings />;
  else if (isAdmin && adminPage === 'storage') page = <StorageSettings />;
  else if (isAdmin && adminPage === 'report-types') page = <ReportTypes />;
  else if (isAdmin && adminPage === 'stage-templates') page = <StageTemplates />;
  else if (isAdmin && adminPage === 'resources-admin') page = <ResourceAdmin />;
  else if (hash === '#/resource-catalogue' && (maintainer || isAdmin)) page = <ResourceCatalogue />;
  else if (isAdmin && adminPage === 'admin/analytics') page = <Analytics />;
  else if (isAdmin && adminPage === 'admin/analytics/definitions') page = <Definitions />;
  else if (isAdmin && adminPage === 'admin/operations') page = <Operations />;
  else if (isAdmin && hash === '#/settings') page = <SettingsHub reviewer={reviewer} />;
  else if (hash === '#/leadership' && hasGrant) page = <Leadership prefs={prefs} ready={prefsLoaded} failed={prefsFailed} onChange={savePrefs} />;
  else if (quarantineCase) page = <CasePage key={quarantineCase[1]} caseId={quarantineCase[1]} />;
  else if (securityPage) page = <SecurityReviewPage />;
  else if (hash === '#/notifications') page = <Notifications />;
  else if (hash === '#/my-ai-usage') page = <MyAiUsage />;
  else if (hash === PROFILE_HREF) page = <MyProfile prefs={prefs} ready={prefsLoaded} failed={prefsFailed} onPrefs={savePrefs} orgColour={branding?.colour ?? null} />;
  else if (searching) page = <Search hash={hash} />;
  else if (summary) page = <SummaryPage key={summary[1]} summaryId={summary[1]} />;
  else if (thread) page = <Thread key={thread.threadId} projectId={thread.projectId} threadId={thread.threadId} meId={user.id} messageNo={thread.messageNo} answerId={answerIdFromHash(hash)} />;
  else if (deletedItem) page = <DeletedItemPage key={deletedItem[3]} projectId={deletedItem[1]} kind={deletedItem[2]} itemId={deletedItem[3]} />;
  else if (run) page = <RunInProject key={run.runId} runId={run.runId} itemId={run.itemId} meId={user.id} prefs={prefs} prefsReady={prefsLoaded} prefsFailed={prefsFailed} onPrefs={savePrefs} />;
  else if (note) page = <NoteDetail sourceId={note.sourceId} versionNo={note.versionNo} place={note.place} />;
  else if (duplicating) page = <DuplicateProject key={duplicating} projectId={duplicating} meId={user.id} />;
  else if (project) page = <ProjectPage key={project.projectId} projectId={project.projectId} meId={user.id} tab={project.tab as ProjectView} itemId={project.itemId} prefs={prefs} prefsReady={prefsLoaded} prefsFailed={prefsFailed} onPrefs={savePrefs} />;
  else if (hash === '#/projects' || parseHistoryHash(hash)) page = <Projects isAdmin={isAdmin} history={parseHistoryHash(hash)} />;
  else if (hash === '#/my-tasks') page = <MyTasks meId={user.id} meName={user.displayName} prefs={prefs} ready={prefsLoaded} failed={prefsFailed} onPrefs={savePrefs} />;
  else if (hash === '#/reviews') page = <Reviews />;
  else page = <Home userName={user.displayName} prefs={prefs} ready={prefsLoaded} failed={prefsFailed} onChange={savePrefs} />;

  return (
    <AppShell
      hash={hash}
      branding={branding}
      userName={user.displayName}
      access={{ isAdmin, hasGrant, maintainer, reviewer }}
      prefs={prefs}
      prefsLoaded={prefsLoaded}
      prefsFailed={prefsFailed}
      onPrefs={savePrefs}
      onSignOut={signOut}
      onSignOutEverywhere={signOutEverywhere}
    >
      {page}
    </AppShell>
  );
}
