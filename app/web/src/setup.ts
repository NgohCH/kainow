/** What the page a setup or recovery link opens says (pure, so it can be tested). */
export type SetupKind = 'setup' | 'recovery';
export type SetupState = 'valid' | 'used' | 'expired' | 'superseded';

const USED = 'This setup link has been used. Sign in instead.';
const SETUP_ENDED = 'This setup link is no longer valid. Ask whoever installed Kainow to run the setup command again.';
const RECOVERY_ENDED = 'This link has expired. Ask your recovery custodian to run recover-admin again.';

export function setupText(kind: SetupKind | undefined): { heading: string; intro: string; message: (state: Exclude<SetupState, 'valid'>) => string } {
  if (kind === 'recovery') {
    return {
      heading: 'Restore Administrator access',
      intro: 'You are restoring Administrator access to Kainow. Sign in with the code Kainow emails you.',
      message: (state) => (state === 'used' ? USED : RECOVERY_ENDED),
    };
  }
  return {
    heading: 'Set up Kainow',
    intro:
      'You are setting up Kainow as its first Enterprise Administrator. Sign in with the code Kainow emails you; you will then set up your organisation.',
    message: (state) => (state === 'used' ? USED : SETUP_ENDED),
  };
}
