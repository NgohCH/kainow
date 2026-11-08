import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api, setCsrfToken, type User } from './api.ts';
import { Invitation } from './views/Invitation.tsx';
import { NoteDetail } from './views/NoteDetail.tsx';
import { Departments, Domains } from './views/Organisation.tsx';
import { People } from './views/People.tsx';
import { ProjectPage } from './views/ProjectPage.tsx';
import { Projects } from './views/Projects.tsx';
import { Review } from './views/Review.tsx';
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

export function SignIn({ onSignedIn, embedded = false }: { onSignedIn: (u: User) => void; embedded?: boolean }) {
  // Inside another page (the invitation page) the form is a section with a level-two heading, not a second main landmark.
  const Wrapper = embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
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
      <Heading className="wordmark">Kainow</Heading>
      <p className="lede">Turn meeting notes into decisions and actions you have checked against the page.</p>
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

  if (user === undefined) return <p className="loading">Loading</p>;
  // An invitation link works before sign-in: it shows the invitation and then asks the person to sign in.
  const invitation = /^#\/invitations\/([A-Za-z0-9_-]{20,})$/.exec(hash);
  if (user === null) return invitation ? <Invitation token={invitation[1]} user={null} onSignedIn={setUser} /> : <SignIn onSignedIn={setUser} />;

  const isAdmin = user.role === 'enterprise_administrator';
  const note = /^#\/notes\/([0-9a-f-]{36})(?:\/v\/(\d+))?$/i.exec(hash);
  const run = /^#\/runs\/([0-9a-f-]{36})$/i.exec(hash);
  const project = /^#\/projects\/([0-9a-f-]{36})(?:\/(people|notes))?$/i.exec(hash);
  const adminPage = /^#\/(people|spending|departments|domains)$/.exec(hash)?.[1];

  let page;
  if (invitation) page = <Invitation token={invitation[1]} user={user} onSignedIn={setUser} />;
  else if (isAdmin && adminPage === 'people') page = <People meId={user.id} />;
  else if (isAdmin && adminPage === 'spending') page = <Spending />;
  else if (isAdmin && adminPage === 'departments') page = <Departments />;
  else if (isAdmin && adminPage === 'domains') page = <Domains />;
  else if (run) page = <Review runId={run[1]} />;
  else if (note) page = <NoteDetail sourceId={note[1]} versionNo={note[2] ? Number(note[2]) : null} />;
  else if (project) page = <ProjectPage key={project[1]} projectId={project[1]} tab={(project[2] as 'people' | 'notes' | undefined) ?? 'overview'} />;
  else page = <Projects isAdmin={isAdmin} />;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="bar">
        <a className="wordmark" href="#/">Kainow</a>
        <nav aria-label="Main" className="mainnav">
          <a href="#/" aria-current={!adminPage ? 'page' : undefined}>My Projects</a>
          {isAdmin && (
            <>
              <a href="#/people" aria-current={adminPage === 'people' ? 'page' : undefined}>Administrators</a>
              <a href="#/departments" aria-current={adminPage === 'departments' ? 'page' : undefined}>Departments</a>
              <a href="#/domains" aria-current={adminPage === 'domains' ? 'page' : undefined}>Domains</a>
              <a href="#/spending" aria-current={adminPage === 'spending' ? 'page' : undefined}>AI spending</a>
            </>
          )}
        </nav>
        <SpendMeter />
        <span className="who">
          {user.displayName}
          <button className="quiet" onClick={signOut}>Sign out</button>
        </span>
      </header>
      <div id="main">
        {page}
      </div>
      <footer className="foot">Times are shown in UTC+8.</footer>
    </>
  );
}
