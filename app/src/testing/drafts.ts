import type { Pool } from 'pg';
import { type MaterialItem, findMaterial } from '../assist/material';
import type { ReportKind } from '../assist/reports';
import { buildTerms } from '../assist/terms';
import type { AuthUser } from '../auth/tokens';
import { uuidv7 } from '../common/uuid7';
import { ProjectAccess } from '../projects/access.service';

/** The passages a person would find for a question in the project, with their own reading rights. */
export async function materialFor(pool: Pool, access: ProjectAccess, projectId: string, user: AuthUser, question: string): Promise<MaterialItem[]> {
  const ctx = await access.load(projectId, user);
  if (!ctx) throw new Error('no project');
  return findMaterial(pool, { kind: 'personal', ctx }, buildTerms(question));
}

export interface SeededDraft {
  draftId: string;
  /** The AI version (1), built from the request with the given material. */
  aiVersionId: string;
  /** A person's edit of the AI version (2). */
  editedVersionId: string;
  /** A version written by a person from scratch (3), not edited from an AI version. */
  humanVersionId: string;
}

/**
 * A D77 report draft as the draft service stores one: a succeeded report request with its material, an AI version
 * built from it, a person's edit of that version and a version written from scratch.
 */
export async function seedDraft(
  pool: Pool,
  opts: { projectId: string; requesterId: string; items: MaterialItem[]; shared?: boolean; kind?: ReportKind; title?: string; body?: string },
): Promise<SeededDraft> {
  const requestId = uuidv7();
  await pool.query(
    `INSERT INTO ai_requests (id, project_id, kind, requested_by, status, scope, created_at) VALUES ($1, $2, 'report', $3, 'succeeded', 'personal', now())`,
    [requestId, opts.projectId, opts.requesterId],
  );
  for (const [n, i] of opts.items.entries()) {
    await pool.query(
      `INSERT INTO ai_request_material (request_id, ordinal, marker, passage_id, record_kind, record_id, record_audience_id, snapshot, location, dropped_at_start)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
      [requestId, n, `P${n + 1}`, i.passageId, i.recordKind, i.recordId, i.recordAudienceId, i.snapshot, i.location],
    );
  }
  const draftId = uuidv7();
  const shared = opts.shared ?? true;
  await pool.query(
    `INSERT INTO report_drafts (id, project_id, kind, title, created_by, created_at, shared, shared_at) VALUES ($1, $2, $3, $4, $5, now(), $6, $7)`,
    [draftId, opts.projectId, opts.kind ?? 'status', opts.title ?? 'Weekly status', opts.requesterId, shared, shared ? new Date() : null],
  );
  await pool.query(
    `INSERT INTO ai_assist_events (id, project_id, actor_id, action, target_kind, target_id, detail, at)
     VALUES ($1, $2, $3, 'draft_requested', 'report_draft', $4, jsonb_build_object('requestId', $5::text), now())`,
    [uuidv7(), opts.projectId, opts.requesterId, draftId, requestId],
  );
  const aiVersionId = uuidv7();
  const body = opts.body ?? '## Summary\n\nThe pump service is booked [P1].';
  await pool.query(
    `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, request_id, created_at) VALUES ($1, $2, 1, 'ai', $3, $4, now())`,
    [aiVersionId, draftId, body, requestId],
  );
  const editedVersionId = uuidv7();
  await pool.query(
    `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, edited_from_id, created_by, created_at) VALUES ($1, $2, 2, 'human', $3, $4, $5, now())`,
    [editedVersionId, draftId, `${body}\n\nEdited.`, aiVersionId, opts.requesterId],
  );
  const humanVersionId = uuidv7();
  await pool.query(
    `INSERT INTO report_draft_versions (id, draft_id, version_no, origin, body, created_by, created_at) VALUES ($1, $2, 3, 'human', 'Written by hand.', $3, now())`,
    [humanVersionId, draftId, opts.requesterId],
  );
  return { draftId, aiVersionId, editedVersionId, humanVersionId };
}
