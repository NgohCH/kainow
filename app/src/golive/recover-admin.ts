import type { Pool } from 'pg';
import { normaliseEmail } from '../auth/auth.service';
import type { CodeSender } from '../auth/tokens';
import type { AppConfig } from '../config';
import { SetupService } from '../organisation/setup.service';

/** The exact words of every answer the recovery command gives. */
export const RECOVERY = {
  noReason: 'Give a reason with --reason "<why>".',
  notSetUp: 'Kainow is not set up yet; use golive-init or setup-invite instead.',
  adminActive: 'An Administrator is still active; recovery is only for when none is.',
  notEligible: 'That email is not on an eligible domain.',
  dryRunActive: 'Would be refused now: an Administrator is active. All other checks passed.',
  notRestored: 'When they sign in with it, they become an Enterprise Administrator. Their project roles are not restored.',
  // The cause is not printed: a mail server's answer can carry account details.
  emailFailed:
    'The recovery link was recorded, but the email could not be sent: the email service did not accept it. Run the same command again to send a new link.',
  usage: 'Usage: npm run recover-admin -- <email> "<name>" --reason "<why>" [--dry-run]',
} as const;

const utc = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

export interface RecoverOptions {
  email: string;
  displayName?: string;
  reason?: string;
  dryRun: boolean;
}

/** Reads `<email> "<name>" --reason "<why>" [--dry-run]`, flags in any position. */
export function parseRecoverArgs(argv: string[]): { email: string | undefined; displayName: string | undefined; reason: string | undefined; dryRun: boolean } {
  const positional: string[] = [];
  let reason: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--reason') reason = argv[++i];
    else positional.push(argv[i]);
  }
  return { email: positional[0], displayName: positional[1], reason, dryRun };
}

const registered = async (pool: Pool): Promise<boolean> =>
  (await pool.query(`SELECT 1 FROM organisation WHERE id = 1 AND registered_at IS NOT NULL`)).rowCount === 1;

const adminActive = async (pool: Pool): Promise<boolean> =>
  (await pool.query(`SELECT 1 FROM users WHERE role = 'enterprise_administrator' AND status = 'active' LIMIT 1`)).rowCount === 1;

async function eligible(pool: Pool, raw: string): Promise<string | null> {
  const email = normaliseEmail(raw);
  if (!email) return null;
  const domain = email.split('@')[1];
  const { rowCount } = await pool.query(`SELECT 1 FROM eligible_domains WHERE domain = $1 AND removed_at IS NULL`, [domain]);
  return rowCount === 1 ? email : null;
}

/**
 * Administrator recovery (O07): only when Kainow has no Active Enterprise Administrator at all. Checks, in order, the
 * reason, that the organisation is registered, that no Administrator is active and that the email is on an eligible
 * domain; a refusal changes nothing. On success a one-time link is issued through the setup invitation, and accepting
 * it makes the person an Active Enterprise Administrator; project access is never restored. A dry run changes nothing.
 * Returns the lines to print; a refusal or a failed email is thrown as an Error with the exact message.
 */
export async function recoverAdmin(pool: Pool, config: AppConfig, sender: CodeSender, now: Date, opts: RecoverOptions): Promise<string[]> {
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (reason === '') throw new Error(RECOVERY.noReason);
  if (!(await registered(pool))) throw new Error(RECOVERY.notSetUp);
  const active = await adminActive(pool);
  if (active && !opts.dryRun) throw new Error(RECOVERY.adminActive);
  const email = await eligible(pool, opts.email);
  if (!email) throw new Error(RECOVERY.notEligible);
  if (opts.dryRun) return [active ? RECOVERY.dryRunActive : `Dry run: all checks passed; a recovery link would be sent to ${email}.`];

  // The link is saved before the email goes; only a failure of the email itself is reported this way.
  let sendFailed = false;
  const guarded: CodeSender = {
    send: (to, code, minutes) => sender.send(to, code, minutes),
    sendSetupInvitation: async (to, link, expiresAt) => {
      try {
        await sender.sendSetupInvitation(to, link, expiresAt);
      } catch (err) {
        sendFailed = true;
        throw err;
      }
    },
  };
  try {
    const sent = await new SetupService(pool, config, guarded).issueRecovery({ email, displayName: opts.displayName, reason }, now, RECOVERY.adminActive);
    return [`Recovery link sent to ${sent.email}. It expires on ${utc(sent.expiresAt)} UTC.`, RECOVERY.notRestored];
  } catch (err) {
    if (sendFailed) throw new Error(RECOVERY.emailFailed);
    throw err;
  }
}

/** The command itself: prints the answer and returns the exit code (0 done or dry run, 1 refused or failed). */
export async function runRecoverAdmin(
  argv: string[],
  deps: { pool: Pool; config: AppConfig; sender: CodeSender; now: Date; out: (line: string) => void; err: (line: string) => void },
): Promise<number> {
  const args = parseRecoverArgs(argv);
  if (!args.email) {
    deps.err(RECOVERY.usage);
    return 1;
  }
  try {
    const lines = await recoverAdmin(deps.pool, deps.config, deps.sender, deps.now, { ...args, email: args.email });
    for (const line of lines) deps.out(line);
    return 0;
  } catch (err) {
    deps.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
