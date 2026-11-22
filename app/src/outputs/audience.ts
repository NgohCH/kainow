import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import type { AudienceChange } from '../discussion/audience';
import { NAMED_OUTSIDE } from '../discussion/audience.service';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { decide } from '../projects/matrix';
import { endOutputApprovalRequests } from './approval-handler';
import { type OutputAccessRow, contentReaderContexts, inReview, loadOutputAccessRow, readersOfRow, readsRemainingMaterial, remainingMaterialReaders } from './readers';
import { queueOutputPlacement } from './sharing-queue';

type Db = Pool | PoolClient;

export const MUST_RESTRICT = 'This output uses material some of the project’s readers cannot read, so it must be Restricted to people who can read it.';
export const OUTSIDE_MATERIAL = 'Only people who can read all the material this output was built from can be in its audience.';
const NAME_SOMEONE = 'Name at least one person for a Restricted audience.';
const NOTHING_TO_CHANGE = 'Nothing to change.';
const CLOSED_OUTPUT = 'A declined or withdrawn output cannot be changed.';
const NOT_IN_REVIEW = 'This output is not waiting for an access review.';
const NOT_MATERIAL_READER = 'Only people who can read all the material this output was built from can change who may read it.';
export const NARROW_BEFORE_CLEARING = 'Some people in this output’s audience can no longer read the material it was built from. Narrow its audience to people who can read it before clearing the review.';

/** What changing the audience would do (or did): who gains and who loses access, by name then id. */
export interface AudienceEffect {
  gaining: Array<{ id: string; name: string }>;
  losing: Array<{ id: string; name: string }>;
}

/** An output's audience as asked for: Project-wide, or Restricted to the named people. */
export type OutputAudienceInput = { kind: 'project' } | { kind: 'restricted'; userIds: string[] };

/** A change of a sub-project 4a audience row, in `audience_events`. */
async function audienceEvent(
  c: PoolClient,
  audienceId: string,
  actorId: string,
  from: { mode: 'project' | 'restricted'; named: string[] },
  to: { mode: 'project' | 'restricted'; named: string[] },
  reason: string,
  at: Date,
): Promise<void> {
  await c.query(
    `INSERT INTO audience_events (id, audience_id, actor_id, from_mode, to_mode, from_named, to_named, reason, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [uuidv7(at.getTime()), audienceId, actorId, from.mode, to.mode, from.named, to.named, reason, at],
  );
}

/** A new Restricted audience (sub-project 4a row) for an output, recorded as a change from Project-wide. */
export async function createOutputAudience(c: PoolClient, projectId: string, people: string[], actorId: string, at: Date, reason: string): Promise<string> {
  const id = uuidv7(at.getTime());
  await c.query(`INSERT INTO audiences (id, project_id, mode, created_at) VALUES ($1, $2, 'restricted', $3)`, [id, projectId, at]);
  for (const userId of people) {
    await c.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4)`, [id, userId, actorId, at]);
  }
  await audienceEvent(c, id, actorId, { mode: 'project', named: [] }, { mode: 'restricted', named: people }, reason, at);
  return id;
}

/**
 * Checks an audience against the output's material (D101): Project-wide only when everyone who reads the project can
 * read the material; a Restricted audience names at least one current reader of the project, each of whom can read the
 * material. `material` is null when the output has no Kainow material (uploads and links: the PM's choice).
 */
export function checkOutputAudience(change: AudienceChange, readers: Set<string>, material: Set<string> | null): void {
  if (change.mode === 'project') {
    if (material && [...readers].some((id) => !material.has(id))) throw new BadRequestException(MUST_RESTRICT);
    return;
  }
  if (change.namedUserIds.length === 0) throw new BadRequestException(NAME_SOMEONE);
  for (const id of change.namedUserIds) {
    if (!readers.has(id)) throw new BadRequestException(NAMED_OUTSIDE);
    if (material && !material.has(id)) throw new BadRequestException(OUTSIDE_MATERIAL);
  }
}

/**
 * Writes an output's audience (checked by `checkOutputAudience` first): Project-wide sets `audience_id` NULL (an
 * earlier Restricted row becomes Project-wide); Restricted reuses its row or creates one. Every change is recorded in
 * `audience_events`; a Registered output then has its files placed where its readers need them and its folder synced
 * (spec 5.5): narrowing moves the files out of the project folder first, urgently. Returns the mode now set.
 */
export async function writeOutputAudience(c: PoolClient, row: OutputAccessRow, change: AudienceChange, actorId: string, at: Date, reason: string): Promise<'project' | 'restricted'> {
  const place = (direction: 'narrow' | 'widen') => (row.status === 'registered' ? queueOutputPlacement(c, row.id, direction) : Promise.resolve());
  if (change.mode === 'project') {
    if (row.audienceId && row.audienceMode === 'restricted') {
      await c.query(`UPDATE audiences SET mode = 'project' WHERE id = $1`, [row.audienceId]);
      await c.query(`DELETE FROM audience_members WHERE audience_id = $1`, [row.audienceId]);
      await audienceEvent(c, row.audienceId, actorId, { mode: 'restricted', named: row.audienceUserIds }, { mode: 'project', named: [] }, reason, at);
    }
    if (row.audienceId) await c.query(`UPDATE outputs SET audience_id = NULL WHERE id = $1`, [row.id]);
    if (row.audienceMode === 'restricted') await place('widen');
    return 'project';
  }
  const named = [...change.namedUserIds].sort();
  if (row.audienceId && row.audienceMode === 'restricted') {
    const before = row.audienceUserIds;
    if (before.length === named.length && before.every((id) => named.includes(id))) return 'restricted';
    await c.query(`DELETE FROM audience_members WHERE audience_id = $1 AND NOT (user_id = ANY($2::uuid[]))`, [row.audienceId, named]);
    for (const id of named.filter((x) => !before.includes(x))) {
      await c.query(`INSERT INTO audience_members (audience_id, user_id, added_by, added_at) VALUES ($1, $2, $3, $4)`, [row.audienceId, id, actorId, at]);
    }
    await audienceEvent(c, row.audienceId, actorId, { mode: 'restricted', named: before }, { mode: 'restricted', named }, reason, at);
    await place(before.some((id) => !named.includes(id)) ? 'narrow' : 'widen');
    return 'restricted';
  }
  const audienceId = await createOutputAudience(c, row.projectId, named, actorId, at, reason);
  await c.query(`UPDATE outputs SET audience_id = $2 WHERE id = $1`, [row.id, audienceId]);
  await place('narrow');
  return 'restricted';
}

/**
 * Withdraws a Submitted or Registered output (spec 4.3; a final state), in the caller's transaction with the output
 * row locked: Withdrawn, a `withdrawn` event with the reason, its pending approval requests ended (CF8), and, for a
 * Registered output, its files moved to its output folder, which has no Kainow grants (spec 5.5), urgently.
 */
export async function withdrawOutput(c: PoolClient, outputId: string, actorId: string, reason: string, at: Date): Promise<void> {
  const { status } = (await c.query<{ status: string }>(`SELECT status FROM outputs WHERE id = $1`, [outputId])).rows[0];
  if (status !== 'submitted' && status !== 'registered') throw new ConflictException(CLOSED_OUTPUT);
  await c.query(`UPDATE outputs SET status = 'withdrawn' WHERE id = $1`, [outputId]);
  await c.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, 'withdrawn', $3, $4, $5, $6)`, [
    uuidv7(at.getTime()), outputId, actorId, at, reason, JSON.stringify({ from: status }),
  ]);
  await endOutputApprovalRequests(c, outputId, actorId, at);
  if (status === 'registered') await queueOutputPlacement(c, outputId, 'narrow');
  await writeAudit(c, { at, action: 'output.withdrawn', actorUserId: actorId, subjectType: 'output', subjectId: outputId, detail: { from: status } });
}

const sameAudience = (row: OutputAccessRow, change: AudienceChange): boolean =>
  change.mode === 'project'
    ? row.audienceMode !== 'restricted'
    : row.audienceMode === 'restricted' && row.audienceUserIds.length === new Set(change.namedUserIds).size && change.namedUserIds.every((id) => row.audienceUserIds.includes(id));

/**
 * Changing who may read an output (D101, spec 4.5, 11): the PM, the Owner or a Sponsor among its readers who can read
 * all its material; and the "Access review required" decisions of the same people, Clear or Withdraw.
 */
@Injectable()
export class OutputAudienceService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly access: ProjectAccess,
  ) {}

  /**
   * Sets the audience with a reason, or (`preview`) only says who would gain and who would lose access. The audience
   * may name only current readers of the project who can read all the output's remaining material; Project-wide only
   * when all of them can. Kainow's access changes at once; SharePoint follows through the queued placement and sync.
   */
  async setOutputAudience(user: AuthUser, projectId: string, outputId: string, input: OutputAudienceInput, reasonInput: unknown, preview: boolean): Promise<AudienceEffect> {
    const change: AudienceChange = input.kind === 'project' ? { mode: 'project', namedUserIds: [] } : { mode: 'restricted', namedUserIds: [...new Set(input.userIds)] };
    const at = this.clock();
    if (preview) {
      const { row } = await this.mayChange(this.pool, user, projectId, outputId);
      await this.check(this.pool, row, change, at);
      return this.effect(this.pool, row, change, at);
    }
    const reason = readReason(reasonInput);
    await this.mayChange(this.pool, user, projectId, outputId);
    let effect: AudienceEffect = { gaining: [], losing: [] };
    await this.tx(async (c) => {
      const { row } = await this.mayChange(c, user, projectId, outputId, true);
      await this.check(c, row, change, at);
      if (sameAudience(row, change)) throw new BadRequestException(NOTHING_TO_CHANGE);
      effect = await this.effect(c, row, change, at);
      const mode = await writeOutputAudience(c, row, change, user.id, at, reason);
      const detail = { from: row.audienceMode, to: mode, gaining: effect.gaining.length, losing: effect.losing.length };
      await c.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, 'audience_changed', $3, $4, $5, $6)`, [
        uuidv7(at.getTime()), outputId, user.id, at, reason, JSON.stringify(detail),
      ]);
      await writeAudit(c, { at, action: 'output.audience_changed', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail });
    });
    return effect;
  }

  /** "Access review required" cleared: the output goes back to its audience (review state `cleared`). */
  async clearReview(user: AuthUser, projectId: string, outputId: string, reasonInput: unknown): Promise<void> {
    const reason = readReason(reasonInput);
    await this.mayChange(this.pool, user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { row } = await this.mayChange(c, user, projectId, outputId, true);
      if (!inReview(row)) throw new ConflictException(NOT_IN_REVIEW);
      // Clearing returns the output to its audience: only once everyone in it can read the remaining material.
      if (!(await this.audienceFitsMaterial(c, row, at))) throw new ConflictException(NARROW_BEFORE_CLEARING);
      await c.query(`UPDATE outputs SET review_state = 'cleared' WHERE id = $1`, [outputId]);
      await c.query(`INSERT INTO output_events (id, output_id, kind, actor_id, at, reason) VALUES ($1, $2, 'review_cleared', $3, $4, $5)`, [uuidv7(at.getTime()), outputId, user.id, at, reason]);
      if (row.status === 'registered') await queueOutputPlacement(c, outputId, 'widen');
      await writeAudit(c, { at, action: 'output.review_cleared', actorUserId: user.id, subjectType: 'output', subjectId: outputId });
    });
  }

  /** "Access review required" ended by withdrawing the output (a final state). */
  async withdrawForReview(user: AuthUser, projectId: string, outputId: string, reasonInput: unknown): Promise<void> {
    const reason = readReason(reasonInput);
    await this.mayChange(this.pool, user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { row } = await this.mayChange(c, user, projectId, outputId, true);
      if (!inReview(row)) throw new ConflictException(NOT_IN_REVIEW);
      await withdrawOutput(c, outputId, user.id, reason, at);
    });
  }

  /**
   * The output for someone who may change its audience or decide its review (spec 11: "PM, Owner or Sponsor in the
   * material's readers"): 404 unless they may read the project's content and the output exists there (not deleted or
   * held); 403 unless they hold `output.audience`; 403 unless they can read all its remaining material; 409 when it is
   * Declined or Withdrawn. Being in the output's own audience is not required: a Restricted audience may name no
   * manager at all. With `lock`, the project and output rows are locked.
   */
  private async mayChange(db: Db, user: AuthUser, projectId: string, outputId: string, lock = false): Promise<{ ctx: ProjectContext; row: OutputAccessRow }> {
    if (!UUID.test(outputId)) throw new NotFoundException();
    const ctx = await this.access.context(user, projectId, db, lock);
    if (!canReadContent(ctx)) throw new NotFoundException();
    if (lock) await db.query(`SELECT 1 FROM outputs WHERE id = $1 FOR UPDATE`, [outputId]);
    const row = await loadOutputAccessRow(db, outputId);
    if (!row || row.projectId !== projectId || row.deletedAt || row.heldCaseId) throw new NotFoundException();
    const verdict = decide({ action: 'output.audience', roles: ctx.roles, status: ctx.project.status });
    if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
    if (!(await readsRemainingMaterial(db, ctx, row))) throw new ForbiddenException(NOT_MATERIAL_READER);
    if (row.status !== 'submitted' && row.status !== 'registered') throw new ConflictException(CLOSED_OUTPUT);
    return { ctx, row };
  }

  /** Whether everyone the output's audience lets in (today's content readers within it) can read its remaining material. */
  private async audienceFitsMaterial(db: Db, row: OutputAccessRow, at: Date): Promise<boolean> {
    const material = await remainingMaterialReaders(db, row, at);
    if (!material) return true;
    const readers = (await contentReaderContexts(db, row.projectId, at)).map((r) => r.viewerId);
    const inAudience = row.audienceMode === 'restricted' ? readers.filter((id) => row.audienceUserIds.includes(id)) : readers;
    return inAudience.every((id) => material.has(id));
  }

  private async check(db: Db, row: OutputAccessRow, change: AudienceChange, at: Date): Promise<void> {
    const readers = new Set((await contentReaderContexts(db, row.projectId, at)).map((r) => r.viewerId));
    checkOutputAudience(change, readers, await remainingMaterialReaders(db, row, at));
  }

  /** Who reads the output now and who would with the change, by name then id. */
  private async effect(db: Db, row: OutputAccessRow, change: AudienceChange, at: Date): Promise<AudienceEffect> {
    const before = await readersOfRow(db, row, at);
    const after = await readersOfRow(db, { ...row, audienceMode: change.mode, audienceUserIds: [...change.namedUserIds].sort() }, at);
    const gaining = [...after].filter((id) => !before.has(id));
    const losing = [...before].filter((id) => !after.has(id));
    const named = async (xs: string[]) =>
      xs.length === 0
        ? []
        : (await db.query<{ id: string; name: string }>(`SELECT id, display_name AS name FROM users WHERE id = ANY($1::uuid[]) ORDER BY display_name, id`, [xs])).rows;
    return { gaining: await named(gaining), losing: await named(losing) };
  }

  private async tx(work: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await work(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
