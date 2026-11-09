import type { Branding, Place } from '../branding.ts';
import { api } from '../api.ts';

/**
 * The organisation's logo for a place, drawn in that place's box without stretching. The name is always written
 * beside it, so the image itself is decorative (empty alt) and a screen reader hears the name once.
 */
export function LogoImage({ branding, place }: { branding: Branding; place: Place }) {
  const p = branding.places[place];
  return <img className={`logo logo-${place}`} src={api.url(p.url)} width={p.width} height={p.height} alt="" />;
}

/** Logo and organisation name, as at the top of a page. */
export function Letterhead({ branding, place }: { branding: Branding; place: Place }) {
  return (
    <span className={`letterhead letterhead-${place}`}>
      <LogoImage branding={branding} place={place} />
      <span className="org-name">{branding.name}</span>
    </span>
  );
}
