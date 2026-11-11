// The go-live checklist (spec §4): the 11 steps, the automatic checks and the closing rule.
import type { Pool, PoolClient } from 'pg';
import { uuidv7 } from '../common/uuid7';

export type StepMode = 'auto' | 'confirm' | 'auto_or_skip';

export interface StepDef {
  key: string;
  text: string;
  explanation: string;
  link: string;
  mode: StepMode;
}

/** Order and keys are fixed; positions 1 to 11 follow this order. */
export const STEPS: readonly StepDef[] = [
  { key: 'organisation', mode: 'auto', link: '#/organisation', text: 'Register your organisation: its name and email domains', explanation: "Kainow needs the organisation's name and email domains before anyone can be invited." },
  { key: 'logos', mode: 'auto_or_skip', link: '#/organisation', text: "Upload your organisation's logos (optional)", explanation: 'Logos appear on sign-in and on exported documents. Upload one, or confirm that you are skipping it.' },
  { key: 'second_admin', mode: 'auto', link: '#/people', text: 'Appoint a second Enterprise Administrator', explanation: 'A second Administrator means the organisation is never locked out if one is unavailable.' },
  { key: 'recovery', mode: 'confirm', link: '#/organisation', text: 'Nominate the recovery custodian and test the recovery procedure', explanation: 'Record the custodian on the Organisation page, then test recovery on the server with recover-admin --dry-run.' },
  { key: 'mailbox', mode: 'confirm', link: 'INSTALL.md, the section on Microsoft 365 email', text: 'Set up the Microsoft 365 sender mailbox and its permissions (INSTALL.md), with an auto-reply saying it is not monitored', explanation: 'Kainow sends its emails from this mailbox; people must not expect replies to be read.' },
  { key: 'test_email', mode: 'confirm', link: '#/deliveries', text: 'Send a test email and check that it arrived', explanation: 'Send a test email, wait until it shows as sent, then check it reached the inbox.' },
  { key: 'calendar', mode: 'confirm', link: '#/notifications-settings', text: "Set the working weekdays and this year's holidays", explanation: 'Notice times follow the working days, so the weekdays and holidays must be right.' },
  { key: 'backups', mode: 'confirm', link: 'INSTALL.md, the section on Back up', text: 'Configure daily encrypted backups and complete a test restore', explanation: 'A backup is only real once a restore from it has worked.' },
  { key: 'department', mode: 'auto', link: '#/departments', text: 'Create a real department', explanation: 'Projects and people belong to a department.' },
  { key: 'users', mode: 'auto', link: '#/', text: 'Admit real users', explanation: 'At least one person who is not an Enterprise Administrator has accepted their invitation and is Active.' },
  { key: 'project', mode: 'auto', link: '#/', text: 'Launch the first real project', explanation: 'A real project has reached Active. When this and the two steps before it are done, the checklist closes.' },
];

export const TOTAL = STEPS.length;
export const CLOSING_KEYS = ['department', 'users', 'project'] as const;
export const MSG = {
  autoStep: 'Kainow ticks this step itself.',
  testEmailFirst: 'Send a test email first, then check it arrived.',
  custodianFirst: 'Record the recovery custodian on the Organisation page first.',
  closed: 'The go-live checklist is closed.',
  noteLong: 'A note can be at most 200 characters.',
  alreadyDone: 'This step is already done.',
  notDone: 'This step is not done.',
} as const;

type Db = Pool | PoolClient;

/** True once both recovery custodian fields are recorded (step 4 can then be marked done). */
export async function custodianRecorded(db: Db): Promise<boolean> {
  const { rowCount } = await db.query(
    `SELECT 1 FROM organisation WHERE id = 1 AND recovery_custodian_name IS NOT NULL AND recovery_custodian_contact IS NOT NULL`,
  );
  return rowCount === 1;
}

/** Which automatic conditions hold now. */
export async function conditions(db: Db): Promise<Record<string, boolean>> {
  const { rows } = await db.query(`
    SELECT
      EXISTS (SELECT 1 FROM organisation WHERE registered_at IS NOT NULL) AS organisation,
      EXISTS (SELECT 1 FROM organisation_logos) AS logos,
      (SELECT count(*) FROM users WHERE role = 'enterprise_administrator' AND status = 'active') >= 2 AS second_admin,
      EXISTS (SELECT 1 FROM departments) AS department,
      EXISTS (SELECT 1 FROM users WHERE status = 'active' AND role <> 'enterprise_administrator') AS users,
      (EXISTS (SELECT 1 FROM projects WHERE status = 'active')
        OR EXISTS (SELECT 1 FROM project_transitions WHERE to_status = 'active')) AS project`);
  return rows[0] as Record<string, boolean>;
}

/**
 * Ticks every automatic step whose condition holds, then closes the checklist when department, users and project are done.
 * Safe to run at any time and from several places at once; does nothing once the checklist is closed.
 */
export async function refreshChecklist(db: Pool, now: Date): Promise<void> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const closedAt = (await c.query(`SELECT closed_at FROM golive_checklist WHERE id = 1 FOR UPDATE`)).rows[0]?.closed_at;
    if (closedAt) {
      await c.query('COMMIT');
      return;
    }
    const holds = await conditions(c);
    const auto = STEPS.filter((s) => s.mode !== 'confirm' && holds[s.key]).map((s) => s.key);
    // A skip (logos) gives way to Kainow's own tick once the condition holds.
    const ticked = (await c.query(
      `UPDATE golive_steps SET ticked_by = NULL, ticked_at = $2, skipped = false, note = NULL
        WHERE key = ANY($1::text[]) AND (ticked_at IS NULL OR skipped) RETURNING key`,
      [auto, now],
    )).rows as { key: string }[];
    for (const { key } of ticked) {
      await c.query(`INSERT INTO golive_events (id, step_key, action, actor_id, note, at) VALUES ($1, $2, 'ticked', NULL, NULL, $3)`, [uuidv7(), key, now]);
    }
    const done = (await c.query(`SELECT count(*)::int AS n FROM golive_steps WHERE key = ANY($1::text[]) AND ticked_at IS NOT NULL`, [[...CLOSING_KEYS]])).rows[0].n;
    if (done === CLOSING_KEYS.length) {
      await c.query(`UPDATE golive_checklist SET closed_at = $1 WHERE id = 1`, [now]);
      await c.query(`INSERT INTO golive_events (id, step_key, action, actor_id, note, at) VALUES ($1, NULL, 'closed', NULL, NULL, $2)`, [uuidv7(), now]);
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
