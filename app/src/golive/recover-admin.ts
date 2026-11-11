import type { Pool } from 'pg';
import { normaliseEmail } from '../auth/auth.service';
import type { CodeSender } from '../auth/tokens';
import type { AppConfig } from '../config';
import type { EmailNudge } from '../email/nudge';
import { type DisabledAdministrator, SetupService, cleanDisplayName } from '../organisation/setup.service';

/** The exact words of every answer the recovery command gives. */
export const RECOVERY = {
  noReason: 'Give a reason with --reason "<why>".',
  notSetUp: 'Kainow is not set up yet; use golive-init or setup-invite instead.',
  adminActive:
    'An Administrator is still active; recovery is only for when none is. If no Administrator can sign in, add --disable-active-administrators to disable them first.',
  notEligible: 'That email is not on an eligible domain.',
  recipientBeingDisabled: 'The recovery link cannot go to an Administrator who is being disabled.',
  nameRequired: 'A display name of 1 to 200 characters is required for a new person.',
  dryRunActive: 'Would be refused now: an Administrator is active. All other checks passed.',
  notRestored: 'When they sign in with it, they become an Enterprise Administrator. Their project roles are not restored.',
  // The cause is not printed: a mail server's answer can carry account details.
  emailFailed:
    'The recovery link was recorded, but the email could not be sent: the email service did not accept it. Run the same command again to send a new link.',
  usage: 'Usage: npm run recover-admin -- <email> "<name>" --reason "<why>" [--disable-active-administrators] [--dry-run]',
} as const;

const utc = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');
const named = (admins: Array<Pick<DisabledAdministrator, 'displayName' | 'email'>>): string =>
  admins.map((a) => `${a.displayName} ${a.email}`).join(', ');

export interface RecoverOptions {
  email: string;
  displayName?: string;
  reason?: string;
  dryRun: boolean;
  /** --disable-active-administrators: disable every still-Active Enterprise Administrator first. */
  disableActive?: boolean;
}

/** Reads `<email> "<name>" --reason "<why>" [--disable-active-administrators] [--dry-run]`, flags in any position. */
export function parseRecoverArgs(argv: string[]): {
  email: string | undefined;
  displayName: string | undefined;
  reason: string | undefined;
  dryRun: boolean;
  disableActive: boolean;
} {
  const positional: string[] = [];
  let reason: string | undefined;
  let dryRun = false;
  let disableActive = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--disable-active-administrators') disableActive = true;
    else if (argv[i] === '--reason') reason = argv[++i];
    else positional.push(argv[i]);
  }
  return { email: positional[0], displayName: positional[1], reason, dryRun, disableActive };
}

const registered = async (pool: Pool): Promise<boolean> =>
  (await pool.query(`SELECT 1 FROM organisation WHERE id = 1 AND registered_at IS NOT NULL`)).rowCount === 1;

const activeAdministrators = async (pool: Pool): Promise<Array<{ displayName: string; email: string }>> =>
  (
    await pool.query(
      `SELECT display_name AS "displayName", email FROM users WHERE role = 'enterprise_administrator' AND status = 'active' ORDER BY id`,
    )
  ).rows;

async function eligible(pool: Pool, raw: string): Promise<string | null> {
  const email = normaliseEmail(raw);
  if (!email) return null;
  const domain = email.split('@')[1];
  const { rowCount } = await pool.query(`SELECT 1 FROM eligible_domains WHERE domain = $1 AND removed_at IS NULL`, [domain]);
  return rowCount === 1 ? email : null;
}

/**
 * Administrator recovery (O07). Checks, in order: the reason; that the organisation is registered; that no
 * Administrator is active, unless --disable-active-administrators is given; that the email is on an eligible domain;
 * that the link would not go to an Administrator being disabled; and that a new person has a name. A refusal changes
 * nothing. Otherwise every still-Active Administrator is disabled (sessions ended, memberships held, alerts and a
 * notice queued) and a one-time recovery link is issued, all in one transaction; accepting the link makes the person
 * an Active Enterprise Administrator, and project access is never restored. A dry run changes nothing.
 * Returns the lines to print; a refusal or a failed email is thrown as an Error with the exact message.
 */
export async function recoverAdmin(
  pool: Pool,
  config: AppConfig,
  sender: CodeSender,
  now: Date,
  opts: RecoverOptions,
  nudge?: EmailNudge,
): Promise<string[]> {
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason === '') throw new Error(RECOVERY.noReason);
  if (!(await registered(pool))) throw new Error(RECOVERY.notSetUp);
  const active = await activeAdministrators(pool);
  if (active.length > 0 && !opts.disableActive && !opts.dryRun) throw new Error(RECOVERY.adminActive);
  const email = await eligible(pool, opts.email);
  if (!email) throw new Error(RECOVERY.notEligible);
  if (active.some((a) => a.email === email)) throw new Error(RECOVERY.recipientBeingDisabled);
  const hasAccount = (await pool.query(`SELECT 1 FROM users WHERE email = $1`, [email])).rowCount === 1;
  if (!hasAccount && (opts.displayName === undefined || cleanDisplayName(opts.displayName) === null)) throw new Error(RECOVERY.nameRequired);

  if (opts.dryRun) {
    const passed = `Dry run: all checks passed; a recovery link would be sent to ${email}.`;
    if (active.length === 0) return [passed];
    const listed = `Dry run: these Administrators would be disabled first: ${named(active)}`;
    if (opts.disableActive) return [listed, passed];
    return [
      listed,
      RECOVERY.dryRunActive,
      `With --disable-active-administrators, they would be disabled first and a recovery link would be sent to ${email}.`,
    ];
  }

  // The link is saved before the email goes; only a failure of the email itself is reported this way.
  let sendFailed = false;
  const guarded: CodeSender = {
    send: (to, code, minutes) => sender.send(to, code, minutes),
    sendSetupInvitation: async (to, link, expiresAt, kind) => {
      try {
        await sender.sendSetupInvitation(to, link, expiresAt, kind);
      } catch (err) {
        sendFailed = true;
        throw err;
      }
    },
  };
  // Set once committed, so a failed email still reports who was disabled.
  let disabledLine: string[] = [];
  try {
    const sent = await new SetupService(pool, config, guarded).issueRecovery(
      { email, displayName: opts.displayName, reason, disableActive: opts.disableActive === true },
      now,
      { adminActive: RECOVERY.adminActive, recipientBeingDisabled: RECOVERY.recipientBeingDisabled },
      async (committed) => {
        if (committed.disabled.length > 0) disabledLine = [`These Administrators were disabled first: ${named(committed.disabled)}`];
        // The notices and hold alerts are committed; the scheduled email tick still sends them if this is lost.
        if (committed.queued > 0 && nudge) await nudge.nudge();
      },
    );
    return [...disabledLine, `Recovery link sent to ${sent.email}. It expires on ${utc(sent.expiresAt)} UTC.`, RECOVERY.notRestored];
  } catch (err) {
    if (sendFailed) throw new Error([...disabledLine, RECOVERY.emailFailed].join('\n'));
    throw err;
  }
}

/** The command itself: prints the answer and returns the exit code (0 done or dry run, 1 refused or failed). */
export async function runRecoverAdmin(
  argv: string[],
  deps: { pool: Pool; config: AppConfig; sender: CodeSender; now: Date; out: (line: string) => void; err: (line: string) => void; nudge?: EmailNudge },
): Promise<number> {
  const args = parseRecoverArgs(argv);
  if (!args.email) {
    deps.err(RECOVERY.usage);
    return 1;
  }
  try {
    const lines = await recoverAdmin(deps.pool, deps.config, deps.sender, deps.now, { ...args, email: args.email }, deps.nudge);
    for (const line of lines) deps.out(line);
    return 0;
  } catch (err) {
    for (const line of (err instanceof Error ? err.message : String(err)).split('\n')) deps.err(line);
    return 1;
  }
}
