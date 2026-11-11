// Pure helpers for the go-live checklist page and banner.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface GoLiveStep {
  key: string;
  position: number;
  text: string;
  explanation: string;
  link: string;
  mode: 'auto' | 'confirm' | 'auto_or_skip';
  done: boolean;
  tickedBy: { id: string; name: string } | 'kainow' | null;
  tickedAt: string | null;
  note: string | null;
  skipped: boolean;
  canTick: boolean;
  canUntick: boolean;
}

export interface GoLive {
  closedAt: string | null;
  steps: GoLiveStep[];
  notDoneAtClose: string[];
}

export interface GoLiveSummary {
  open: boolean;
  done: number;
  total: number;
}

export const CLOSING_RULE = 'The checklist closes by itself when a real department exists, real users are admitted and the first project is launched.';

/** A day such as "11 Nov 2026", in UTC+8. */
export function dayText(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 8 * 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const bannerText = (done: number, total: number): string => `Go-live: ${done} of ${total} steps done`;

export const closedText = (closedAt: string): string => `Closed on ${dayText(closedAt)}`;

export function stepState(s: Pick<GoLiveStep, 'done' | 'tickedBy' | 'tickedAt' | 'skipped'>): string {
  if (!s.done || !s.tickedAt) return 'Not done';
  const who = s.tickedBy === 'kainow' || s.tickedBy === null ? 'Kainow' : s.tickedBy.name;
  return `${s.skipped ? 'Skipped' : 'Done'} by ${who} on ${dayText(s.tickedAt)}`;
}

/** An app link starts with "#/"; anything else names an INSTALL.md section and is shown as text. */
export const linkKind = (link: string): 'page' | 'text' => (link.startsWith('#/') ? 'page' : 'text');

export function installText(link: string): string {
  const section = link.replace(/^INSTALL\.md,?\s*/, '').replace(/^the section on\s*/, '');
  return `See INSTALL.md: ${section || 'the install guide'}`;
}

/** Read only by screen readers after "Open the page for this step", so each step's link has its own name. */
export const stepLinkHidden = (position: number): string => ` (step ${position})`;

export const TEST_EMAIL_FIRST = 'Send a test email first, then check it arrived.';
export const CUSTODIAN_FIRST = 'Record the recovery custodian on the Organisation page first.';

/** What a Confirm step's disabled Mark done is waiting for; only the test-email and recovery steps ever wait. */
const WAITING_FOR: Record<string, string> = { test_email: TEST_EMAIL_FIRST, recovery: CUSTODIAN_FIRST };

/** Why a step's Mark done is shown disabled; null when the button is not waiting for anything. */
export function tickWaitText(s: Pick<GoLiveStep, 'key' | 'mode' | 'done' | 'canTick'>, closed: boolean): string | null {
  const text = WAITING_FOR[s.key];
  return text !== undefined && s.mode === 'confirm' && !s.done && !s.canTick && !closed ? text : null;
}
