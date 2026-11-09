import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth/tokens';
import { UUID } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { loadArchiveState } from '../projects/archive';
import type { GrantKind } from '../projects/grants';
import { type ProjectRole, membershipState } from '../projects/membership';
import { type ProjectStatus, ROLE_LABEL } from '../projects/matrix';
import { KIND_ORDER, type SearchKind, hrefFor, parseKinds, parseOffset, parsePhrase } from './query';

export interface SearchResult {
  kind: SearchKind;
  id: string;
  title: string;
  snippet: string | null;
  matchNote: string | null;
  status: string | null;
  href: string;
}

export interface SearchProject {
  id: string;
  name: string;
  status: ProjectStatus;
  archived: boolean;
  myAccess: { roles: ProjectRole[]; grant: GrantKind | null };
  total: number;
  results: SearchResult[];
}

export interface SearchResponse {
  searched: number;
  projects: SearchProject[];
}

/** Results per project in the cross-project view, and per page inside one project. */
const FIRST = 10;
const PAGE = 50;
const MAX_PROJECTS = 30;
const SNIPPET = 160;
const BEFORE = 60;
const TIMED_OUT = 'Search took too long. Try more specific words.';

/** Kind rank as SQL, built from KIND_ORDER (constants only, never input). */
const KIND_RANK = `CASE kind ${Object.entries(KIND_ORDER)
  .map(([k, n]) => `WHEN '${k}' THEN ${n}`)
  .join(' ')} END`;

export interface SearchStatementInput {
  ids: string[];
  kinds: SearchKind[];
  patterns: string[];
  today: string;
  first: string;
  scoped: boolean;
  offset: number;
}

/**
 * The one statement over search_documents. $1 readable project ids, $2 kinds, $3 today, $4 first word, $5 whether
 * one project is asked for, $6 offset within it, then one parameter per pattern from $7. Each pattern is its own
 * `ILIKE` condition, ANDed: a GIN trigram index can serve `text ILIKE $n` but not `ILIKE ALL` over an array.
 * Only placeholders are generated here; every word stays a bound parameter.
 */
export function buildSearchStatement(input: SearchStatementInput): { text: string; values: unknown[] } {
  const match = input.patterns.map((_, i) => `d.text ILIKE $${7 + i}::text`).join(' AND ');
  const text = `
WITH hits AS (
  SELECT d.* FROM search_documents d
   WHERE d.project_id = ANY($1::uuid[])
     AND d.kind = ANY($2::text[])
     AND ${match}
     -- The one place that decides whether this person may read a note's content. Restricted note audiences (O09)
     -- and quarantine and logical deletion (sub-project 5) add their conditions here, so every result derived
     -- from a note (its text, its title, its AI proposals) obeys them.
     AND (d.source_id IS NULL OR EXISTS (SELECT 1 FROM sources s WHERE s.id = d.source_id AND s.status <> 'deleted'))
     AND (d.kind <> 'person' OR d.ends_on IS NULL OR d.ends_on >= $3::date)
), best AS (
  SELECT DISTINCT ON (project_id, kind, item_id) * FROM hits
   -- Current wording first; among it, the item's own row (no match note) before a title or an answer row; then a
   -- note's newest version, and the newest earlier wording.
   ORDER BY project_id, kind, item_id, is_current DESC, (match_note IS NULL) DESC, version_no DESC NULLS LAST, at DESC
), ranked AS (
  SELECT b.*,
         row_number() OVER (PARTITION BY project_id ORDER BY ${KIND_RANK}, at DESC, item_id) AS rn,
         count(*) OVER (PARTITION BY project_id) AS total
    FROM best b
), chosen AS (
  SELECT r.*, greatest(strpos(lower(r.text), lower($4::text)) - ${BEFORE}, 1) AS start
    FROM ranked r
   WHERE CASE WHEN $5::boolean THEN r.rn > $6::bigint AND r.rn <= $6::bigint + ${PAGE} ELSE r.rn <= ${FIRST} END
)
SELECT c.project_id AS "projectId", p.name AS "projectName", c.kind, c.item_id AS "itemId", c.run_id AS "runId", c.version_no AS "versionNo",
       c.version_count AS "versionCount", c.is_current AS "isCurrent", c.match_note AS "matchNote", c.ref_title AS title,
       c.status, c.total::int AS total,
       regexp_replace(
         (CASE WHEN c.start > 1 THEN '…' ELSE '' END) || substr(c.text, c.start, ${SNIPPET})
           || (CASE WHEN c.start + ${SNIPPET} <= length(c.text) THEN '…' ELSE '' END),
         '\\s+', ' ', 'g') AS snippet
  FROM chosen c JOIN projects p ON p.id = c.project_id
 ORDER BY lower(p.name), p.id, c.rn`;
  const { ids, kinds, today, first, scoped, offset, patterns } = input;
  return { text, values: [ids, kinds, today, first, scoped, offset, ...patterns] };
}

/**
 * Settings for the search's read-only transaction; must run inside it (SET LOCAL).
 *
 * enable_seqscan is off on purpose: note text lives in TOAST, so source_versions looks like a few heap pages and a
 * sequential scan looks cheap to the planner, while really it reads every note (about 1.2 s at 1,000 notes against
 * under 1 ms through search_source_versions_trgm). Do not remove it without measuring at scale (spec §12).
 */
export async function applySearchSettings(client: PoolClient, timeoutMs: number): Promise<void> {
  await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
  await client.query('SET LOCAL enable_seqscan = off');
}

interface Row {
  projectId: string;
  projectName: string;
  kind: SearchKind;
  itemId: string;
  runId: string | null;
  versionNo: number | null;
  versionCount: number | null;
  isCurrent: boolean;
  matchNote: string | null;
  title: string;
  status: string | null;
  total: number;
  snippet: string;
}

interface Readable {
  ctx: ProjectContext;
  archived: boolean;
}

/** Search across the projects a person can read right now (V1.0 search design §3–§8). */
@Injectable()
export class SearchService {
  /** Statement timeout for one search, in milliseconds. Public so tests may lower it. */
  timeoutMs = 5000;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly access: ProjectAccess,
  ) {}

  async search(user: AuthUser, query: Record<string, unknown>): Promise<SearchResponse> {
    const { words, patterns } = parsePhrase(query.q);
    const kinds = parseKinds(query.kinds);
    const offset = parseOffset(query.offset);
    const withArchived = query.archived === '1';
    const project = query.project === undefined || query.project === '' ? null : query.project;

    const readable = await this.readable(user, withArchived);
    const searched = readable.size;
    if (project !== null && (typeof project !== 'string' || !UUID.test(project) || !readable.has(project))) {
      return { searched, projects: [] };
    }
    const ids = project !== null ? [project as string] : [...readable.keys()];
    if (ids.length === 0) return { searched, projects: [] };

    const today = this.access.today();
    const rows = await this.run(buildSearchStatement({ ids, kinds, patterns, today, first: words.find((w) => [...w].length >= 3) as string, scoped: project !== null, offset }));
    return { searched, projects: this.build(rows, readable) };
  }

  /** Projects where the person holds a role Active today or a grant giving access today, archived ones on request. */
  private async readable(user: AuthUser, withArchived: boolean): Promise<Map<string, Readable>> {
    const out = new Map<string, Readable>();
    for (const id of await this.access.visibleProjectIds(user.id)) {
      const ctx = await this.access.load(id, user);
      if (!ctx || (ctx.roles.length === 0 && ctx.grantKinds.length === 0)) continue;
      const { archived } = await loadArchiveState(this.pool, id, ctx.project.status, ctx.today);
      if (archived && !withArchived) continue;
      out.set(id, { ctx, archived });
    }
    return out;
  }

  private async run(statement: { text: string; values: unknown[] }): Promise<Row[]> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query('BEGIN READ ONLY');
      await applySearchSettings(client, this.timeoutMs);
      const { rows } = await client.query(statement.text, statement.values);
      await client.query('COMMIT');
      return rows as Row[];
    } catch (err) {
      // A connection that cannot even roll back is discarded rather than returned to the pool.
      await client.query('ROLLBACK').catch((e: Error) => {
        broken = e;
      });
      // Query cancelled by the statement timeout. The phrase never goes into the message.
      if ((err as { code?: string }).code === '57014') throw new ServiceUnavailableException(TIMED_OUT);
      throw err;
    } finally {
      client.release(broken);
    }
  }

  private build(rows: Row[], readable: Map<string, Readable>): SearchProject[] {
    const projects: SearchProject[] = [];
    const byId = new Map<string, SearchProject>();
    for (const row of rows) {
      let p = byId.get(row.projectId);
      if (!p) {
        if (projects.length >= MAX_PROJECTS) continue;
        const { ctx, archived } = readable.get(row.projectId) as Readable;
        p = {
          id: row.projectId,
          name: row.projectName,
          status: ctx.project.status,
          archived,
          myAccess: { roles: ctx.roles, grant: ctx.roles.length === 0 ? (ctx.grantKinds[0] ?? null) : null },
          total: row.total,
          results: [],
        };
        byId.set(row.projectId, p);
        projects.push(p);
      }
      const result = this.result(row, (readable.get(row.projectId) as Readable).ctx);
      if (result) p.results.push(result);
      else p.total -= 1;
    }
    // A project whose only hit was a person with no current place left is not shown.
    return projects.filter((p) => p.total > 0);
  }

  private result(row: Row, ctx: ProjectContext): SearchResult | null {
    let snippet: string | null = row.snippet;
    let matchNote = row.matchNote;
    if (row.kind === 'person') {
      snippet = this.personLine(row.itemId, ctx);
      if (snippet === null) return null;
    }
    if (row.kind === 'note' && !row.isCurrent && row.versionNo !== null) {
      matchNote = `Matched version ${row.versionNo} of ${row.versionCount}`;
    }
    return {
      kind: row.kind,
      id: row.itemId,
      title: row.title,
      snippet,
      matchNote,
      status: row.status,
      href: hrefFor({ kind: row.kind, projectId: row.projectId, itemId: row.itemId, runId: row.runId, versionNo: row.versionNo, isCurrent: row.isCurrent }),
    };
  }

  /** "Owner, Sponsor · Active": the person's Active or Scheduled roles here; null when none is left. */
  private personLine(userId: string, ctx: ProjectContext): string | null {
    const held = ctx.rows
      .filter((r) => r.userId === userId)
      .map((r) => ({ role: r.role, state: membershipState(r, ctx.today) }))
      .filter((r) => r.state === 'active' || r.state === 'scheduled');
    if (held.length === 0) return null;
    const roles = [...new Set(held.map((r) => ROLE_LABEL[r.role]))].join(', ');
    return `${roles} · ${held.some((r) => r.state === 'active') ? 'Active' : 'Scheduled'}`;
  }
}
