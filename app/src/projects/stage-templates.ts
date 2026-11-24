/**
 * The seven starter stage templates Kainow ships (D131, spec 14), in their catalogue order. Migration 0037 seeds exactly
 * these, with these ids; the schema test checks the two agree. Names are verbatim from the spec's table; substages only
 * where the spec gives them.
 */

export interface TemplateStage {
  name: string;
  substages: string[];
}

export interface StarterTemplate {
  id: string;
  name: string;
  stages: TemplateStage[];
}

/** Limits a template is held to (spec 14 and the Task 20 brief). */
export const TEMPLATE_LIMITS = {
  nameChars: 80,
  descriptionChars: 300,
  stages: 20,
  substagesPerStage: 10,
  reasonChars: 500,
} as const;

/** The default template: every project created before migration 0037 has a copy of its stages. */
export const GENERAL_TEMPLATE_ID = 'd1310000-0000-4000-8000-000000000001';

const plain = (...names: string[]): TemplateStage[] => names.map((name) => ({ name, substages: [] }));

export const STARTER_TEMPLATES: readonly StarterTemplate[] = [
  {
    id: GENERAL_TEMPLATE_ID,
    name: 'General',
    stages: [
      { name: 'Initiation', substages: ['Define Purpose', 'Identify Participants', 'Confirm Accountability'] },
      { name: 'Planning', substages: ['Define Scope', 'Break Down Work', 'Identify Resources', 'Approve Plan'] },
      { name: 'Execution', substages: ['In Progress', 'Monitoring & Follow-up'] },
      { name: 'Review & Acceptance', substages: ['Review Deliverables', 'Resolve Outstanding Items', 'Confirm Acceptance'] },
      { name: 'Closure', substages: ['Record Outcome', 'Handover', 'Close Project'] },
    ],
  },
  {
    id: 'd1310000-0000-4000-8000-000000000002',
    name: 'Software development',
    stages: plain('Discovery', 'Design', 'Build', 'Testing', 'Rollout', 'Closure'),
  },
  {
    id: 'd1310000-0000-4000-8000-000000000003',
    name: 'Product sales',
    stages: plain('Lead generation', 'Qualification', 'Proposal', 'Negotiation', 'Closing', 'After-sales review'),
  },
  {
    id: 'd1310000-0000-4000-8000-000000000004',
    name: 'Research project',
    stages: plain('Proposal', 'Literature review', 'Methods and ethics approval', 'Data collection', 'Analysis', 'Writing and publication', 'Closure'),
  },
  {
    id: 'd1310000-0000-4000-8000-000000000005',
    name: 'Syllabus development',
    stages: plain('Needs analysis', 'Learning outcomes', 'Content design', 'Review and approval', 'Pilot delivery', 'Evaluation and revision'),
  },
  {
    id: 'd1310000-0000-4000-8000-000000000006',
    name: 'Marketing campaign',
    stages: plain('Research and brief', 'Strategy and planning', 'Creative development', 'Launch', 'Monitoring and optimisation', 'Evaluation'),
  },
  {
    id: 'd1310000-0000-4000-8000-000000000007',
    name: 'Event',
    stages: plain('Concept and budget', 'Planning and bookings', 'Promotion', 'Final preparations', 'Event day', 'Wrap-up and review'),
  },
];
