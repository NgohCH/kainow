import type { Pool, PoolClient } from 'pg';
import { type MaterialRef, readableMaterial } from '../assist/material';
import type { AuthUser } from '../auth/tokens';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { grantGivesAccess } from '../projects/grants';
import { type ProjectRole, effectiveRoles } from '../projects/membership';

type Db = Pool | PoolClient;

/** Shown on an output whose material was removed, to the people who review it (D101, spec 4.5). */
export const ACCESS_REVIEW_LABEL = 'Access review required';

/** PM, Deputy, Owner and Sponsor: the default audience of an output built from restricted material (D101). */
export const OUTPUT_MANAGER_ROLES: readonly ProjectRole[] = ['pm', 'deputy_pm', 'owner', 'sponsor'];
/** Who sees a submitted, declined or withdrawn output besides its submitter (spec 4.6). */
const REGISTRARS: readonly ProjectRole[] = ['pm', 'deputy_pm'];

const SYSTEM_VIEWER: AuthUser = { id: '00000000-0000-7000-8000-000000000000', email: 'kainow@kainow.test', displayName: 'Kainow', role: 'member' };

/** The context as one of the project's people would have it (their own roles and grants; never an Administrator). */
function asPerson(ctx: ProjectContext, userId: string): ProjectContext {
  return {
    ...ctx,
    viewerId: userId,
    isAdmin: false,
    roles: effectiveRoles(ctx.rows, userId, ctx.today),
    grantKinds: [...new Set(ctx.grants.filter((g) => g.userId === userId && grantGivesAccess(g, ctx.today, ctx.rows)).map((g) => g.kind))],
  };
}

/**
 * Everyone who may read the project's content on the UTC+8 day of `at` (`canReadContent`: an Active role, or an Audit or
 * Oversight grant giving access that day), each with their own context. Leadership grants are not project access and
 * never appear here. Empty when the project does not exist.
 */
export async function contentReaderContexts(db: Db, projectId: string, at: Date): Promise<ProjectContext[]> {
  const base = await new ProjectAccess(db as Pool, () => at).load(projectId, SYSTEM_VIEWER, db);
  if (!base) return [];
  const ids = [...new Set([...base.rows.map((r) => r.userId), ...base.grants.map((g) => g.userId)])].sort();
  return ids.map((id) => asPerson(base, id)).filter(canReadContent);
}

/**
 * The people among the project's content readers who may read all the remaining material of a D77 draft version (D101,
 * spec 4.5): the one material rule, `readsRemainingMaterial`, used for submitting, registering, adding versions,
 * changing the audience and review alike. Empty when the draft version is not in this project.
 */
export async function materialReaders(db: Db, draftVersionId: string, projectId: string, at: Date = new Date()): Promise<Set<string>> {
  const inProject = await db.query(`SELECT 1 FROM report_draft_versions v JOIN report_drafts d ON d.id = v.draft_id WHERE v.id = $1 AND d.project_id = $2`, [draftVersionId, projectId]);
  if (!inProject.rowCount) return new Set();
  return remainingReadersOf(db, projectId, [draftVersionId], at);
}

async function remainingReadersOf(db: Db, projectId: string, draftVersionIds: string[], at: Date): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ctx of await contentReaderContexts(db, projectId, at)) {
    if (await readsRemainingMaterial(db, ctx, { draftVersionIds })) out.add(ctx.viewerId);
  }
  return out;
}

export interface OutputAccessRow {
  id: string;
  projectId: string;
  status: 'submitted' | 'registered' | 'declined' | 'withdrawn';
  reviewState: 'none' | 'review_required' | 'cleared';
  audienceId: string | null;
  /** 'restricted' when the output has a Restricted audience; 'project' otherwise. */
  audienceMode: 'project' | 'restricted';
  authorId: string;
  deletedAt: Date | null;
  heldCaseId: string | null;
  /** The people named in a Restricted audience; empty for a Project-wide output. */
  audienceUserIds: string[];
  /** The draft versions the output's versions were rendered from (its Kainow material). */
  draftVersionIds: string[];
}

export async function loadOutputAccessRow(db: Db, outputId: string): Promise<OutputAccessRow | undefined> {
  const { rows } = await db.query(
    `SELECT o.id, o.project_id AS "projectId", o.status, o.review_state AS "reviewState", o.audience_id AS "audienceId",
            CASE WHEN (SELECT a.mode FROM audiences a WHERE a.id = o.audience_id) = 'restricted' THEN 'restricted' ELSE 'project' END AS "audienceMode",
            o.author_id AS "authorId",
            o.deleted_at AS "deletedAt", o.held_case_id AS "heldCaseId",
            COALESCE((SELECT array_agg(am.user_id ORDER BY am.user_id) FROM audience_members am JOIN audiences a ON a.id = am.audience_id
                       WHERE am.audience_id = o.audience_id AND a.mode = 'restricted'), ARRAY[]::uuid[]) AS "audienceUserIds",
            COALESCE((SELECT array_agg(DISTINCT v.draft_version_id) FROM output_versions v WHERE v.output_id = o.id AND v.draft_version_id IS NOT NULL),
                     ARRAY[]::uuid[]) AS "draftVersionIds"
       FROM outputs o WHERE o.id = $1`,
    [outputId],
  );
  return rows[0] as OutputAccessRow | undefined;
}

const restricted = (row: OutputAccessRow): boolean => row.audienceMode === 'restricted';
const inOutputAudience = (ctx: ProjectContext, row: OutputAccessRow): boolean => !restricted(row) || row.audienceUserIds.includes(ctx.viewerId);

/**
 * The material the output's draft versions were built from: what every AI version of each of those drafts sent (as
 * `draftAccess` judges a draft by all of its AI versions), less what was dropped at start.
 */
async function outputMaterialRefs(db: Db, draftVersionIds: string[]): Promise<MaterialRef[]> {
  if (draftVersionIds.length === 0) return [];
  const { rows } = await db.query<MaterialRef>(
    `SELECT DISTINCT m.passage_id AS "passageId", m.record_kind AS "recordKind", m.record_id AS "recordId", m.record_audience_id AS "recordAudienceId"
       FROM report_draft_versions dv
       JOIN report_draft_versions av ON av.draft_id = dv.draft_id AND av.origin = 'ai'
       JOIN ai_request_material m ON m.request_id = av.request_id AND NOT m.dropped_at_start
      WHERE dv.id = ANY($1::uuid[])
      ORDER BY 1, 2, 3, 4`,
    [draftVersionIds],
  );
  return rows;
}

/**
 * Whether the person may read all the material of the output that is still there (D101, spec 4.5: "who can still read
 * the remaining material"). Material since deleted, hidden or held is no longer anyone's to read, so it is left out;
 * material still there must be readable by the person (a tightened source audience leaves out those outside it). The
 * draft's own state (shared, in review, withdrawn) does not count: the output is its own copy, reviewed on its own.
 */
export async function readsRemainingMaterial(db: Db, ctx: ProjectContext, row: Pick<OutputAccessRow, 'draftVersionIds'>): Promise<boolean> {
  const refs = await outputMaterialRefs(db, row.draftVersionIds);
  if (refs.length === 0) return true;
  const mine = await readableMaterial(db, { kind: 'personal', ctx }, refs);
  if (mine.every(Boolean)) return true;
  const there = await readableMaterial(db, { kind: 'existing', ctx }, refs);
  return mine.every((ok, i) => ok || !there[i]);
}

/** The project's content readers who may read all of the output's remaining material; null when it has no Kainow material. */
export async function remainingMaterialReaders(db: Db, row: Pick<OutputAccessRow, 'projectId' | 'draftVersionIds'>, at: Date): Promise<Set<string> | null> {
  return row.draftVersionIds.length === 0 ? null : remainingReadersOf(db, row.projectId, row.draftVersionIds, at);
}

/** Whether the review rule applies: "Access review required" on an output that is still live (Submitted or Registered). */
export const inReview = (row: Pick<OutputAccessRow, 'reviewState' | 'status'>): boolean =>
  row.reviewState === 'review_required' && (row.status === 'registered' || row.status === 'submitted');

/**
 * Whether this person may see the output now (spec 4.6, 4.5, D101). Only content readers of its project (Active roles,
 * Audit/Oversight grants within their dates; never Leadership grants or the Administrator alone). A Restricted output
 * is read by the people named in its audience only (an output's audience is exactly its named people; roles add
 * nobody). Submitted, Declined and Withdrawn: its submitter, the PM and Deputies, within the audience. Registered: its
 * audience. In "Access review required" (a Submitted or Registered output whose material was removed): only the PM,
 * Deputies, Owner and Sponsors among those, who can still read all its remaining material (D101 limits; it never
 * widens). Deleted or held: nobody here, except that `lookThroughCase` (a security review of that case) sees a held
 * output as if it were not.
 */
export async function readsOutput(db: Db, ctx: ProjectContext | null, row: OutputAccessRow, opts: { lookThroughCase?: string | null } = {}): Promise<boolean> {
  if (!canReadContent(ctx) || ctx.project.id !== row.projectId) return false;
  if (row.deletedAt) return false;
  if (row.heldCaseId && row.heldCaseId !== opts.lookThroughCase) return false;
  const base = row.status === 'registered' ? inOutputAudience(ctx, row) : (row.authorId === ctx.viewerId || ctx.roles.some((r) => REGISTRARS.includes(r))) && inOutputAudience(ctx, row);
  if (!base) return false;
  if (inReview(row)) return ctx.roles.some((r) => OUTPUT_MANAGER_ROLES.includes(r)) && (await readsRemainingMaterial(db, ctx, row));
  return true;
}

/** Everyone who would read the output as it is in `row` (spec 4.6), on the UTC+8 day of `at`; also for previews of a change. */
export async function readersOfRow(db: Db, row: OutputAccessRow, at: Date, opts: { lookThroughCase?: string | null } = {}): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ctx of await contentReaderContexts(db, row.projectId, at)) {
    if (await readsOutput(db, ctx, row, opts)) out.add(ctx.viewerId);
  }
  return out;
}

/** The ids of everyone who may read the output on the UTC+8 day of `at` (spec 4.6). */
export async function outputReaders(db: Db, outputId: string, at: Date, opts: { lookThroughCase?: string | null } = {}): Promise<Set<string>> {
  const row = await loadOutputAccessRow(db, outputId);
  return row ? readersOfRow(db, row, at, opts) : new Set();
}

/**
 * Whether the output's readers are the whole project (spec 5.4): Registered, Project-wide, not in review, and not
 * withdrawn, deleted or held. Such an output is filed in the project tree; any other in its own folder. `at` is kept for
 * the callers' symmetry with `outputReaders`: the answer depends on the output alone.
 */
export async function isWholeProject(db: Db, outputId: string, _at: Date): Promise<boolean> {
  const row = await loadOutputAccessRow(db, outputId);
  return !!row && row.status === 'registered' && !restricted(row) && row.reviewState !== 'review_required' && !row.deletedAt && !row.heldCaseId;
}
