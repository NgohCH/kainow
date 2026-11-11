import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { type LogoShape, type OrganisationProfile as Profile, SHAPE_HELP, logoUploadError, previewPlaces } from '../branding.ts';
import { CUSTODIAN_HELP, type RecoveryCustodian as Custodian, custodianError } from '../custodian.ts';

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
              <ul className="logo-previews" aria-label={`${label} as it will appear`}>
                {previewPlaces(shape).map((place) => (
                  <li key={place.label}>
                    <span className="preview-box" style={{ width: place.width, height: place.height }}>
                      <img
                        src={api.url(`/organisation/logos/${shape}/preview?v=${encodeURIComponent(logo.uploadedAt)}`)}
                        width={place.width}
                        height={place.height}
                        alt={`${label} in the ${place.label.toLowerCase()}`}
                      />
                    </span>
                    <span className="meta">{place.label}</span>
                  </li>
                ))}
              </ul>
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

/** The recovery custodian (O07): shown, and recorded or changed, by an Administrator. */
export function RecoveryCustodian() {
  const [current, setCurrent] = useState<Custodian | null>(null);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<Custodian>('/organisation/recovery-custodian').then(
      (c) => {
        setCurrent(c);
        setName(c.name ?? '');
        setContact(c.contact ?? '');
      },
      (e) => setError(errText(e)),
    );
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const early = custodianError(name, contact);
    if (early) return setError(early);
    setError(null);
    setBusy(true);
    try {
      const next = await api.put<Custodian>('/organisation/recovery-custodian', { name, contact });
      setCurrent(next);
      setName(next.name ?? '');
      setContact(next.contact ?? '');
      setSaved(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-labelledby="custodian-heading">
      <h2 id="custodian-heading">Recovery custodian</h2>
      <p className="meta">{CUSTODIAN_HELP}</p>
      {current && (
        <p>
          {current.name && current.contact ? (
            <>Recorded: <strong>{current.name}</strong>, {current.contact}</>
          ) : (
            'No recovery custodian recorded yet.'
          )}
        </p>
      )}
      <form className="stack" onSubmit={save}>
        <label>
          Name <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          How to reach them <input required maxLength={200} value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <button className="primary" disabled={busy || !current}>Save custodian</button>
      </form>
      {saved && <p role="status" className="meta">Recovery custodian saved.</p>}
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
          <RecoveryCustodian />
        </>
      )}
    </main>
  );
}
