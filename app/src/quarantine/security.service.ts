/**
 * Security reviewers and quarantined-original grants (history spec 7.6, D82, Q03), and the Administrators' case list
 * (spec 6, 7.7).
 *
 *  - An Enterprise Administrator designates and removes security reviewers, with a reason, never themselves
 *    (security_reviewer_events, CHECK actor_id <> user_id).
 *  - A security reviewer asks to open named cases with a purpose and a duration in hours (default 24). Any Enterprise
 *    Administrator other than the requester approves or declines (CHECK decided_by <> requester_id, and the same
 *    check here with a plain sentence). With no other Administrator the request waits: there is no self-approval or
 *    emergency route. Approvers are told in-app: the requester's name and the case count only.
 *  - Extension is a fresh approval (Claude's call): an Administrator other than the requester approves a NEW grant row
 *    for the same requester, purpose and cases, expiring `hours` after that approval; the old grant is left to expire.
 *    The `grant_extended` event of each case names both (detail { grantId, extends, hours }). quarantine_grants keeps
 *    one decision per row, so every approval is its own row with its own approver.
 *  - A grant is current while approved, not revoked and not past expires_at (elapsed hours, Q02). Any Administrator
 *    may revoke it, with a reason.
 *  - Reveal original: only the requester of a current grant naming the case, still a designated reviewer, with
 *    `{ confirm: true }`. The originals are decrypted in memory (readOriginals) and returned with the place of each
 *    removed span; the route sets Cache-Control: no-store; an `original_opened` event records who, which item and
 *    which grant (no text). No other answer, export, email or AI path ever reads quarantine_originals.
 *  - Release unchanged (false alarm): the same grant holder, with a reason, on an open case. One top-level
 *    transaction: the case row is closed as `released_unchanged` first (no savepoint), then restoreOriginals decrypts
 *    every original of the case back into place (the reported item, confirmed copies and places still masked), values
 *    changed since cleaning are kept and listed "changed since cleaning — not restored", holds are cleared, undecided
 *    places are dismissed by the release, and every Administrator is told in-app. Encrypted rows are kept. A case
 *    already released with the credential removed stays as released (spec 2: otherwise the cleaned version is
 *    permanent).
 *
 * The marked text, originals and the key never reach a log, error, event, notification or audit row.
 */
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readOptionalReason, readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { CASE_CLOSED, type Disclosures, WAITING_FOR_KEY, unhold } from './cases.service';
import { type RevealedValue, readOriginals, restoreOriginals } from './clean';
import { PROTECTED_KEY, type ProtectedKey } from './protected-key';
import { stillInStorage } from '../storage/withhold';
import { lockSweeps } from './sweep-lock';
import { ITEM_KINDS, type ItemKind } from './registry';

type Db = Pool | PoolClient;

export const CHANGED_SINCE_CLEANING = 'changed since cleaning — not restored';
export const DISCLOSURES_LABEL = 'Known disclosures (copies outside Kainow cannot be recalled)';
export const ADMIN_ONLY = 'Only an Enterprise Administrator can do this.';
export const NOT_SELF_DESIGNATE = 'You cannot designate yourself as a security reviewer; another Administrator must.';
export const NOT_SELF_UNDESIGNATE = 'You cannot remove yourself as a security reviewer; another Administrator must.';
export const ALREADY_REVIEWER = 'This person is already a security reviewer.';
export const NOT_REVIEWER = 'This person is not a security reviewer.';
export const REVIEWER_ONLY = 'Only a designated security reviewer can ask to open quarantined originals.';
export const NOT_OWN_DECISION = 'You cannot decide your own request; another Administrator must.';
export const NOT_OWN_EXTENSION = 'You cannot extend your own grant; another Administrator must.';
export const ALREADY_DECIDED_GRANT = 'This request has already been decided.';
export const NOT_EXTENDABLE = 'Only an approved grant that was not revoked can be extended.';
export const NOT_REVOCABLE = 'Only an approved grant that was not revoked can be revoked.';
export const NO_LONGER_REVIEWER = 'The requester is no longer a security reviewer.';
export const NO_CURRENT_GRANT = 'You need a current approved grant naming this case to open its originals.';
export const CONFIRM_REVEAL = 'Confirm that you are viewing a quarantined credential for the stated purpose.';
export const REVEAL_NOTICE = 'You are viewing a quarantined credential for the stated purpose. Do not copy it.';
export const CASES_REFUSED = 'Choose the cases to open, by reference.';
export const DECISION_REFUSED = 'Approve or decline the request.';
export const HOURS_REFUSED = 'Give the number of hours as a whole number from 1 to 8,760.';
/** No maximum other than fresh approval (spec 7.6); a year bounds the input. */
const MAX_HOURS = 8_760;
const MAX_CASES = 50;

interface Person {
  id: string;
  name: string;
  admin: boolean;
  reviewer: boolean;
}

interface GrantRow {
  id: string;
  requesterId: string;
  purpose: string;
  hours: number;
  decision: 'approved' | 'declined' | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface ChangedValue {
  table: string;
  rowKey: Record<string, unknown>;
  label: string;
}

/** A case as Administrators and security reviewers see it: references, counts and dates; never content. */
export interface SecurityCase {
  caseId: string;
  projectId: string;
  project: string;
  kind: ItemKind;
  itemId: string;
  /** The reporter's name; null when Kainow reported it. */
  reporter: string | null;
  state: string;
  waitingForKey: boolean;
  label: string | null;
  reportedAt: string;
  closedAt: string | null;
  disclosures: Disclosures;
  disclosuresLabel: string;
  changedSinceCleaning: ChangedValue[];
  /** For a reviewer: whether they hold a current grant naming the case. */
  /** The reported item and its confirmed copies, each of which Reveal original can open: references only. */
  items: Array<{ kind: ItemKind; id: string; role: string }>;
  /** "Still in storage" while a withheld file of the case is not yet removed, or a held output has linked documents (external outputs spec 4.7, 8.5). */
  stillInStorage: { label: string; files: number; links: number } | null;
  currentGrant?: boolean;
  /**
   * Projects made from the case's project, copies of copies included: Kainow does not search them, so whoever handles the
   * case knows to. Named for an Administrator; for a reviewer only those that have a case (their list names them), else counted.
   */
  copiedTo: { projects: Array<{ id: string; name: string }>; others: number };
  /** The project this one was made from, named by the same rule; null when it was not copied. */
  copiedFrom: { id: string; name: string } | { hidden: true } | null;
}

async function inTransaction<T>(pool: Pool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** A row key as an event or a list may carry it: numbers and ids only (a key column could hold cleaned text). */
function safeKey(rowKey: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (rowKey && typeof rowKey === 'object') {
    for (const [k, v] of Object.entries(rowKey as Record<string, unknown>)) {
      if (typeof v === 'number' || (typeof v === 'string' && UUID.test(v))) out[k] = v;
    }
  }
  return out;
}

function readHours(raw: unknown): number {
  if (raw === undefined || raw === null) return 24;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_HOURS) throw new BadRequestException(HOURS_REFUSED);
  return raw;
}

@Injectable()
export class SecurityService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(PROTECTED_KEY) private readonly key: ProtectedKey | null,
  ) {}

  // -------------------------------------------------------------------------------------------------------------
  // Who is who
  // -------------------------------------------------------------------------------------------------------------

  private async person(db: Db, userId: string): Promise<Person | null> {
    if (!UUID.test(userId)) return null;
    const r = (
      await db.query<Person>(
        `SELECT id, display_name AS name, role = 'enterprise_administrator' AS admin, security_reviewer AS reviewer FROM users WHERE id = $1 AND status = 'active'`,
        [userId],
      )
    ).rows[0];
    return r ?? null;
  }

  private async admin(db: Db, user: AuthUser): Promise<Person> {
    const p = await this.person(db, user.id);
    if (!p?.admin) throw new ForbiddenException(ADMIN_ONLY);
    return p;
  }

  private async reviewer(db: Db, user: AuthUser): Promise<Person> {
    const p = await this.person(db, user.id);
    if (!p?.reviewer) throw new ForbiddenException(REVIEWER_ONLY);
    return p;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Security reviewers (the Organisation page's Security reviewers section)
  // -------------------------------------------------------------------------------------------------------------

  async reviewers(user: AuthUser): Promise<{ reviewers: Array<{ id: string; name: string; email: string; designatedAt: string | null; designatedBy: string | null }> }> {
    await this.admin(this.pool, user);
    const { rows } = await this.pool.query<{ id: string; name: string; email: string; at: Date | null; by: string | null }>(
      `SELECT u.id, u.display_name AS name, u.email, e.at, a.display_name AS by
         FROM users u
         LEFT JOIN LATERAL (SELECT at, actor_id FROM security_reviewer_events WHERE user_id = u.id AND kind = 'designated' ORDER BY at DESC, id DESC LIMIT 1) e ON true
         LEFT JOIN users a ON a.id = e.actor_id
        WHERE u.security_reviewer AND u.status = 'active'
        ORDER BY u.display_name, u.id`,
    );
    return { reviewers: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, designatedAt: r.at ? r.at.toISOString() : null, designatedBy: r.by })) };
  }

  async designate(user: AuthUser, userId: string, body: { reason: unknown }): Promise<{ userId: string; securityReviewer: true }> {
    await this.setReviewer(user, userId, body, true);
    return { userId, securityReviewer: true };
  }

  async undesignate(user: AuthUser, userId: string, body: { reason: unknown }): Promise<{ userId: string; securityReviewer: false }> {
    await this.setReviewer(user, userId, body, false);
    return { userId, securityReviewer: false };
  }

  private async setReviewer(user: AuthUser, userId: string, body: { reason: unknown }, on: boolean): Promise<void> {
    await inTransaction(this.pool, async (db) => {
      await this.admin(db, user);
      if (userId === user.id) throw new ForbiddenException(on ? NOT_SELF_DESIGNATE : NOT_SELF_UNDESIGNATE);
      const target = await this.person(db, userId);
      if (!target) throw new NotFoundException();
      const reason = readReason(body.reason);
      const changed = await db.query(`UPDATE users SET security_reviewer = $2 WHERE id = $1 AND security_reviewer <> $2`, [userId, on]);
      if (!changed.rowCount) throw new ConflictException(on ? ALREADY_REVIEWER : NOT_REVIEWER);
      const at = this.now();
      await db.query(`INSERT INTO security_reviewer_events (id, user_id, kind, actor_id, reason, at) VALUES ($1, $2, $3, $4, $5, $6)`, [
        uuidv7(at.getTime()), userId, on ? 'designated' : 'undesignated', user.id, reason, at,
      ]);
      if (!on) {
        // Undesignating ends the reviewer's approved grants at once, so none revives on a later designation (M6).
        const open = (
          await db.query<{ id: string }>(
            `UPDATE quarantine_grants SET revoked_by = $2, revoked_at = $3, revoke_reason = $4
              WHERE requester_id = $1 AND decision = 'approved' AND revoked_at IS NULL RETURNING id`,
            [userId, user.id, at, reason],
          )
        ).rows;
        for (const g of open.sort((a, b) => a.id.localeCompare(b.id))) {
          await this.grantEvents(db, g.id, { actorId: user.id, action: 'grant_revoked', reason, detail: { grantId: g.id, undesignated: true }, at });
          await writeAudit(db, { at, action: 'security.grant_revoked', actorUserId: user.id, subjectType: 'quarantine_grant', subjectId: g.id });
        }
      }
      await writeAudit(db, { at, action: on ? 'security.reviewer_designated' : 'security.reviewer_undesignated', actorUserId: user.id, subjectType: 'user', subjectId: userId });
    });
  }

  // -------------------------------------------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------------------------------------------

  /** One quarantine_events row per case of the grant (events belong to a case and its project). */
  private async grantEvents(db: Db, grantId: string, e: { actorId: string; action: string; reason?: string | null; detail: Record<string, unknown>; at: Date }): Promise<void> {
    const cases = (
      await db.query<{ id: string; projectId: string }>(
        `SELECT c.id, c.project_id AS "projectId" FROM quarantine_grant_cases gc JOIN quarantine_cases c ON c.id = gc.case_id WHERE gc.grant_id = $1 ORDER BY c.id`,
        [grantId],
      )
    ).rows;
    for (const c of cases) {
      await db.query(
        `INSERT INTO quarantine_events (id, case_id, project_id, actor_id, action, reason, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [uuidv7(e.at.getTime()), c.id, c.projectId, e.actorId, e.action, e.reason ?? null, JSON.stringify(e.detail), e.at],
      );
    }
  }

  private async notify(db: Db, userIds: string[], n: { kind: string; urgent: boolean; summary: string; link: string; projectId?: string | null; at: Date }): Promise<number> {
    for (const userId of [...new Set(userIds)].sort()) {
      await db.query(
        `INSERT INTO notifications (id, user_id, project_id, kind, urgent, summary, link, created_at, email_off) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [uuidv7(n.at.getTime()), userId, n.projectId ?? null, n.kind, n.urgent, n.summary, n.link, n.at],
      );
    }
    return new Set(userIds).size;
  }

  private async admins(db: Db, except: string | null = null): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE role = 'enterprise_administrator' AND status = 'active' AND id IS DISTINCT FROM $1 ORDER BY id`,
      [except],
    );
    return rows.map((r) => r.id);
  }

  /** { caseIds, purpose, hours = 24 } → { grantId }: a request waiting for another Administrator. */
  async requestGrant(user: AuthUser, body: { caseIds: unknown; purpose: unknown; hours?: unknown }): Promise<{ grantId: string }> {
    return inTransaction(this.pool, async (db) => {
      const me = await this.reviewer(db, user);
      const raw = body.caseIds;
      if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CASES || raw.some((c) => typeof c !== 'string')) throw new BadRequestException(CASES_REFUSED);
      const caseIds = [...new Set(raw as string[])];
      if (caseIds.some((c) => !UUID.test(c))) throw new NotFoundException();
      const found = (await db.query(`SELECT id FROM quarantine_cases WHERE id = ANY($1::uuid[])`, [caseIds])).rowCount;
      if (found !== caseIds.length) throw new NotFoundException();
      const purpose = readReason(body.purpose, 'a purpose');
      const hours = readHours(body.hours);
      const at = this.now();
      const grantId = uuidv7(at.getTime());
      await db.query(`INSERT INTO quarantine_grants (id, requester_id, purpose, hours, requested_at) VALUES ($1, $2, $3, $4, $5)`, [grantId, me.id, purpose, hours, at]);
      await db.query(`INSERT INTO quarantine_grant_cases (grant_id, case_id) SELECT $1, unnest($2::uuid[])`, [grantId, caseIds]);
      await this.grantEvents(db, grantId, { actorId: me.id, action: 'grant_requested', detail: { grantId, hours }, at });
      const n = caseIds.length;
      await this.notify(db, await this.admins(db, me.id), {
        kind: 'quarantine_grant_requested',
        urgent: true,
        summary: `${me.name} asked to open quarantined originals in ${n} case${n === 1 ? '' : 's'}.`,
        link: '#/security/grants',
        at,
      });
      await writeAudit(db, { at, action: 'security.grant_requested', actorUserId: me.id, subjectType: 'quarantine_grant', subjectId: grantId, detail: { cases: n, hours } });
      return { grantId };
    });
  }

  private async grant(db: Db, grantId: string, lock = false): Promise<GrantRow> {
    if (!UUID.test(grantId)) throw new NotFoundException();
    const g = (
      await db.query<GrantRow>(
        `SELECT id, requester_id AS "requesterId", purpose, hours, decision, expires_at AS "expiresAt", revoked_at AS "revokedAt"
           FROM quarantine_grants WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
        [grantId],
      )
    ).rows[0];
    if (!g) throw new NotFoundException();
    return g;
  }

  /** { decision: 'approved' | 'declined', reason } by an Administrator other than the requester. */
  async decideGrant(user: AuthUser, grantId: string, body: { decision: unknown; reason: unknown }): Promise<{ grantId: string; decision: string; expiresAt: string | null }> {
    return inTransaction(this.pool, async (db) => {
      const me = await this.admin(db, user);
      const g = await this.grant(db, grantId, true);
      if (g.requesterId === me.id) throw new ForbiddenException(NOT_OWN_DECISION);
      if (g.decision !== null) throw new ConflictException(ALREADY_DECIDED_GRANT);
      const decision = body.decision;
      if (decision !== 'approved' && decision !== 'declined') throw new BadRequestException(DECISION_REFUSED);
      const reason = decision === 'declined' ? readReason(body.reason) : readOptionalReason(body.reason);
      if (decision === 'approved' && !(await this.person(db, g.requesterId))?.reviewer) throw new ConflictException(NO_LONGER_REVIEWER);
      const at = this.now();
      const expiresAt = decision === 'approved' ? new Date(at.getTime() + g.hours * 3_600_000) : null;
      await db.query(
        `UPDATE quarantine_grants SET decision = $2, decided_by = $3, decided_at = $4, decision_reason = $5, expires_at = $6 WHERE id = $1`,
        [g.id, decision, me.id, at, reason, expiresAt],
      );
      await this.grantEvents(db, g.id, {
        actorId: me.id,
        action: decision === 'approved' ? 'grant_approved' : 'grant_declined',
        reason,
        detail: { grantId: g.id, ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) },
        at,
      });
      await this.notify(db, [g.requesterId], { kind: 'quarantine_grant_decided', urgent: false, summary: `Your request to open quarantined originals was ${decision}.`, link: '#/security/grants', at });
      await writeAudit(db, { at, action: `security.grant_${decision}`, actorUserId: me.id, subjectType: 'quarantine_grant', subjectId: g.id });
      return { grantId: g.id, decision, expiresAt: expiresAt ? expiresAt.toISOString() : null };
    });
  }

  /** { hours = 24, reason }: a fresh approval, as a new grant row, by an Administrator other than the requester. */
  async extendGrant(user: AuthUser, grantId: string, body: { hours?: unknown; reason: unknown }): Promise<{ grantId: string; extends: string; expiresAt: string }> {
    return inTransaction(this.pool, async (db) => {
      const me = await this.admin(db, user);
      const g = await this.grant(db, grantId, true);
      if (g.requesterId === me.id) throw new ForbiddenException(NOT_OWN_EXTENSION);
      if (g.decision !== 'approved' || g.revokedAt !== null) throw new ConflictException(NOT_EXTENDABLE);
      if (!(await this.person(db, g.requesterId))?.reviewer) throw new ConflictException(NO_LONGER_REVIEWER);
      const hours = readHours(body.hours);
      const reason = readReason(body.reason);
      const at = this.now();
      const expiresAt = new Date(at.getTime() + hours * 3_600_000);
      const fresh = uuidv7(at.getTime());
      await db.query(
        `INSERT INTO quarantine_grants (id, requester_id, purpose, hours, requested_at, decision, decided_by, decided_at, decision_reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'approved', $6, $5, $7, $8)`,
        [fresh, g.requesterId, g.purpose, hours, at, me.id, reason, expiresAt],
      );
      await db.query(`INSERT INTO quarantine_grant_cases (grant_id, case_id) SELECT $1, case_id FROM quarantine_grant_cases WHERE grant_id = $2`, [fresh, g.id]);
      await this.grantEvents(db, fresh, { actorId: me.id, action: 'grant_extended', reason, detail: { grantId: fresh, extends: g.id, hours }, at });
      await this.notify(db, [g.requesterId], { kind: 'quarantine_grant_decided', urgent: false, summary: 'Your access to quarantined originals was extended.', link: '#/security/grants', at });
      await writeAudit(db, { at, action: 'security.grant_extended', actorUserId: me.id, subjectType: 'quarantine_grant', subjectId: fresh, detail: { extends: g.id, hours } });
      return { grantId: fresh, extends: g.id, expiresAt: expiresAt.toISOString() };
    });
  }

  /** { reason }: any Administrator ends an approved grant. */
  async revokeGrant(user: AuthUser, grantId: string, body: { reason: unknown }): Promise<{ grantId: string; revoked: true }> {
    return inTransaction(this.pool, async (db) => {
      const me = await this.admin(db, user);
      const g = await this.grant(db, grantId, true);
      const reason = readReason(body.reason);
      if (g.decision !== 'approved' || g.revokedAt !== null) throw new ConflictException(NOT_REVOCABLE);
      const at = this.now();
      await db.query(`UPDATE quarantine_grants SET revoked_by = $2, revoked_at = $3, revoke_reason = $4 WHERE id = $1`, [g.id, me.id, at, reason]);
      await this.grantEvents(db, g.id, { actorId: me.id, action: 'grant_revoked', reason, detail: { grantId: g.id }, at });
      await writeAudit(db, { at, action: 'security.grant_revoked', actorUserId: me.id, subjectType: 'quarantine_grant', subjectId: g.id });
      return { grantId: g.id, revoked: true as const };
    });
  }

  /** Every grant for an Administrator; a reviewer's own otherwise. Purpose, cases and status; never content. */
  async grants(user: AuthUser): Promise<{ grants: Array<Record<string, unknown>> }> {
    const me = await this.person(this.pool, user.id);
    if (!me?.admin && !me?.reviewer) throw new ForbiddenException(REVIEWER_ONLY);
    const now = this.now();
    const { rows } = await this.pool.query(
      `SELECT g.id, g.requester_id AS "requesterId", r.display_name AS requester, g.purpose, g.hours, g.requested_at AS "requestedAt",
              g.decision, d.display_name AS "decidedBy", g.decided_at AS "decidedAt", g.decision_reason AS "decisionReason", g.expires_at AS "expiresAt",
              v.display_name AS "revokedBy", g.revoked_at AS "revokedAt", g.revoke_reason AS "revokeReason",
              ARRAY(SELECT gc.case_id::text FROM quarantine_grant_cases gc WHERE gc.grant_id = g.id ORDER BY gc.case_id) AS "caseIds"
         FROM quarantine_grants g
         JOIN users r ON r.id = g.requester_id
         LEFT JOIN users d ON d.id = g.decided_by
         LEFT JOIN users v ON v.id = g.revoked_by
        WHERE $1 OR g.requester_id = $2
        ORDER BY g.requested_at DESC, g.id DESC`,
      [me.admin, me.id],
    );
    const iso = (d: Date | null) => (d ? d.toISOString() : null);
    return {
      grants: rows.map((g) => ({
        ...g,
        requestedAt: iso(g.requestedAt),
        decidedAt: iso(g.decidedAt),
        expiresAt: iso(g.expiresAt),
        revokedAt: iso(g.revokedAt),
        status:
          g.decision === null ? 'waiting' : g.decision === 'declined' ? 'declined' : g.revokedAt ? 'revoked' : g.expiresAt <= now ? 'expired' : 'current',
      })),
    };
  }

  /** The current grant of `userId` naming `caseId` (approved by someone else, not revoked, not expired), or null. */
  private async currentGrant(db: Db, userId: string, caseId: string): Promise<string | null> {
    const r = await db.query<{ id: string }>(
      `SELECT g.id FROM quarantine_grants g JOIN quarantine_grant_cases gc ON gc.grant_id = g.id
        WHERE g.requester_id = $1 AND gc.case_id = $2 AND g.decision = 'approved' AND g.decided_by <> g.requester_id
          AND g.revoked_at IS NULL AND g.expires_at > $3
        ORDER BY g.expires_at DESC, g.id LIMIT 1`,
      [userId, caseId, this.now()],
    );
    return r.rows[0]?.id ?? null;
  }

  /** The reviewer and their current grant for the case, or 403 (no case found is 404 only for a grant holder). */
  private async holder(db: Db, user: AuthUser, caseId: string): Promise<{ me: Person; grantId: string }> {
    const me = await this.person(db, user.id);
    if (!me?.reviewer) throw new ForbiddenException(NO_CURRENT_GRANT);
    if (!UUID.test(caseId)) throw new NotFoundException();
    const grantId = await this.currentGrant(db, me.id, caseId);
    if (!grantId) throw new ForbiddenException(NO_CURRENT_GRANT);
    return { me, grantId };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Cases (no content)
  // -------------------------------------------------------------------------------------------------------------

  private async caseList(viewer: string | null): Promise<SecurityCase[]> {
    const { rows } = await this.pool.query(
      `SELECT c.id, c.project_id AS "projectId", p.name AS project, c.item_kind AS kind, c.item_id AS "itemId", u.display_name AS reporter,
              c.state, c.waiting_for_key AS "waitingForKey", c.reported_at AS "reportedAt", c.closed_at AS "closedAt", fp.id AS "fromId", fp.name AS "fromName",
              COALESCE((SELECT json_agg(json_build_object('kind', i.item_kind, 'id', i.item_id, 'role', i.role) ORDER BY i.role DESC, i.item_id) FROM quarantine_items i WHERE i.case_id = c.id), '[]'::json) AS items,
              (SELECT e.detail FROM quarantine_events e WHERE e.case_id = c.id AND e.action = 'reported' ORDER BY e.at, e.id LIMIT 1) AS reported,
              (SELECT e.detail FROM quarantine_events e WHERE e.case_id = c.id AND e.action = 'released_unchanged' ORDER BY e.at, e.id LIMIT 1) AS unchanged
         FROM quarantine_cases c JOIN projects p ON p.id = c.project_id LEFT JOIN projects fp ON fp.id = p.copied_from_id LEFT JOIN users u ON u.id = c.reporter_id
        ORDER BY c.reported_at, c.id`,
    );
    // The case list names every project with a case; an Administrator knows every project.
    const known = viewer === null ? null : new Set(rows.map((r) => r.projectId as string));
    const copies = (
      await this.pool.query<{ root: string; id: string; name: string }>(
        `WITH RECURSIVE made AS (
           SELECT c.id AS root, p.id FROM unnest($1::uuid[]) AS c(id) JOIN projects p ON p.copied_from_id = c.id
           UNION SELECT m.root, p.id FROM made m JOIN projects p ON p.copied_from_id = m.id)
         SELECT m.root, p.id, p.name FROM made m JOIN projects p ON p.id = m.id ORDER BY p.created_at, p.id`,
        [[...new Set(rows.map((r) => r.projectId))]],
      )
    ).rows;
    const named = (id: string) => known === null || known.has(id);
    const out: SecurityCase[] = [];
    for (const r of rows) {
      const to = copies.filter((x) => x.root === r.projectId);
      const changed = Array.isArray(r.unchanged?.changed) ? (r.unchanged.changed as Array<{ table: string; rowKey: Record<string, unknown> }>) : [];
      out.push({
        caseId: r.id,
        projectId: r.projectId,
        project: r.project,
        kind: r.kind,
        itemId: r.itemId,
        reporter: r.reporter ?? null,
        state: r.state,
        waitingForKey: r.waitingForKey,
        label: r.waitingForKey ? WAITING_FOR_KEY : null,
        reportedAt: r.reportedAt.toISOString(),
        closedAt: r.closedAt ? r.closedAt.toISOString() : null,
        disclosures: r.reported?.disclosures ?? { aiRequests: [], emails: [], audienceSize: 0 },
        disclosuresLabel: DISCLOSURES_LABEL,
        items: r.items,
        changedSinceCleaning: changed.map((c) => ({ table: c.table, rowKey: c.rowKey, label: CHANGED_SINCE_CLEANING })),
        stillInStorage: await stillInStorage(this.pool, r.id),
        copiedTo: { projects: to.filter((x) => named(x.id)).map((x) => ({ id: x.id, name: x.name })), others: to.filter((x) => !named(x.id)).length },
        copiedFrom: r.fromId === null ? null : named(r.fromId) ? { id: r.fromId, name: r.fromName } : { hidden: true },
        ...(viewer ? { currentGrant: (await this.currentGrant(this.pool, viewer, r.id)) !== null } : {}),
      });
    }
    return out;
  }

  /** Whether this person is a designated security reviewer: a plain answer for anyone signed in, never a refusal. */
  async me(user: AuthUser): Promise<{ reviewer: boolean }> {
    return { reviewer: (await this.person(this.pool, user.id))?.reviewer === true };
  }

  /** Every case, for a security reviewer choosing what to ask for: references, disclosures and whether they hold a grant. */
  async cases(user: AuthUser): Promise<{ cases: SecurityCase[] }> {
    const me = await this.reviewer(this.pool, user);
    return { cases: await this.caseList(me.id) };
  }

  /** Every case, for the Administrators: project, item kind, reporter, state, waiting for the key, disclosures. */
  async adminCases(user: AuthUser): Promise<{ cases: SecurityCase[] }> {
    await this.admin(this.pool, user);
    return { cases: await this.caseList(null) };
  }

  // -------------------------------------------------------------------------------------------------------------
  // Reveal original, release unchanged
  // -------------------------------------------------------------------------------------------------------------

  /**
   * Reveal original (spec 7.6): the original text values of one item of the case, with each removed span marked.
   * The only answer that ever carries an original; the route sets Cache-Control: no-store.
   */
  async reveal(
    user: AuthUser,
    caseId: string,
    kind: string,
    itemId: string,
    body: { confirm: unknown },
  ): Promise<{ caseId: string; kind: ItemKind; itemId: string; notice: string; values: RevealedValue[] }> {
    return inTransaction(this.pool, async (db) => {
      const { me, grantId } = await this.holder(db, user, caseId);
      if (body.confirm !== true) throw new BadRequestException(CONFIRM_REVEAL);
      if (!ITEM_KINDS.includes(kind as ItemKind) || !UUID.test(itemId)) throw new NotFoundException();
      const c = (await db.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
      if (!c) throw new NotFoundException();
      const inCase = await db.query(
        `SELECT 1 FROM quarantine_items WHERE case_id = $1 AND item_kind = $2 AND item_id = $3
         UNION ALL SELECT 1 FROM quarantine_possible_copies WHERE case_id = $1 AND item_kind = $2 AND item_id = $3`,
        [caseId, kind, itemId],
      );
      if (!inCase.rowCount) throw new NotFoundException();
      if (!this.key) throw new ConflictException(WAITING_FOR_KEY);
      const values = await readOriginals(db, this.key, caseId, { kind: kind as ItemKind, id: itemId });
      const at = this.now();
      await db.query(
        `INSERT INTO quarantine_events (id, case_id, project_id, actor_id, action, item_kind, item_id, detail, at) VALUES ($1, $2, $3, $4, 'original_opened', $5, $6, $7, $8)`,
        [uuidv7(at.getTime()), caseId, c.projectId, me.id, kind, itemId, JSON.stringify({ grantId, values: values.length }), at],
      );
      await writeAudit(db, { at, action: 'quarantine.original_opened', actorUserId: me.id, subjectType: 'quarantine_case', subjectId: caseId, detail: { grantId, itemKind: kind } });
      return { caseId, kind: kind as ItemKind, itemId, notice: REVEAL_NOTICE, values };
    });
  }

  /**
   * Release unchanged (spec 7.6, Review Focus 4): every original of the open case goes back into place, except values
   * changed since cleaning, which are kept and listed. One top-level transaction; the case row is closed first.
   */
  async releaseUnchanged(
    user: AuthUser,
    caseId: string,
    body: { reason: unknown },
  ): Promise<{ caseId: string; state: 'released_unchanged'; restored: number; changed: ChangedValue[] }> {
    return inTransaction(this.pool, async (db) => {
      // The project's sweep lock first (C1), before the case row is locked or closed.
      if (UUID.test(caseId)) {
        const p = (await db.query<{ projectId: string }>(`SELECT project_id AS "projectId" FROM quarantine_cases WHERE id = $1`, [caseId])).rows[0];
        if (p) await lockSweeps(db, p.projectId);
      }
      const { me, grantId } = await this.holder(db, user, caseId);
      const c = (
        await db.query<{ id: string; projectId: string; kind: ItemKind; itemId: string; state: string }>(
          `SELECT id, project_id AS "projectId", item_kind AS kind, item_id AS "itemId", state FROM quarantine_cases WHERE id = $1 FOR UPDATE`,
          [caseId],
        )
      ).rows[0];
      if (!c) throw new NotFoundException();
      if (c.state !== 'held' && c.state !== 'cleaned') throw new ConflictException(CASE_CLOSED);
      if (!this.key) throw new ConflictException(WAITING_FOR_KEY);
      const reason = readReason(body.reason);
      const at = this.now();
      // Closed first, in this transaction and with no savepoint: the immutability exception accepts a case closed by
      // the current top-level transaction, so the originals can be written back next.
      await db.query(`UPDATE quarantine_cases SET state = 'released_unchanged', closed_at = $2, closed_by = $3, close_reason = $4 WHERE id = $1`, [c.id, at, me.id, reason]);
      const r = await restoreOriginals(db, this.key, c.id);
      const changed = r.changed.map((x) => ({ table: x.table, rowKey: safeKey(x.rowKey) }));

      // Holds end: the item, its confirmed copies, and every place found (masked or held for want of the key).
      await unhold(db, c.kind, c.itemId, c.id, at);
      const places = (
        await db.query<{ kind: ItemKind; id: string; decision: string | null }>(
          `SELECT item_kind AS kind, item_id AS id, NULL AS decision FROM quarantine_items WHERE case_id = $1 AND role = 'copy'
           UNION ALL SELECT item_kind, item_id, decision FROM quarantine_possible_copies WHERE case_id = $1`,
          [c.id],
        )
      ).rows;
      for (const p of places) await unhold(db, p.kind, p.id, c.id, at);
      // Places nobody decided: their text is back, so the release dismisses them.
      const undecided = (
        await db.query<{ kind: ItemKind; id: string }>(
          `UPDATE quarantine_possible_copies SET decision = 'dismissed', decided_by = $2, decided_at = $3 WHERE case_id = $1 AND decision IS NULL
           RETURNING item_kind AS kind, item_id AS id`,
          [c.id, me.id, at],
        )
      ).rows;
      const event = (action: string, e: { kind?: string; itemId?: string; reason?: string | null; detail: Record<string, unknown> }) =>
        db.query(
          `INSERT INTO quarantine_events (id, case_id, project_id, actor_id, action, item_kind, item_id, reason, detail, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [uuidv7(at.getTime()), c.id, c.projectId, action === 'notified' ? null : me.id, action, e.kind ?? null, e.itemId ?? null, e.reason ?? null, JSON.stringify(e.detail), at],
        );
      for (const p of undecided) await event('copy_dismissed', { kind: p.kind, itemId: p.id, detail: { auto: true } });
      await event('released_unchanged', { kind: c.kind, itemId: c.itemId, reason, detail: { grantId, restored: r.restored, changed } });

      const projectName = (await db.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [c.projectId])).rows[0].name;
      const told = await this.notify(db, await this.admins(db), {
        kind: 'quarantine_released_unchanged',
        urgent: false,
        summary: `A case held for a suspected credential in ${projectName} was released unchanged by a security reviewer as a false alarm.`,
        link: '#/security/cases',
        projectId: c.projectId,
        at,
      });
      await event('notified', { detail: { releasedUnchanged: told } });
      await writeAudit(db, { at, action: 'quarantine.released_unchanged', actorUserId: me.id, subjectType: 'quarantine_case', subjectId: c.id, detail: { projectId: c.projectId, itemKind: c.kind, grantId } });
      return { caseId: c.id, state: 'released_unchanged' as const, restored: r.restored, changed: changed.map((x) => ({ ...x, label: CHANGED_SINCE_CLEANING })) };
    });
  }
}
