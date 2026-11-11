import { useState } from 'react';
import { ApiError, api } from '../api.ts';
import { Departments, Domains } from './Organisation.tsx';
import { LogoUploads, OrganisationName, useOrganisationProfile } from './OrganisationProfile.tsx';

/**
 * "Set up your organisation": the only screen an Enterprise Administrator sees until setup is finished.
 * Each section saves as it goes; Finish setup checks the name, a domain and a department, and opens Kainow.
 */
export function Onboarding({ onFinished }: { onFinished: () => void }) {
  const { profile, error: loadError, reload } = useOrganisationProfile();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish() {
    setError(null);
    setBusy(true);
    try {
      await api.post('/organisation/finish');
      onFinished();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow onboarding">
      <h1>Set up your organisation</h1>
      <p className="lede">
        Before anyone can use Kainow, give your organisation's name, the email domains people sign in with, and at least one department. Logos are
        optional. Until you finish, Kainow shows its own name and logo.
      </p>
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {profile && <OrganisationName current={profile.name} onSaved={reload} />}
      <Domains embedded />
      <Departments embedded />
      {profile && <LogoUploads profile={profile} onChanged={reload} />}
      <section className="panel" aria-labelledby="finish-heading">
        <h2 id="finish-heading">Finish setup</h2>
        <p className="meta">Your organisation's name and logos then replace Kainow's, and everything opens. You can change them later on the Organisation screen.</p>
        {error && <p role="alert" className="error">{error}</p>}
        <button className="primary" disabled={busy} onClick={() => void finish()}>
          Finish setup
        </button>
      </section>
    </main>
  );
}

/** Shown to anyone else signed in while the organisation is not set up (possible only on an upgraded installation). */
export function BeingSetUp({ onSignOut }: { onSignOut: () => void }) {
  return (
    <main className="page narrow">
      <h1>Kainow is being set up</h1>
      <p>Kainow is being set up. Try again later.</p>
      <button onClick={onSignOut}>Sign out</button>
    </main>
  );
}
