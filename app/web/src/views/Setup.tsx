import { useEffect, useState } from 'react';
import { api, type User } from '../api.ts';
import type { Branding } from '../branding.ts';
import { SignIn } from '../App.tsx';

type SetupStatus = { state: 'valid' | 'used' | 'expired' | 'superseded'; email: string | null };

const MESSAGE: Record<Exclude<SetupStatus['state'], 'valid'>, string> = {
  used: 'This setup link has been used. Sign in instead.',
  expired: 'This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.',
  superseded: 'This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.',
};

/** The page a setup link opens: sign in as the invited first Administrator, or say why the link no longer works. */
export function Setup({ token, branding, onSignedIn }: { token: string; branding: Branding | null; onSignedIn: (u: User) => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    api.get<SetupStatus>(`/setup/${token}`).then(setStatus, () => setStatus({ state: 'expired', email: null }));
  }, [token]);

  if (!status) return <p className="loading">Loading</p>;
  if (status.state !== 'valid') {
    return (
      <main className="signin">
        <h1>Set up Kainow</h1>
        <p role="alert">{MESSAGE[status.state]}</p>
        <p>
          <a href="#/">Go to sign-in</a>
        </p>
      </main>
    );
  }
  return (
    <SignIn
      branding={branding}
      initialEmail={status.email ?? ''}
      intro="You are setting up Kainow as its first Enterprise Administrator. Sign in with the code Kainow emails you; you will then set up your organisation."
      onSignedIn={(u) => {
        window.location.hash = '#/';
        onSignedIn(u);
      }}
    />
  );
}
