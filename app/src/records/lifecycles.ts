/**
 * Question and risk lifecycle rules (V1.0 Questions, Decisions and Risk Lifecycle §3, §5, §9). Pure functions.
 * Every change needs the project Active and a note (the answer, the reason or the explanation).
 */
import type { ProjectStatus } from '../projects/matrix';
import type { ProjectRole } from '../projects/membership';

export type QuestionStatus = 'open' | 'answered' | 'resolved' | 'withdrawn';
export type QuestionAction = 'answer' | 'resolve' | 'reopen' | 'withdraw';
export type RiskStatus = 'open' | 'mitigating' | 'resolved' | 'accepted';
export type RiskAction = 'mitigate' | 'update' | 'accept' | 'resolve' | 'reopen';
export type Severity = 'low' | 'medium' | 'high' | 'critical';
export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

type Verdict<S> = { allowed: true; to: S } | { allowed: false; reason: string };
const refuse = (reason: string) => ({ allowed: false as const, reason });
const has = (roles: ProjectRole[], ...want: ProjectRole[]) => roles.some((r) => want.includes(r));
const blank = (s: string | null) => s === null || s.trim() === '';
const NOT_ACTIVE = 'Records change only while the project is Active.';
const NOTE = 'A note is required.';

export function questionTransition(input: {
  action: QuestionAction;
  status: QuestionStatus;
  actor: { isRequester: boolean; roles: ProjectRole[]; active: boolean };
  projectStatus: ProjectStatus;
  note: string | null;
}): Verdict<QuestionStatus> {
  const { action, status, actor } = input;
  if (input.projectStatus !== 'active') return refuse(NOT_ACTIVE);
  const resolver = actor.isRequester || has(actor.roles, 'pm', 'deputy_pm');
  switch (action) {
    case 'answer':
      if (!actor.active) return refuse('Only an Active member of the project can answer.');
      if (status !== 'open' && status !== 'answered') return refuse('This question is no longer open for answers.');
      return blank(input.note) ? refuse('Write the answer.') : { allowed: true, to: 'answered' };
    case 'resolve':
      if (!resolver) return refuse('Only the requester, the Project Manager or a Deputy can resolve a question.');
      if (status === 'open') return refuse('Answered is not Resolved: the requester, Project Manager or a Deputy confirms the answer.');
      if (status !== 'answered') return refuse('A question is resolved only once it has an answer.');
      return { allowed: true, to: 'resolved' };
    case 'reopen':
      if (!resolver) return refuse('Only the requester, the Project Manager or a Deputy can reopen a question.');
      if (status !== 'resolved') return refuse('A question can be reopened only after it is resolved.');
      return blank(input.note) ? refuse(NOTE) : { allowed: true, to: 'open' };
    case 'withdraw':
      if (!actor.isRequester && !has(actor.roles, 'pm')) return refuse('Only the requester or the Project Manager can withdraw a question.');
      if (status !== 'open' && status !== 'answered') return refuse('A question can be withdrawn only while it is open or answered.');
      return blank(input.note) ? refuse(NOTE) : { allowed: true, to: 'withdrawn' };
  }
}

export function riskTransition(input: {
  action: RiskAction;
  status: RiskStatus;
  actor: { isResponsible: boolean; roles: ProjectRole[] };
  projectStatus: ProjectStatus;
  note: string | null;
  responsibleSet: boolean;
  reviewOnSet: boolean;
}): Verdict<RiskStatus> {
  const { action, status, actor } = input;
  if (input.projectStatus !== 'active') return refuse(NOT_ACTIVE);
  const worker = actor.isResponsible || has(actor.roles, 'pm', 'deputy_pm');
  const authority = has(actor.roles, 'owner', 'sponsor');
  if (blank(input.note)) return refuse(NOTE);
  switch (action) {
    case 'mitigate':
      if (!worker) return refuse('Only the Risk Responsible Person, the Project Manager or a Deputy can record mitigation.');
      return status === 'open' ? { allowed: true, to: 'mitigating' } : refuse('A risk moves to Mitigating only from Open.');
    case 'update':
      if (!worker) return refuse('Only the Risk Responsible Person, the Project Manager or a Deputy can update a risk.');
      return status === 'open' || status === 'mitigating' ? { allowed: true, to: status } : refuse('A risk can be updated only while it is open or mitigating.');
    case 'accept':
      if (!authority) return refuse('Only the Owner or a Sponsor can accept a risk.');
      if (status !== 'open' && status !== 'mitigating') return refuse('A risk can be accepted only while it is open or mitigating.');
      if (!input.responsibleSet || !input.reviewOnSet) return refuse('Accepting a risk needs a responsible person and a review date.');
      return { allowed: true, to: 'accepted' };
    case 'resolve':
      if (!authority) return refuse('Only the Owner or a Sponsor can approve a risk\'s resolution.');
      return status === 'resolved' ? refuse('This risk is already resolved.') : { allowed: true, to: 'resolved' };
    case 'reopen':
      if (status === 'accepted') return authority ? { allowed: true, to: 'open' } : refuse('Only the Owner or a Sponsor can reverse an acceptance.');
      if (status !== 'resolved') return refuse('A risk can be reopened only after it is resolved or accepted.');
      return worker ? { allowed: true, to: 'open' } : refuse('Only the Risk Responsible Person, the Project Manager or a Deputy can reopen a risk.');
  }
}
