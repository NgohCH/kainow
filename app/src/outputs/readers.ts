import type { Pool, PoolClient } from 'pg';
import { type DraftRow, draftAccess, loadDraftRow } from '../assist/reports.service';
import type { AuthUser } from '../auth/tokens';
import { type ProjectContext, ProjectAccess, canReadContent } from '../projects/access.service';
import { grantGivesAccess } from '../projects/grants';
import { type ProjectRole, effectiveRoles } from '../projects/membership';

type Db = Pool | PoolClient;

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

/** The draft behind a draft version, or undefined. */
async function draftOfVersion(db: Db, draftVersionId: string): Promise<DraftRow | undefined> {
  const v = (await db.query<{ draftId: string }>(`SELECT draft_id AS "draftId" FROM report_draft_versions WHERE id = $1`, [draftVersionId])).rows[0];
  return v ? loadDraftRow(db, v.draftId) : undefined;
}

/**
 * Whether the person may read every passage and record the draft was built from: `draftAccess` on the draft as if it
 * were shared (submitting it is sharing it with the output's readers), so only the material decides, together with the
 * draft's review and hold state.
 */
async function readsDraftMaterial(db: Db, ctx: ProjectContext, draft: DraftRow): Promise<boolean> {
  return (await draftAccess(db, ctx, { ...draft, shared: true })) === 'readable';
}

/**
 * The people among the project's content readers who may read all the material of a D77 draft version (D101): those
 * `draftAccess` allows (spec 4.5). Empty when the draft version is not in this project.
 */
export async function materialReaders(db: Db, draftVersionId: string, projectId: string, at: Date = new Date()): Promise<Set<string>> {
  const draft = await draftOfVersion(db, draftVersionId);
  const out = new Set<string>();
  if (!draft || draft.projectId !== projectId) return out;
  for (const ctx of await contentReaderContexts(db, projectId, at)) {
    if (await readsDraftMaterial(db, ctx, draft)) out.add(ctx.viewerId);
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

/** Whether the person may read the material of every version of the output built from a D77 draft. */
export async function readsAllMaterial(db: Db, ctx: ProjectContext, row: Pick<OutputAccessRow, 'draftVersionIds'>): Promise<boolean> {
  for (const id of row.draftVersionIds) {
    const draft = await draftOfVersion(db, id);
    if (!draft || !(await readsDraftMaterial(db, ctx, draft))) return false;
  }
  return true;
}

/**
 * Whether this person may see the output now (spec 4.6, 4.5, D101). Only content readers of its project (Active roles,
 * Audit/Oversight grants within their dates; never Leadership grants or the Administrator alone). A Restricted output
 * is read by the people named in its audience only (an output's audience is exactly its named people; roles add
 * nobody). Submitted, Declined and Withdrawn: its submitter, the PM and Deputies, within the audience. Registered and
 * in "Access review required": the PM, Deputies, Owner and Sponsors within the audience who can still read all its
 * material (D101 limits; it never widens). Deleted or
 * held: nobody here, except that `lookThroughCase` (a security review of that case) sees a held output as if it were not.
 */
export async function readsOutput(db: Db, ctx: ProjectContext | null, row: OutputAccessRow, opts: { lookThroughCase?: string | null } = {}): Promise<boolean> {
  if (!canReadContent(ctx) || ctx.project.id !== row.projectId) return false;
  if (row.deletedAt) return false;
  if (row.heldCaseId && row.heldCaseId !== opts.lookThroughCase) return false;
  if (row.status !== 'registered') {
    const mayRegister = ctx.roles.some((r) => REGISTRARS.includes(r));
    return (row.authorId === ctx.viewerId || mayRegister) && inOutputAudience(ctx, row);
  }
  if (row.reviewState === 'review_required') {
    return ctx.roles.some((r) => OUTPUT_MANAGER_ROLES.includes(r)) && inOutputAudience(ctx, row) && (await readsAllMaterial(db, ctx, row));
  }
  return inOutputAudience(ctx, row);
}

/** The ids of everyone who may read the output on the UTC+8 day of `at` (spec 4.6). */
export async function outputReaders(db: Db, outputId: string, at: Date, opts: { lookThroughCase?: string | null } = {}): Promise<Set<string>> {
  const row = await loadOutputAccessRow(db, outputId);
  const out = new Set<string>();
  if (!row) return out;
  for (const ctx of await contentReaderContexts(db, row.projectId, at)) {
    if (await readsOutput(db, ctx, row, opts)) out.add(ctx.viewerId);
  }
  return out;
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
