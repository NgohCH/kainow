import { ConflictException } from '@nestjs/common';
import { writeAudit } from '../audit/audit';
import { uuidv7 } from '../common/uuid7';
import { decide } from '../projects/matrix';
import type { ChangeHandler } from '../changes/handlers';

/** Shown wherever an output approval is asked for or answered (spec 4.3; outputs rules 6, O13). */
export const DOES_NOT_APPROVE_COMMITMENTS = 'Approving this document does not approve the commitments it mentions.';

export const NOT_REGISTERED = 'Only a registered output can have a version approved.';
export const IN_REVIEW = 'This output is waiting for a review of who may read it. Clear the review before approving a version.';
export const OUTPUT_HELD = 'This output is held while it is looked into, so no version can be approved.';
export const NOT_A_DRAFT = 'Only a Draft version can be put for approval.';
export const NOT_FILED = 'File this version before putting it for approval: approving it now would approve bytes nobody outside Kainow can see.';
export const NOT_CHECKED = 'Check this linked document before putting it for approval.';
export const FILE_NOT_AS_FILED = 'The file for this version has changed, is missing or cannot be reached. Put it right before putting it for approval.';
export const LATER_APPROVED = 'A later version is already approved, so this earlier version cannot be approved.';

/** The check results that stop a version being approved (spec 4.3). */
const BAD_CHECKS = ['changed', 'missing', 'access_denied'];

/**
 * Approval of one exact output version through the project's approval policy (spec 4.3, D100). Raised by the PM or a
 * Deputy; approved by Owners and Sponsors like any change. Approving sets the version Approved with the request as its
 * reference, sets any earlier Approved version Superseded, and writes the output's events (its History lines).
 * Lock order: the output, then its versions, then the stored file.
 */
export const approveOutputHandler: ChangeHandler = {
  kind: 'approve_output',
  targetKind: 'output_version',
  mayPropose(ctx) {
    const v = decide({ action: 'output.approve_request', roles: ctx.roles, status: ctx.project.status });
    return v.allowed ? null : v.reason;
  },
  async validate(c, _ctx, target) {
    const o = (
      await c.query(
        `SELECT o.status, o.review_state AS "reviewState", o.held_case_id AS "heldCaseId", v.status AS "versionStatus"
           FROM output_versions v JOIN outputs o ON o.id = v.output_id WHERE v.id = $1`,
        [target.id],
      )
    ).rows[0];
    if (o.status !== 'registered') throw new ConflictException(NOT_REGISTERED);
    if (o.heldCaseId) throw new ConflictException(OUTPUT_HELD);
    if (o.reviewState === 'review_required') throw new ConflictException(IN_REVIEW);
    if (o.versionStatus !== 'draft') throw new ConflictException(NOT_A_DRAFT);
    const later = await c.query(`SELECT 1 FROM output_versions WHERE output_id = $1 AND version_no > $2 AND status = 'approved'`, [target.outputId, target.versionNo]);
    if (later.rowCount) throw new ConflictException(LATER_APPROVED);
    const f = target.storedFileId
      ? (await c.query(`SELECT state, check_status AS "checkStatus" FROM stored_files WHERE id = $1 FOR UPDATE`, [target.storedFileId])).rows[0]
      : undefined;
    // Filed, or a linked document that has been checked and found as registered. Nothing else is bytes anyone can see.
    if (!f || (f.state !== 'stored' && f.state !== 'linked')) throw new ConflictException(NOT_FILED);
    if (BAD_CHECKS.includes(f.checkStatus)) throw new ConflictException(FILE_NOT_AS_FILED);
    if (f.state === 'linked' && f.checkStatus !== 'ok') throw new ConflictException(NOT_CHECKED);
    return { outputId: target.outputId, versionNo: target.versionNo };
  },
  async apply(c, ctx, target, _terms, request, at) {
    const by = request.decidedBy as string;
    const event = (kind: string, versionId: string, detail: Record<string, unknown>) =>
      c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        uuidv7(at.getTime()), target.outputId, versionId, kind, by, at, JSON.stringify(detail),
      ]);
    await c.query(`UPDATE output_versions SET status = 'approved', approval_request_id = $2 WHERE id = $1`, [target.id, request.id]);
    await event('approved', target.id, { requestId: request.id, versionNo: target.versionNo });
    const replaced = (
      await c.query<{ id: string; versionNo: number }>(
        `UPDATE output_versions SET status = 'superseded'
          WHERE output_id = $1 AND status = 'approved' AND version_no < $2 RETURNING id, version_no AS "versionNo"`,
        [target.outputId, target.versionNo],
      )
    ).rows;
    for (const r of replaced.sort((a, b) => a.versionNo - b.versionNo)) await event('superseded', r.id, { by: target.versionNo, requestId: request.id });
    await writeAudit(c, {
      at, action: 'output.approved', actorUserId: by, subjectType: 'output', subjectId: target.outputId,
      detail: { projectId: ctx.project.id, versionNo: target.versionNo, requestId: request.id, superseded: replaced.map((r) => r.versionNo) },
    });
    return {};
  },
};
