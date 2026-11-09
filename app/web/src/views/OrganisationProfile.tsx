import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type LogoShape, type OrganisationProfile as Profile, SHAPE_HELP, logoUploadError } from '../branding.ts';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');

/** Loads the organisation's name and logos (Administrators only). */
export function useOrganisationProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.get<Profile>('/organisation').then(setProfile, (e) => setError(errText(e)));
  }, []);
  useEffect(load, [load]);
  return { profile, error, reload: load };
}

/** The organisation's name: saved during onboarding, renamed afterwards. */
export function OrganisationName({ current, onSaved }: { current: string | null; onSaved: () => void }) {
  const [name, setName] = useState(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setName(current ?? ''), [current]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.post('/organisation/name', { name });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <section className="panel" aria-labelledby="org-name-heading">
      <h2 id="org-name-heading">Organisation name</h2>
      <form className="row" onSubmit={save}>
        <label>
          Name <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="Example Organisation" />
        </label>
        <button className="primary">Save name</button>
      </form>
      {saved && <p role="status" className="meta">Name saved.</p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}

/** The wide and square logos: each optional, each previewed, replaced or removed on its own. */
export function LogoUploads({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);

  async function upload(shape: LogoShape, file: File | undefined) {
    setError(null);
    if (!file) return;
    const early = logoUploadError(file);
    if (early) return setError(early);
    try {
      await api.upload(`/organisation/logos/${shape}`, file);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  async function remove(shape: LogoShape) {
    setError(null);
    try {
      await api.post(`/organisation/logos/${shape}/remove`);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <section className="panel" aria-labelledby="logos-heading">
      <h2 id="logos-heading">Logos</h2>
      <p className="meta">Both are optional. Where one is missing, Kainow uses the other, or its own until you add one.</p>
      {(['wide', 'square'] as const).map((shape) => {
        const logo = profile.logos[shape];
        const label = shape === 'wide' ? 'Wide logo' : 'Square logo';
        return (
          <div key={shape} className="logo-upload">
            <p className="meta">{SHAPE_HELP[shape]}</p>
            {logo ? (
              <img
                className={`logo-preview logo-preview-${shape}`}
                src={api.url(`/organisation/logos/${shape}/preview?v=${encodeURIComponent(logo.uploadedAt)}`)}
                alt={`${label} as uploaded`}
              />
            ) : (
              <p className="meta">No {label.toLowerCase()} yet.</p>
            )}
            <label>
              {logo ? `Replace the ${label.toLowerCase()}` : `Add a ${label.toLowerCase()}`}{' '}
              <input type="file" accept="image/png,image/jpeg" onChange={(e) => void upload(shape, e.target.files?.[0])} />
            </label>
            {logo && (
              <button className="link-button" onClick={() => void remove(shape)}>
                Remove the {label.toLowerCase()}
              </button>
            )}
          </div>
        );
      })}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}

/** Administrator screen after setup: rename the organisation and change its logos. */
export function OrganisationScreen({ onBrandingChanged }: { onBrandingChanged: () => void }) {
  const { profile, error, reload } = useOrganisationProfile();
  const changed = () => {
    reload();
    onBrandingChanged();
  };
  return (
    <main className="page narrow">
      <h1>Organisation</h1>
      <p className="meta">The name and logos appear in the page header, on the sign-in page, in emails and on reports.</p>
      {error && <p role="alert" className="error">{error}</p>}
      {profile && (
        <>
          <OrganisationName current={profile.name} onSaved={changed} />
          <LogoUploads profile={profile} onChanged={changed} />
        </>
      )}
    </main>
  );
}
