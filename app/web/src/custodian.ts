// Pure helpers for the recovery custodian section of the Organisation page.

export interface RecoveryCustodian {
  name: string | null;
  contact: string | null;
}

export const CUSTODIAN_HELP =
  'The person who can restore Administrator access if every Administrator is locked out. See INSTALL.md: Recovery custodian.';

/** The same rule the server applies: both fields required once trimmed, each at most 200 characters. */
export function custodianError(name: string, contact: string): string | null {
  const n = name.trim();
  const c = contact.trim();
  if (n === '' || c === '') return "Give the custodian's name and how to reach them.";
  if (n.length > 200 || c.length > 200) return 'The name and the contact can each be at most 200 characters.';
  return null;
}
