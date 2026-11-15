import type { Pool } from 'pg';
import { type AudienceMode, inAudience } from '../discussion/audience';
import type { ProjectAccess } from '../projects/access.service';
import { type ProjectStatus, decide } from '../projects/matrix';

const OPEN_STATES: ProjectStatus[] = ['draft', 'planned', 'active'];

/** An analysis run with the facts of its thread and project, as read at the start of a job. */
export interface RunRow {
  id: string;
  status: string;
  kind: 'proposals' | 'minutes';
  trigger: 'quiet_period' | 'meeting_end' | 'button' | 'selection';
  threadId: string;
  requestedBy: string | null;
  coversFromNo: number | null;
  selectedMessageIds: string[] | null;
  sourceVersionId: string | null;
  extractionRunId: string | null;
  threadKind: 'discussion' | 'meeting' | null;
  threadState: 'open' | 'ended' | null;
  threadTitle: string | null;
  meetingDate: string | null;
  projectId: string | null;
  projectStatus: ProjectStatus | null;
  audienceId: string | null;
}

export interface Refusal {
  code: string;
  detail: string;
}

export async function loadRun(pool: Pool, id: string): Promise<RunRow | undefined> {
  const { rows } = await pool.query<RunRow>(
    `SELECT r.id, r.status, r.kind, r.trigger, r.thread_id AS "threadId", r.requested_by AS "requestedBy", r.covers_from_no AS "coversFromNo",
            r.selected_message_ids AS "selectedMessageIds", r.source_version_id AS "sourceVersionId", r.extraction_run_id AS "extractionRunId",
            t.kind AS "threadKind", t.state AS "threadState", t.title AS "threadTitle", to_char(t.meeting_date, 'YYYY-MM-DD') AS "meetingDate",
            t.project_id AS "projectId", p.status AS "projectStatus", t.audience_id AS "audienceId"
       FROM analysis_runs r
       LEFT JOIN discussion_threads t ON t.id = r.thread_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE r.id = $1`,
    [id],
  );
  return rows[0];
}

/**
 * The checks of spec 7.2 and 11, made again at every attempt: thread, project state, kind of thread, and the requester's right and
 * audience. A proposals run needs a discussion, a minutes run a meeting. An automatic run (no requester) has no person to recheck.
 */
export async function recheckRun(pool: Pool, access: ProjectAccess, run: RunRow, expect: 'discussion' | 'meeting'): Promise<Refusal | null> {
  const what = expect === 'meeting' ? 'minutes were not drafted' : 'analysis did not run';
  if (!run.threadKind || !run.projectId || !run.projectStatus || !run.audienceId) {
    return { code: 'thread_not_found', detail: expect === 'meeting' ? 'The meeting no longer exists, so the minutes were not drafted.' : 'The discussion no longer exists, so the analysis did not run.' };
  }
  if (!OPEN_STATES.includes(run.projectStatus)) {
    return {
      code: 'project_not_open',
      detail: run.requestedBy === null ? `The project is no longer open, so the automatic ${expect === 'meeting' ? 'minutes were not drafted' : 'analysis did not run'}.` : `The project is no longer open, so the ${what}.`,
    };
  }
  if (run.threadKind !== expect) {
    return expect === 'meeting'
      ? { code: 'thread_not_a_meeting', detail: 'Minutes can only be drafted from a meeting, so they were not drafted.' }
      : { code: 'thread_not_a_discussion', detail: 'Proposals can only be made from a discussion, so the analysis did not run.' };
  }
  if (run.requestedBy === null) return null;

  const refused: Refusal = {
    code: 'requester_not_allowed',
    detail: expect === 'meeting' ? 'The person who asked can no longer ask for minutes of this meeting.' : 'The person who asked can no longer ask for analysis of this discussion.',
  };
  const user = (
    await pool.query<{ id: string; email: string; displayName: string; role: string; status: string }>(
      `SELECT id, email, display_name AS "displayName", role, status FROM users WHERE id = $1`,
      [run.requestedBy],
    )
  ).rows[0];
  if (!user || user.status !== 'active') return refused;
  const ctx = await access.load(run.projectId, user);
  // An open meeting asks for the right to post; an ended one for the right to ask for analysis (spec 5.2).
  const action = expect === 'meeting' && run.threadState !== 'ended' ? 'discussion.post' : 'analysis.request';
  if (!ctx || ctx.roles.length === 0 || !decide({ action, roles: ctx.roles, status: ctx.project.status }).allowed) return refused;
  const audience = (
    await pool.query<{ mode: AudienceMode; named: string[] }>(
      `SELECT a.mode, COALESCE((SELECT array_agg(m.user_id) FROM audience_members m WHERE m.audience_id = a.id), '{}') AS named
         FROM audiences a WHERE a.id = $1`,
      [run.audienceId],
    )
  ).rows[0];
  if (!audience || !inAudience(ctx, { id: run.audienceId, projectId: run.projectId, mode: audience.mode, namedUserIds: audience.named })) return refused;
  return null;
}
