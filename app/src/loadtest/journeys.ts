import { randomUUID } from 'node:crypto';
import type { Sample } from './report';
import { SEARCH_WORDS } from './seed';
import type { Session } from './sessions';

/** The weighted journeys of 10b spec 13.1 step 3, in table order. */
export const JOURNEYS = ['browse', 'read', 'write', 'dashboards', 'search', 'approve', 'extract', 'analytics'] as const;
export type JourneyName = (typeof JOURNEYS)[number];

/** Shares in percent, exactly the spec table. */
export const JOURNEY_WEIGHTS: Readonly<Record<JourneyName, number>> = {
  browse: 35, // My Projects, a project overview, its Work tab, a task
  read: 15, // discussion threads and notes
  write: 15, // a discussion comment; a task's progress or status
  dashboards: 10, // personal and project dashboards
  search: 8,
  approve: 7, // approve or reject a waiting proposal
  extract: 5, // a small note and an extraction (queued to the fake AI)
  analytics: 5, // Administrator analytics
};

/** A small, fast, seedable generator (mulberry32), so a run's journey sequence is repeatable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pickJourney(rng: () => number): JourneyName {
  let x = rng() * 100;
  for (const j of JOURNEYS) {
    x -= JOURNEY_WEIGHTS[j];
    if (x < 0) return j;
  }
  return JOURNEYS[JOURNEYS.length - 1];
}

/** An extraction the journey asked for: the note it made, and when the request was answered. */
export interface ExtractionAsked {
  sourceId: string;
  marker: string;
  requestedAt: number;
}

export interface JourneyContext {
  me: Session;
  /** The Enterprise Administrator's session (one of the virtual people), for the analytics journey. */
  admin: Session;
  rng: () => number;
  record(sample: Sample): void;
  extractions: ExtractionAsked[];
  /** Filled by the first projects list. */
  projects?: { id: string; myRoles: string[] }[];
}

const pick = <T>(rng: () => number, xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(rng() * xs.length)]);

const UUID_PATH = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** The path with ids as `:id` and no query, for grouping. */
export function labelOf(method: string, path: string): string {
  return `${method} ${path.split('?')[0].replace(UUID_PATH, '/:id').replace(/\/versions\/\d+/, '/versions/:n')}`;
}

/**
 * The answers a journey step expects when another person got there first, as the routes give them:
 * - authorise a proposal: already approved is a success (200 with the existing record, created false: a repeated click,
 *   records.service authoriseThrough / changes AlreadyAuthorised); already rejected is 409 "This proposal was rejected."
 *   (changes/handlers.ts authoriseProposalHandler.validate);
 * - reject a proposal: already decided is 409 "Only a proposal waiting for review can be rejected." (rejectProposal);
 * - change a task's status: a status that moved is 409 "That change is not possible from …" (taskTransition, via
 *   RecordsService.refusal, which maps any reason not starting "Only " or "Write " to 409).
 * A 403 or 400 is never expected: the journeys only act where the person's role allows and send the required fields.
 */
export const EXPECTED_REFUSALS = {
  authoriseProposal: [409],
  rejectProposal: [409],
  taskStatus: [409],
} as const satisfies Record<string, readonly number[]>;

/** 2xx is ok, a status in `refusals` is an expected refusal, anything else (or no answer, status 0) an error. */
export function classify(status: number, refusals: readonly number[] = []): Sample['outcome'] {
  return status >= 200 && status < 300 ? 'ok' : refusals.includes(status) ? 'refusal' : 'error';
}

/** One request, recorded with its outcome. */
async function call(ctx: JourneyContext, journey: JourneyName, method: string, path: string, body?: unknown, refusals: readonly number[] = [], who = ctx.me): Promise<any | undefined> {
  const r = await who.request(method, path, body);
  const outcome = classify(r.status, refusals);
  ctx.record({ journey, label: labelOf(method, path), method, status: r.status, ms: r.ms, outcome });
  return outcome === 'ok' ? r.body : undefined;
}

async function myProjects(ctx: JourneyContext, journey: JourneyName): Promise<{ id: string; myRoles: string[] }[]> {
  const body = await call(ctx, journey, 'GET', '/projects');
  if (body?.projects) ctx.projects = body.projects;
  return ctx.projects ?? [];
}

async function projectsCached(ctx: JourneyContext, journey: JourneyName) {
  return ctx.projects ?? myProjects(ctx, journey);
}

const managed = (projects: { id: string; myRoles: string[] }[]) => projects.filter((p) => p.myRoles.includes('pm'));
/** Proposals are approved or rejected by the Owner or a Sponsor. */
const reviewed = (projects: { id: string; myRoles: string[] }[]) => projects.filter((p) => p.myRoles.includes('owner') || p.myRoles.includes('sponsor'));

async function browse(ctx: JourneyContext): Promise<void> {
  const projects = await myProjects(ctx, 'browse');
  const p = pick(ctx.rng, projects);
  if (!p) return;
  await call(ctx, 'browse', 'GET', `/projects/${p.id}`);
  const records = await call(ctx, 'browse', 'GET', `/projects/${p.id}/records`);
  const task = pick(ctx.rng, (records?.tasks ?? []) as { id: string }[]);
  if (task) await call(ctx, 'browse', 'GET', `/records/tasks/${task.id}`);
}

async function read(ctx: JourneyContext): Promise<void> {
  const p = pick(ctx.rng, await projectsCached(ctx, 'read'));
  if (!p) return;
  const list = await call(ctx, 'read', 'GET', `/projects/${p.id}/discussion`);
  const thread = pick(ctx.rng, ((list?.items ?? []) as { kind: string; id: string }[]).filter((i) => i.kind === 'discussion'));
  if (thread) await call(ctx, 'read', 'GET', `/threads/${thread.id}`);
  const notes = await call(ctx, 'read', 'GET', `/projects/${p.id}/notes`);
  const note = pick(ctx.rng, (notes?.sources ?? []) as { id: string; latestVersion: number }[]);
  if (note) {
    await call(ctx, 'read', 'GET', `/notes/${note.id}`);
    await call(ctx, 'read', 'GET', `/notes/${note.id}/versions/${note.latestVersion}`);
  }
}

async function write(ctx: JourneyContext): Promise<void> {
  const projects = await projectsCached(ctx, 'write');
  if (ctx.rng() < 0.5) {
    const p = pick(ctx.rng, projects);
    if (!p) return;
    const list = await call(ctx, 'write', 'GET', `/projects/${p.id}/discussion`);
    const thread = pick(ctx.rng, ((list?.items ?? []) as { kind: string; id: string }[]).filter((i) => i.kind === 'discussion'));
    if (!thread) return;
    const word = pick(ctx.rng, SEARCH_WORDS)!;
    await call(ctx, 'write', 'POST', `/threads/${thread.id}/messages`, { body: `Load-test comment: the ${word} is on track for this week.` });
    return;
  }
  // A task's status, changed by the project's PM: the next step from where it stands.
  const p = pick(ctx.rng, managed(projects));
  if (!p) return;
  const records = await call(ctx, 'write', 'GET', `/projects/${p.id}/records`);
  const task = pick(ctx.rng, ((records?.tasks ?? []) as { id: string; status: string }[]).filter((t) => t.status !== 'cancelled'));
  if (!task) return;
  const note = 'Progress recorded during the load test.';
  const step: Record<string, [string, unknown]> = {
    not_started: ['start', {}],
    in_progress: ctx.rng() < 0.7 ? ['complete', { note, overrideReason: 'Load test' }] : ['block', { note }],
    blocked: ['unblock', { note }],
    completed: ['reopen', { note }],
  };
  const [action, body] = step[task.status] ?? ['start', {}];
  await call(ctx, 'write', 'POST', `/records/tasks/${task.id}/${action}`, body, EXPECTED_REFUSALS.taskStatus);
}

async function dashboards(ctx: JourneyContext): Promise<void> {
  await call(ctx, 'dashboards', 'GET', '/dashboard/me');
  const p = pick(ctx.rng, await projectsCached(ctx, 'dashboards'));
  if (p) await call(ctx, 'dashboards', 'GET', `/projects/${p.id}/dashboard`);
}

async function search(ctx: JourneyContext): Promise<void> {
  await call(ctx, 'search', 'GET', `/search?q=${encodeURIComponent(pick(ctx.rng, SEARCH_WORDS)!)}`);
}

async function approve(ctx: JourneyContext): Promise<void> {
  const p = pick(ctx.rng, reviewed(await projectsCached(ctx, 'approve')));
  if (!p) return;
  const list = await call(ctx, 'approve', 'GET', `/projects/${p.id}/proposals`);
  const waiting = ((list?.proposals ?? []) as { id: string; kind: string; reviewStatus: string }[]).filter((x) => x.reviewStatus === 'pending');
  const proposal = pick(ctx.rng, waiting);
  if (!proposal) return;
  if (ctx.rng() < 0.65) {
    const body = proposal.kind === 'risk' ? { severity: 'medium' } : proposal.kind === 'decision' ? { rationale: 'Agreed during the load test.' } : {};
    await call(ctx, 'approve', 'POST', `/proposals/${proposal.id}/authorise`, body, EXPECTED_REFUSALS.authoriseProposal);
  } else {
    await call(ctx, 'approve', 'POST', `/proposals/${proposal.id}/reject`, { reason: 'Not needed at this stage.' }, EXPECTED_REFUSALS.rejectProposal);
  }
}

async function extract(ctx: JourneyContext): Promise<void> {
  const p = pick(ctx.rng, managed(await projectsCached(ctx, 'extract')));
  if (!p) return;
  const marker = `LT-${randomUUID()}`;
  const word = pick(ctx.rng, SEARCH_WORDS)!;
  const text = [
    `Load-test notes ${marker}.`,
    'Present: the Project Manager, the Owner and three Members.',
    `The team agreed to review the ${word} figures before the next meeting.`,
    `Action: the Project Manager will prepare the ${word} report by Friday.`,
  ].join('\n');
  const created = await call(ctx, 'extract', 'POST', `/projects/${p.id}/notes`, { title: `Load-test notes ${marker.slice(3, 11)}`, text });
  const sourceId = created?.source?.id as string | undefined;
  if (!sourceId) return;
  const requestedAt = Date.now();
  const started = await call(ctx, 'extract', 'POST', `/notes/${sourceId}/versions/1/extractions`);
  if (started !== undefined) ctx.extractions.push({ sourceId, marker, requestedAt });
}

const PANELS = ['progress', 'problems', 'system', 'trends'];

async function analytics(ctx: JourneyContext): Promise<void> {
  await call(ctx, 'analytics', 'GET', `/admin/analytics?panel=${pick(ctx.rng, PANELS)}`, undefined, [], ctx.admin);
}

export const RUN: Record<JourneyName, (ctx: JourneyContext) => Promise<void>> = { browse, read, write, dashboards, search, approve, extract, analytics };
