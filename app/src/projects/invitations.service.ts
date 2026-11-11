import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, CODE_SENDER, type AuthUser, type Clock, type CodeSender } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { ProjectAccess } from './access.service';
import { ROLE_LABEL, canManageRole } from './matrix';
import { type ProjectRole, membershipState } from './membership';
import { MembershipsService, checkNewAppointment, cleanDates, cleanRole } from './memberships.service';
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
}

const COLUMNS = `id, project_id, email, display_name, role, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(expires_on, 'YYYY-MM-DD') AS expires_on, invited_by, issued_at, expires_at, status`;

@Injectable()
export class InvitationsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    @Inject(CODE_SENDER) private readonly sender: CodeSender,
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
      issuedAt: r.issued_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      status,
    };
  }

  private async issue(c: PoolClient, r: Omit<InvitationRow, 'id' | 'issued_at' | 'expires_at' | 'status'>, projectName: string, at: Date) {
    const token = randomBytes(32).toString('base64url');
    const id = uuidv7(at.getTime());
    const expiresAt = new Date(at.getTime() + VALID_FOR_MS);
    await c.query(
      `INSERT INTO invitations (id, project_id, email, display_name, role, starts_on, expires_on, invited_by, token_hash, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, r.project_id, r.email, r.display_name, r.role, r.starts_on, r.expires_on, r.invited_by, hashToken(token), at, expiresAt],
    );
    return { id, token, expiresAt };
  }

  private async deliver(email: string, token: string, projectName: string, role: ProjectRole, expiresAt: Date) {
    try {
      await this.sender.sendInvitation(email, `${this.config.appUrl}/#/invitations/${token}`, projectName, ROLE_LABEL[role], expiresAt);
    } catch {
      console.error('An invitation email could not be delivered');
    }
  }

  async invite(user: AuthUser, projectId: string, input: Record<string, unknown>) {
    const role = cleanRole(input.role);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new BadRequestException('Enter the email address to invite.');
    const displayName = typeof input.displayName === 'string' && input.displayName.trim() !== '' ? input.displayName.trim().slice(0, 200) : null;
    const at = this.now();
    let out: { id: string; token: string; expiresAt: Date; name: string };
    const result = await this.tx(async (c) => {
      const ctx = await this.access.context(user, projectId, c, true);
      const v = canManageRole({ target: role, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via: 'invitation' });
      if (!v.allowed) throw new ForbiddenException(v.reason);
      if (!(await this.org.isEligible(email))) throw new BadRequestException('That address is not in an eligible organisation domain.');
      const { startsOn, expiresOn } = cleanDates(ctx.project.createdOn, input.startsOn, input.expiresOn);
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
      out = { ...issued, name };
      await writeAudit(c, { at, action: 'invitation.issued', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { invitationId: issued.id, role } });
      const row = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1`, [issued.id])).rows[0] as InvitationRow;
      return { invitation: this.view(row, at) };
    });
    await this.deliver(email, out!.token, out!.name, role, out!.expiresAt);
    return result;
  }

  private async loadForManager(c: PoolClient, user: AuthUser, invitationId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(invitationId)) throw new NotFoundException();
    const r = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1 FOR UPDATE`, [invitationId])).rows[0] as InvitationRow | undefined;
    if (!r) throw new NotFoundException();
    const ctx = await this.access.context(user, r.project_id, c, true);
    const v = canManageRole({ target: r.role, roles: ctx.roles, isAdmin: ctx.isAdmin, status: ctx.project.status, via: 'invitation' });
    if (!v.allowed) throw new ForbiddenException(v.reason);
    return { r, ctx };
  }

  /** A new invitation with the same details; the old link stops working. Earlier history is kept. */
  async resend(user: AuthUser, invitationId: string) {
    const at = this.now();
    let out: { token: string; expiresAt: Date; name: string; email: string; role: ProjectRole };
    const result = await this.tx(async (c) => {
      const { r } = await this.loadForManager(c, user, invitationId);
      if (r.status !== 'invited') throw new ConflictException('Only an unanswered invitation can be sent again.');
      const name = (await c.query(`SELECT name FROM projects WHERE id = $1`, [r.project_id])).rows[0].name as string;
      const issued = await this.issue(c, { ...r, invited_by: user.id }, name, at);
      await c.query(`UPDATE invitations SET status = 'replaced', replaced_by = $2 WHERE id = $1`, [r.id, issued.id]);
      await writeAudit(c, { at, action: 'invitation.resent', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: issued.id, replaces: r.id } });
      out = { token: issued.token, expiresAt: issued.expiresAt, name, email: r.email, role: r.role };
      const row = (await c.query(`SELECT ${COLUMNS} FROM invitations WHERE id = $1`, [issued.id])).rows[0] as InvitationRow;
      return { invitation: this.view(row, at) };
    });
    await this.deliver(out!.email, out!.token, out!.name, out!.role, out!.expiresAt);
    return result;
  }

  async revoke(user: AuthUser, invitationId: string) {
    const at = this.now();
    return this.tx(async (c) => {
      const { r } = await this.loadForManager(c, user, invitationId);
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
    return { invitation: { projectName, email: v.email, role: v.role, startsOn: v.startsOn, expiresOn: v.expiresOn, expiresAt: v.expiresAt, status: v.status } };
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
      const candidate = { userId: user.id, role: r.role, startsOn: r.starts_on, expiresOn: r.expires_on, revokedAt: null };
      checkNewAppointment(ctx, candidate);
      const membershipId = await this.memberships.insertAppointment(c, ctx, candidate, user.id, 'Accepted an invitation', at);
      await c.query(`UPDATE invitations SET status = 'accepted', responded_at = $2, membership_id = $3 WHERE id = $1`, [r.id, at, membershipId]);
      await writeAudit(c, { at, action: 'invitation.accepted', actorUserId: user.id, subjectType: 'project', subjectId: r.project_id, detail: { invitationId: r.id } });
      return { membership: { id: membershipId, projectId: r.project_id, role: r.role, startsOn: r.starts_on, expiresOn: r.expires_on, state: membershipState(candidate, ctx.today) } };
    });
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
