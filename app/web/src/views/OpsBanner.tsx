import { useEffect, useState } from 'react';
import { RESTART_MESSAGE, api, isRestarting, onRestarting } from '../api.ts';
import { type BannerData, BANNER_EVERYONE, bannerLines } from '../operations.ts';

/**
 * Under the top bar on every page: protective read-only mode for everyone, and the backup or storage warning for an
 * Enterprise Administrator. It is a background read: when it fails it shows nothing, never an error.
 */
export function OpsBanner({ hash, isAdmin }: { hash: string; isAdmin: boolean }) {
  const [banner, setBanner] = useState<BannerData | null>(null);
  // Kainow stopped for an update (spec 7.2): api.ts retries /health every 15 s and reloads the page when it answers.
  const [restarting, setRestarting] = useState(isRestarting());
  useEffect(() => onRestarting(setRestarting), []);
  useEffect(() => {
    let live = true;
    const refresh = () => {
      api.get<BannerData>('/operations/banner').then(
        (b) => live && setBanner(b),
        () => undefined,
      );
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener('operations-changed', refresh);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('operations-changed', refresh);
    };
    // A new page (hash) reads it again, so a change is seen when moving about.
  }, [hash]);
  if (restarting) {
    return (
      <div className="ops-banner" role="status" aria-label="Notices about Kainow">
        <p>{RESTART_MESSAGE}</p>
      </div>
    );
  }
  if (!banner) return null;
  const lines = bannerLines(banner, isAdmin);
  if (lines.length === 0) return null;
  return (
    <div className="ops-banner" role="status" aria-label="Notices about Kainow">
      {lines.map((l) => (
        <p key={l}>
          {l === BANNER_EVERYONE ? <strong>Read-only. </strong> : null}
          {l}
          {isAdmin && l !== BANNER_EVERYONE && banner.admin ? <> <a href={banner.admin.link}>Open Operations</a></> : null}
        </p>
      ))}
    </div>
  );
}

/** The sign-in page's line while protective mode is on (the check is public; a failure shows nothing). */
export function ProtectiveLine() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let live = true;
    api.get<{ protective: boolean }>('/operations/public-state').then(
      (r) => live && setOn(r.protective),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return on ? <p role="status" className="ops-banner">{BANNER_EVERYONE}</p> : null;
}
