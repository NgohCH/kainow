import { useEffect, useState } from 'react';
import { api, type User } from '../api.ts';
import type { Branding } from '../branding.ts';
import { SignIn } from '../App.tsx';
import { type SetupKind, type SetupState, setupText } from '../setup.ts';

type SetupStatus = { state: SetupState; email: string | null; kind?: SetupKind };

/**
 * The page a setup or recovery link opens: sign in as the invited Administrator, or say why the link no longer works.
 * The wording follows the link's kind.
 */
export function Setup({ token, branding, onSignedIn }: { token: string; branding: Branding | null; onSignedIn: (u: User) => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  useEffect(() => {
    api.get<SetupStatus>(`/setup/${token}`).then(setStatus, () => setStatus({ state: 'expired', email: null }));
  }, [token]);

  if (!status) return <p className="loading">Loading</p>;
  const text = setupText(status.kind);
  if (status.state !== 'valid') {
    return (
      <main className="signin">
        <h1>{text.heading}</h1>
        <p role="alert">{text.message(status.state)}</p>
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
      intro={text.intro}
      onSignedIn={(u) => {
        window.location.hash = '#/';
        onSignedIn(u);
      }}
    />
  );
}
