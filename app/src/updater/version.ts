/** Release versions (10b spec 4): tags are `vMAJOR.MINOR.PATCH`, no pre-releases, no leading zeros. */
export type Version = { major: number; minor: number; patch: number };

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseTag(tag: string): Version | null {
  const m = TAG.exec(tag);
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return { major, minor, patch };
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

export const versionString = (v: Version): string => `${v.major}.${v.minor}.${v.patch}`;

/** True only when `candidate` (a tag) is strictly newer than `running` ('1.2.3' or 'v1.2.3'). 'unknown' is never older. */
export function isNewer(candidate: string, running: string): boolean {
  const c = parseTag(candidate);
  const r = parseTag(running.startsWith('v') ? running : `v${running}`);
  if (!c || !r) return false;
  return compareVersions(c, r) === 1;
}
