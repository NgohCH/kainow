import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { UUID, uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { invitationEmail } from '../email/messages';
import { EMAIL_NUDGE, type EmailNudge } from '../email/nudge';
import { writeOutbox } from '../email/outbox';
import { ProjectAccess } from './access.service';
import { ROLE_LABEL, canManageRole } from './matrix';
import { type ProjectRole, membershipState } from './membership';
import { MembershipsService, checkMembershipsAfter, checkNewAppointment, cleanDates, cleanRole } from './memberships.service';
import { OrganisationService } from './organisation.service';

const VALID_FOR_MS = 7 * 24 * 60 * 60 * 1000;
const NO_LONGER_VALID = 'This invitation link is no longer valid.';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

interface InvitationRow {
  id: string;
  project_id: string;
  email: string;
  display_name: string | null;
  role: ProjectRole;
  starts_on: string;
  expires_on: string | null;
  invited_by: string;
  issued_at: Date;
  expires_at: Date;
  status: string;
  kind: 'role' | 'handover';
  outgoing_membership_id: string | null;
  outgoing_role: 'deputy_pm' | 'member' | 'leave' | null;
}

const OUTGOING_ROLES = ['deputy_pm', 'member', 'leave'] as const;
const HANDOVER_GONE = 'This handover is no longer valid.';
const ALREADY_ENDED = 'That membership would already have ended.';

const COLUMNS = `id, project_id, email, display_name, role, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(expires_on, 'YYYY-MM-DD') AS expires_on, invited_by, issued_at, expires_at, status, kind, outgoing_membership_id, outgoing_role`;

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(EMAIL_NUDGE) private readonly nudge: EmailNudge,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly access: ProjectAccess,
    private readonly org: OrganisationService,
    private readonly memberships: MembershipsService,
  ) {}

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await work(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** What a manager sees of an invitation: never the token. Expired is worked out from the expiry time. */
  view(r: InvitationRow, now: Date) {
    const status = r.status === 'invited' && r.expires_at <= now ? 'expired' : r.status;
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      startsOn: r.starts_on,
      expiresOn: r.expires_on,
      kind: r.kind,
      outgoingRole: r.outgoing_role,
      issuedAt: r.issued_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      status,
    };
  }

  private async issue(
    c: PoolClient,
    r: Omit<InvitationRow, 'id' | 'issued_at' | 'expires_at' | 'status' | 'kind' | 'outgoing_membership_id' | 'outgoing_role'> &
      Partial<Pick<InvitationRow, 'kind' | 'outgoing_membership_id' | 'outgoing_role'>>,
    projectName: string,
    at: Date,
  ) {
    const token = randomBytes(32).toString('base64url');
    const id = uuidv7(at.getTime());
    const expiresAt = new Date(at.getTime() + VALID_FOR_MS);
    await c.query(
      `INSERT INTO invitations (id, project_id, email, display_name, role, starts_on, expires_on, invited_by, token_hash, issued_at, expires_at,
                                kind, outgoing_membership_id, outgoing_role)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [id, r.project_id, r.email, r.display_name, r.role, r.starts_on, r.expires_on, r.invited_by, hashToken(token), at, expiresAt,
        r.kind ?? 'role', r.outgoing_membership_id ?? null, r.outgoing_role ?? null],
    );
    return { id, token, expiresAt };
  }

  /**
   * Queues the invitation email in the caller's transaction, so it exists exactly when the invitation does. The invitee may
   * have no account, so no recipient user is named and no eligibility is checked before sending; the invitation itself
   * must still be open and unexpired at each attempt.
   */
  private async queueEmail(
    c: PoolClient,
    invite: { invitationId: string; email: string; token: string; projectId: string; projectName: string; role: ProjectRole; expiresAt: Date; actorId: string },
    at: Date,
  ): Promise<void> {
    const m = invitationEmail(invite.projectName, ROLE_LABEL[invite.role], `${this.config.appUrl}/#/invitations/${invite.token}`, invite.expiresAt);
    await writeOutbox(c, {
      toUserId: null,
      toAddress: invite.email,
      subject: m.subject,
      body: m.body,
      kind: 'invitation',
      projectId: invite.projectId,
      initiatedBy: 'person',
      initiatedByUser: invite.actorId,
      // A revoked, replaced, answered or expired invitation's email is not sent (its link would be dead).
      relevance: { kind: 'invitation', invitationId: invite.invitationId },
      now: at,
    });
  }

  /** Tells the email worker there is something to send, after the transaction has committed. Always true: the email is queued. */
  private async deliver(): Promise<boolean> {
    try {
      await this.nudge.nudge();
    } catch {
      // The email is committed; the scheduled email tick still finds it.
      console.error('Could not nudge the email worker after an invitation; the scheduled tick still sends it');
    }
    return true;
  }

  async invite(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const role = cleanRole(input.role);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new BadRequestException('Enter the email address to invite.');
    const displayName = typeof input.displayName === 'string' && input.displayName.trim() !== '' ? input.displayName.trim().slice(0, 200) : null;
    const at = this.now();
    const result = await this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      const v = canManageRole({ target: role, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via: 'invitation' });
      if (!v.allowed) throw new ForbiddenException(v.reason);
      if (!(await this.org.isEligible(email))) throw new BadRequestException('That address is not in an eligible organisation domain.');
      const { startsOn, expiresOn } = cleanDates(ctx.project.createdOn, input.startsOn, input.expiresOn);
      if (expiresOn !== null && expiresOn < ctx.today) throw new BadRequestException(ALREADY_ENDED);
      const waiting = await c.query(
        `SELECT 1 FROM invitations WHERE project_id = $1 AND email = $2 AND role = $3 AND kind = 'role' AND status = 'invited' AND expires_at > $4`,
        [projectId, email, role, at],
      );
      if (waiting.rowCount) throw new ConflictException('An invitation is already waiting; send it again instead.');
      const existing = (await c.query(`SELECT id FROM users WHERE email = $1`, [email])).rows[0];
      // A new Owner or Project Manager replaces the current one when the invitation is accepted.
      if (existing) checkNewAppointment(ctx, { userId: existing.id, role, startsOn, expiresOn, revokedAt: null });
      const name = (await c.query(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name as string;
      const issued = await this.issue(
        c,
        { project_id: projectId, email, display_name: displayName, role, starts_on: startsOn, expires_on: expiresOn, invited_by: user.id },
        name,
        at,
      );
      await this.queueEmail(c, { invitationId: issued.id, email, token: issued.token, projectId, projectName: name, role, expiresAt: issued.expiresAt, actorId: user.id }, at);
      await writeAudit(c, { at, action: 'invitation.issued', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { invitationId: issued.id, role } });
      const row = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1`, [issued.id])).rows[0] as InvitationRow;
      return { invitation: this.view(row, at) };
    });
    return { ...result, delivered: await this.deliver() };
  }

  /**
   * A Member invitation issued inside the caller's transaction (authorising a task for someone not yet in the
   * project). Reuses an open invitation to the same address; the email is queued in the same transaction and
   * `deliver` (after commit) nudges the email worker.
   */
  async issueMemberInvitation(c: PoolClient, projectId: string, email: string, actorId: string, startsOn: string, at: Date) {
    if (!(await this.org.isEligible(email))) throw new BadRequestException('That address is not in an eligible organisation domain.');
    const waiting = (
      await c.query(
        `SELECT id FROM invitations WHERE project_id = $1 AND email = $2 AND role = 'member' AND kind = 'role' AND status = 'invited' AND expires_at > $3`,
        [projectId, email, at],
      )
    ).rows[0];
    if (waiting) return { id: waiting.id as string, deliver: async () => true };
    const name = (await c.query(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name as string;
    const issued = await this.issue(
      c,
      { project_id: projectId, email, display_name: null, role: 'member', starts_on: startsOn, expires_on: null, invited_by: actorId },
      name,
      at,
    );
    await this.queueEmail(c, { invitationId: issued.id, email, token: issued.token, projectId, projectName: name, role: 'member', expiresAt: issued.expiresAt, actorId }, at);
    await writeAudit(c, { at, action: 'invitation.issued', actorUserId: actorId, subjectType: 'project', subjectId: projectId, detail: { invitationId: issued.id, role: 'member', forTask: true } });
    return { id: issued.id, deliver: () => this.deliver() };
  }

  private async loadForManager(c: PoolClient, user: AuthUser, invitationId: string, via: 'invitation' | 'appointment' = 'invitation') {
    if (!UUID.test(invitationId)) throw new NotFoundException();
    const r = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1 FOR UPDATE`, [invitationId])).rows[0] as InvitationRow | undefined;
    if (!r) throw new NotFoundException();
    const ctx = await this.access.context(user, r.project_id, c, true);
    const outgoing = r.kind === 'handover' ? ctx.rows.find((m) => m.id === r.outgoing_membership_id) : undefined;
    if (outgoing && outgoing.userId === user.id) return { r, ctx };
    const v = canManageRole({ target: r.role, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via });
    if (!v.allowed) throw new ForbiddenException(v.reason);
    return { r, ctx };
  }

  /** A new invitation with the same details; the old link stops working. Earlier history is kept. */
  async resend(user: AuthUser, invitationId: string) {
    const at = this.now();
    const result = await this.tx(async (c) => {
      const { r } = await this.loadForManager(c, user, invitationId);
      if (r.status !== 'invited') throw new ConflictException('Only an unanswered invitation can be sent again.');
      const name = (await c.query(`SELECT name FROM projects WHERE id = $1`, [r.project_id])).rows[0].name as string;
      const issued = await this.issue(c, { ...r, invited_by: user.id }, name, at);
      await c.query(`UPDATE invitations SET status = 'replaced', replaced_by = $2 WHERE id = $1`, [r.id, issued.id]);
      await writeAudit(c, { at, action: 'invitation.resent', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: issued.id, replaces: r.id } });
      await this.queueEmail(c, { invitationId: issued.id, email: r.email, token: issued.token, projectId: r.project_id, projectName: name, role: r.role, expiresAt: issued.expiresAt, actorId: user.id }, at);
      const row = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1`, [issued.id])).rows[0] as InvitationRow;
      return { invitation: this.view(row, at) };
    });
    return { ...result, delivered: await this.deliver() };
  }

  async revoke(user: AuthUser, invitationId: string) {
    const at = this.now();
    return this.tx(async (c) => {
      const { r } = await this.loadForManager(c, user, invitationId, 'appointment');
      if (r.status !== 'invited') throw new ConflictException('Only an unanswered invitation can be revoked.');
      await c.query(`UPDATE invitations SET status = 'revoked', responded_at = $2 WHERE id = $1`, [r.id, at]);
      await writeAudit(c, { at, action: 'invitation.revoked', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: r.id } });
      return { invitation: this.view({ ...r, status: 'revoked' }, at) };
    });
  }

  /** What the invitation page shows before sign-in: the invitation only, nothing else of the project. */
  async byToken(token: string) {
    const r = (await this.pool.query(`SELECT ${COLUMNS} FROM invitations WHERE token_hash = $1`, [hashToken(String(token))])).rows[0] as InvitationRow | undefined;
    if (!r) throw new NotFoundException(NO_LONGER_VALID);
    const projectName = (await this.pool.query(`SELECT name FROM projects WHERE id = $1`, [r.project_id])).rows[0].name;
    const v = this.view(r, this.now());
    return {
      invitation: { projectName, email: v.email, role: v.role, kind: v.kind, startsOn: v.startsOn, expiresOn: v.expiresOn, expiresAt: v.expiresAt, status: v.status },
    };
  }

  /** Locks the invitation and its project and checks it can still be answered by this person. */
  private async loadForAnswer(c: PoolClient, user: AuthUser, token: string, at: Date) {
    const r = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE token_hash = $1 FOR UPDATE`, [hashToken(String(token))])).rows[0] as InvitationRow | undefined;
    if (!r || r.status !== 'invited') throw new ConflictException(NO_LONGER_VALID);
    if (r.expires_at <= at) throw new ConflictException('This invitation has expired. Ask for a new one.');
    if (user.email.toLowerCase() !== r.email) throw new ForbiddenException('This invitation was sent to a different email address.');
    return r;
  }

  async accept(user: AuthUser, token: string) {
    const at = this.now();
    return this.tx(async (c) => {
      const r = await this.loadForAnswer(c, user, token, at);
      const ctx = await this.access.load(r.project_id, user, c, true);
      if (!ctx) throw new ConflictException(NO_LONGER_VALID);
      if (ctx.project.status === 'deferred' || ctx.project.status === 'closed') {
        throw new ConflictException('Invitations cannot be accepted while the project is Deferred or Closed.');
      }
      if (!(await this.org.isEligible(r.email))) throw new ConflictException('That address is not in an eligible organisation domain.');
      // The account may have been disabled after this request was let in; check again now the project is locked.
      const account = (await c.query(`SELECT status FROM users WHERE id = $1`, [user.id])).rows[0];
      if (account?.status === 'disabled') throw new ForbiddenException('This account is disabled.');
      if (r.kind === 'handover') return this.acceptHandover(c, ctx, r, user, at);
      if (r.expires_on !== null && r.expires_on < ctx.today) throw new ConflictException(ALREADY_ENDED);
      const candidate = { userId: user.id, role: r.role, startsOn: r.starts_on, expiresOn: r.expires_on, revokedAt: null };
      checkNewAppointment(ctx, candidate);
      const membershipId = await this.memberships.insertAppointment(c, ctx, candidate, user.id, 'Accepted an invitation', at);
      await c.query(`UPDATE invitations SET status = 'accepted', responded_at = $2, membership_id = $3 WHERE id = $1`, [r.id, at, membershipId]);
      await writeAudit(c, { at, action: 'invitation.accepted', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: r.id } });
      return { membership: { id: membershipId, projectId: r.project_id, role: r.role, startsOn: r.starts_on, expiresOn: r.expires_on, state: membershipState(candidate, ctx.today) } };
    });
  }

  /**
   * The current, Active Project Manager hands the project over (V1.0 role management §2): the replacement
   * accepts through the usual link, and only then does the switch happen.
   */
  async handover(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new BadRequestException('Enter the email address of the person taking over.');
    const outgoingRole = input.outgoingRole as (typeof OUTGOING_ROLES)[number];
    if (!OUTGOING_ROLES.includes(outgoingRole)) throw new BadRequestException('Choose your role afterwards: deputy_pm, member or leave.');
    const displayName = typeof input.displayName === 'string' && input.displayName.trim() !== '' ? input.displayName.trim().slice(0, 200) : null;
    const at = this.now();
    const result = await this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      const mine = ctx.rows.find((m) => m.userId === user.id && m.role === 'pm' && membershipState(m, ctx.today) === 'active');
      if (!mine) throw new ForbiddenException('Only the current Project Manager can hand over the project.');
      if (!['draft', 'planned', 'active'].includes(ctx.project.status)) {
        throw new ConflictException('A handover can only be made while the project is Draft, Planned or Active.');
      }
      if (email === user.email.toLowerCase()) throw new BadRequestException('Choose someone else to take over.');
      if (!(await this.org.isEligible(email))) throw new BadRequestException('That address is not in an eligible organisation domain.');
      const open = await c.query(`SELECT 1 FROM invitations WHERE project_id = $1 AND kind = 'handover' AND status = 'invited' AND expires_at > $2`, [projectId, at]);
      if (open.rowCount) throw new ConflictException('A handover is already waiting; send it again or withdraw it.');
      const name = (await c.query(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name as string;
      const issued = await this.issue(
        c,
        {
          project_id: projectId, email, display_name: displayName, role: 'pm', starts_on: ctx.today, expires_on: null, invited_by: user.id,
          kind: 'handover', outgoing_membership_id: mine.id, outgoing_role: outgoingRole,
        },
        name,
        at,
      );
      await this.queueEmail(c, { invitationId: issued.id, email, token: issued.token, projectId, projectName: name, role: 'pm', expiresAt: issued.expiresAt, actorId: user.id }, at);
      await writeAudit(c, { at, action: 'invitation.handover_issued', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { invitationId: issued.id, outgoingRole } });
      const row = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1`, [issued.id])).rows[0] as InvitationRow;
      return { invitation: this.view(row, at) };
    });
    return { ...result, delivered: await this.deliver() };
  }

  /** The switch, in one transaction: outgoing PM revoked ("Handed over"), replacement PM from today, chosen role appointed. */
  private async acceptHandover(c: PoolClient, ctx: Awaited<ReturnType<ProjectAccess['context']>>, r: InvitationRow, user: AuthUser, at: Date) {
    const outgoing = ctx.rows.find((m) => m.id === r.outgoing_membership_id);
    if (!outgoing || outgoing.role !== 'pm' || membershipState(outgoing, ctx.today) !== 'active') throw new ConflictException(HANDOVER_GONE);
    const today = ctx.today;
    const incoming = { userId: user.id, role: 'pm' as const, startsOn: today, expiresOn: null, revokedAt: null };
    const keeps = r.outgoing_role !== 'leave' && r.outgoing_role !== null
      && !ctx.rows.some((m) => m.userId === outgoing.userId && m.role === r.outgoing_role && !m.revokedAt);
    const disposition = keeps ? { userId: outgoing.userId, role: r.outgoing_role as 'deputy_pm' | 'member', startsOn: today, expiresOn: null, revokedAt: null } : null;
    if (ctx.rows.some((m) => m.userId === user.id && m.role === 'pm' && !m.revokedAt)) throw new ConflictException(HANDOVER_GONE);
    const after = [
      ...ctx.rows.map((m) => (m.id === outgoing.id ? { ...m, revokedAt: at } : m)),
      incoming,
      ...(disposition ? [disposition] : []),
    ];
    checkMembershipsAfter(ctx, after);
    await c.query(`UPDATE memberships SET revoked_at = $2, revoked_by = $3, revoke_reason = 'Handed over' WHERE id = $1`, [outgoing.id, at, user.id]);
    await c.query(
      `INSERT INTO membership_events (id, membership_id, kind, previous_starts_on, previous_expires_on, actor_id, reason, at)
       VALUES ($1, $2, 'revoked', $3, $4, $5, 'Handed over', $6)`,
      [uuidv7(at.getTime()), outgoing.id, outgoing.startsOn, outgoing.expiresOn, user.id, at],
    );
    const ctxAfter = { ...ctx, rows: ctx.rows.map((m) => (m.id === outgoing.id ? { ...m, revokedAt: at } : m)) };
    const membershipId = await this.memberships.insertAppointment(c, ctxAfter, incoming, user.id, 'Accepted a handover', at);
    if (disposition) await this.memberships.insertAppointment(c, ctxAfter, disposition, r.invited_by, 'Role after handing over', at);
    await c.query(`UPDATE invitations SET status = 'accepted', responded_at = $2, membership_id = $3 WHERE id = $1`, [r.id, at, membershipId]);
    await writeAudit(c, { at, action: 'invitation.handover_accepted', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: r.id } });
    return { membership: { id: membershipId, projectId: r.project_id, role: 'pm' as const, startsOn: today, expiresOn: null, state: 'active' as const } };
  }

  async decline(user: AuthUser, token: string) {
    const at = this.now();
    return this.tx(async (c) => {
      const r = await this.loadForAnswer(c, user, token, at);
      await c.query(`UPDATE invitations SET status = 'declined', responded_at = $2 WHERE id = $1`, [r.id, at]);
      await writeAudit(c, { at, action: 'invitation.declined', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: r.id } });
      return { invitation: { status: 'declined' } };
    });
  }

  /** Invitations of a project, for its People tab. */
  async listForProject(c: Pool | PoolClient, projectId: string) {
    const now = this.now();
    const { rows } = await c.query(`SELECT ${COLUMNS} FROM invitations WHERE project_id = $1 ORDER BY issued_at DESC, id`, [projectId]);
    return (rows as InvitationRow[]).map((r) => this.view(r, now));
  }
}
