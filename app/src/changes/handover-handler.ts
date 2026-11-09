import { BadRequestException, ConflictException } from '@nestjs/common';
import { writeAudit } from '../audit/audit';
import { UUID, uuidv7 } from '../common/uuid7';
import { isCalendarDate } from '../extraction/due';
import { membershipState } from '../projects/membership';
import type { ChangeHandler } from './handlers';
import { openRisk } from './closure';

export const RECEIVING_NOT_ACTIVE = 'The receiving project must be active.';
export const NEEDS_ACCEPTANCE_TERMS = 'Choose a responsible person and a review date to accept this risk.';
export const NOT_OFFERED_HERE = 'Only the closing project can offer a risk to another project.';
const NOT_PEOPLE = "Choose the responsible person from the project's people.";
const PAST = 'Choose a review date that is not in the past.';
const FINISHED = 'This risk is already finished.';
const DATE_FORM = 'Dates must be in the form YYYY-MM-DD.';

/**
 * A risk handed from a closing project to another active project (spec §6). The request lives in the receiving
 * project; its target is the closing project's risk. The receiving Owner or Sponsor accepts by choosing a
 * responsible person among the receiving project's active members and a review date; accepting creates the linked
 * risk there. The offer itself is made by closure (ClosureService), never through the generic submit.
 */
export function handoverHandler(): ChangeHandler {
  return {
    kind: 'risk_handover',
    targetKind: 'risk',
    editableOnApproval: true,
    targetInOtherProject: true,
    mayPropose: () => NOT_OFFERED_HERE,
    readyToApprove: (terms) => (typeof terms.responsibleId === 'string' && typeof terms.reviewOn === 'string' ? null : NEEDS_ACCEPTANCE_TERMS),
    async validate(c, ctx, target, terms) {
      if (terms.fromProjectId !== target.projectId) throw new BadRequestException('Choose a risk of the project being closed.');
      if (ctx.project.status !== 'active') throw new ConflictException(RECEIVING_NOT_ACTIVE);
      if (!openRisk({ status: target.status, reviewOn: target.reviewOn })) throw new ConflictException(FINISHED);
      const out: Record<string, unknown> = { fromProjectId: target.projectId };
      if (terms.responsibleId !== undefined && terms.responsibleId !== null && terms.responsibleId !== '') {
        const id = terms.responsibleId;
        if (typeof id !== 'string' || !UUID.test(id) || !ctx.rows.some((m) => m.userId === id && membershipState(m, ctx.today) === 'active')) {
          throw new BadRequestException(NOT_PEOPLE);
        }
        out.responsibleId = id;
      }
      if (terms.reviewOn !== undefined && terms.reviewOn !== null && terms.reviewOn !== '') {
        if (typeof terms.reviewOn !== 'string' || !isCalendarDate(terms.reviewOn)) throw new BadRequestException(DATE_FORM);
        if (terms.reviewOn < ctx.today) throw new BadRequestException(PAST);
        out.reviewOn = terms.reviewOn;
      }
      return out;
    },
    async apply(c, ctx, target, terms, request, at) {
      const by = request.decidedBy as string;
      const names = (await c.query(`SELECT id, name FROM projects WHERE id = ANY($1::uuid[])`, [[target.projectId, ctx.project.id]])).rows as Array<{ id: string; name: string }>;
      const from = names.find((n) => n.id === target.projectId)?.name as string;
      const to = names.find((n) => n.id === ctx.project.id)?.name as string;
      const id = uuidv7(at.getTime());
      await c.query(
        `INSERT INTO risks (id, project_id, description, severity, responsible_id, review_on, origin_request_id, authorised_by, authorised_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, ctx.project.id, target.description, target.severity, terms.responsibleId, terms.reviewOn, request.id, by, at],
      );
      const event = (riskId: string, kind: string, from_: string | null, to: string | null, note: string, detail: object) =>
        c.query(
          `INSERT INTO record_events (id, record_kind, record_id, kind, from_status, to_status, note, actor_id, at, detail) VALUES ($1, 'risk', $2, $3, $4, $5, $6, $7, $8, $9)`,
          [uuidv7(at.getTime()), riskId, kind, from_, to, note, by, at, JSON.stringify(detail)],
        );
      await event(id, 'handed_over_from', null, 'open', `Handed over from ${from}`, { fromProjectId: target.projectId, fromProjectName: from, fromRiskId: target.id });
      await event(target.id, 'handed_over_to', target.status, target.status, `Handed over to ${to}`, {
        toProjectId: ctx.project.id, toProjectName: to, toRiskId: id,
      });
      await writeAudit(c, {
        at, action: 'risk.handed_over', actorUserId: by, subjectType: 'project', subjectId: ctx.project.id,
        detail: { fromProjectId: target.projectId, fromRiskId: target.id, riskId: id, requestId: request.id },
      });
      return { record: { kind: 'risk', id } };
    },
  };
}
