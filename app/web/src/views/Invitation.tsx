import { useEffect, useState } from 'react';
import { ApiError, api, type User } from '../api.ts';
import { AuthFrame, SignIn, go } from '../App.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { Box } from '../ui/Box.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { type ProjectRole, formatExpiry, roleLabel } from '../projects.ts';

interface Shown {
  projectName: string;
  email: string;
  role: ProjectRole;
  startsOn: string;
  expiresOn: string | null;
  expiresAt: string;
  status: string;
  kind?: 'role' | 'handover';
}

/** The page an invitation link opens. Works before sign-in: it shows the invitation, then asks the person to sign in. */
export function Invitation({ token, user, onSignedIn }: { token: string; user: User | null; onSignedIn: (u: User) => void }) {
  const [inv, setInv] = useState<Shown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ invitation: Shown }>(`/invitations/by-token/${token}`).then(
      (r) => setInv(r.invitation),
      (e) => setError(e instanceof ApiError ? e.message : 'This invitation link is no longer valid.'),
    );
  }, [token]);

  async function answer(kind: 'accept' | 'decline') {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ membership?: { projectId: string; state: string } }>(`/invitations/by-token/${token}/${kind}`);
      if (kind === 'accept' && r.membership) {
        if (r.membership.state === 'active') go(`#/projects/${r.membership.projectId}`);
        else setDone(`Accepted. Your role starts on ${inv?.startsOn}; the project will appear then.`);
      } else {
        setDone('Declined. The person who invited you can reassign the role.');
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !inv) {
    const body = (
      <>
        <h1>Invitation</h1>
        <p role="alert" className="error">{error}</p>
        <a href="#/">Go to Kainow</a>
      </>
    );
    return user ? <main className="page narrow">{body}</main> : <AuthFrame><main className="auth-card">{body}</main></AuthFrame>;
  }
  if (!inv) return <p className="loading">Loading</p>;

  const open = inv.status === 'invited';
  const summary = (
    <p>
      {inv.kind === 'handover' ? (
        <>
          You are asked to take over as Project Manager of <strong>{inv.projectName}</strong>, from the day you accept.
        </>
      ) : (
        <>
          You are invited to <strong>{inv.projectName}</strong> as <strong>{roleLabel(inv.role)}</strong>, from {inv.startsOn}
          {inv.expiresOn ? ` to ${inv.expiresOn}` : ''}.
        </>
      )}{' '}
      The invitation was sent to {inv.email}. {open ? `${formatExpiry(inv.expiresAt)}.` : ''}
    </p>
  );

  const closed = (
    <p>
      <StatusLabel meaning="off" word="Closed" /> This invitation can no longer be answered ({inv.status}).
    </p>
  );

  if (!user) {
    return (
      <AuthFrame>
        <main className="auth-card wide">
          <h1>Invitation</h1>
          {summary}
          {open ? <p>Sign in with {inv.email} to answer it.</p> : closed}
          {open && <SignIn onSignedIn={onSignedIn} embedded />}
        </main>
      </AuthFrame>
    );
  }

  return (
    <main className="page narrow">
      <PageHeader title="Invitation" />
      <Box meaning={done ? undefined : open ? 'review' : 'off'}>
        {!done && open && <p><StatusLabel meaning="review" word="Waiting for your answer" /></p>}
        {summary}
        {done ? (
          <p role="status">{done}</p>
        ) : open ? (
          <>
            {error && <p role="alert" className="error">{error}</p>}
            <div className="decision">
              <button className="primary" disabled={busy} onClick={() => void answer('accept')}>Accept</button>
              <button disabled={busy} onClick={() => void answer('decline')}>Decline</button>
            </div>
          </>
        ) : (
          closed
        )}
      </Box>
    </main>
  );
}
