/** What the server says to show: the organisation's name and, for each place, its logo (Kainow's until setup is finished). */
export type Place = 'header' | 'tab' | 'signIn' | 'email' | 'report';
export type LogoShape = 'wide' | 'square';
export type PlaceBranding = { url: string; width: number; height: number; isDefault: boolean };
export type Branding = { registered: boolean; name: string; places: Record<Place, PlaceBranding> };

export type LogoMeta = { width: number; height: number; byteSize: number; uploadedAt: string };
export type OrganisationProfile = { registered: boolean; name: string | null; logos: Record<LogoShape, LogoMeta | null> };

export const MAX_LOGO_BYTES = 512 * 1024;

/** An early check of a chosen logo file, so the person hears at once; the server checks it again, properly. */
export function logoUploadError(file: { type: string; size: number }): string | null {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') return 'Use a PNG or JPEG file.';
  if (file.size > MAX_LOGO_BYTES) return 'A logo can be at most 512 KB.';
  return null;
}

export const SHAPE_HELP: Record<LogoShape, string> = {
  wide: 'Wide logo: PNG or JPEG, 2 to 6 times as wide as it is high, at least 40 pixels high, up to 512 KB. Used on the sign-in page, emails and reports.',
  square: 'Square logo: PNG or JPEG, square, at least 64 × 64 pixels, up to 512 KB. Used in the page header and the browser tab.',
};
