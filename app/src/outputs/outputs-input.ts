import { BadRequestException } from '@nestjs/common';
import { readOptionalReason } from '../common/reason';
import { UUID } from '../common/uuid7';
import { type AudienceChange, parseAudienceChange } from '../discussion/audience';
import { refuseSecrets } from '../discussion/messages';
import type { ExportFilters, ExportKind } from './exports';

export const MAX_OUTPUT_TITLE = 200;
export const MAX_LINK = 2_000;
const MAX_LIST = 50;

/** A draft rendered as a file, an uploaded file, or a link to a document in an approved location (spec 4.1). */
export type SubmitInput =
  | { kind: 'draft'; draftVersionId: string; format: 'md' | 'docx' | 'pdf'; title: string; reportTypeId?: string }
  | { kind: 'upload'; filename: string; bytes: Buffer; title: string; reportTypeId?: string }
  | { kind: 'link'; url: string; title: string; reportTypeId?: string }
  /** A project export saved as a CSV version (spec 7.3); the title defaults to the export's name and day. */
  | { kind: 'export'; exportKind: ExportKind; filters: ExportFilters; title?: string; reportTypeId?: string };

/** People who contributed (with the department to record for each, if any) and contributing departments. */
export interface ContributorInput {
  people: Array<{ userId: string; departmentId: string | null }>;
  departmentIds: string[];
}

export interface RegisterInput {
  title?: string;
  reportTypeId: string;
  categoryIds?: string[];
  /** `YYYY-MM-DD`; today (UTC+8) when left out. */
  issueDate?: string;
  contributors?: ContributorInput;
  audience?: AudienceChange;
}

export interface OutputPatch {
  title?: string;
  reportTypeId?: string;
  categoryIds?: string[];
  issueDate?: string;
  contributors?: ContributorInput;
}

const BAD_TITLE = `Give a title of 1 to ${MAX_OUTPUT_TITLE} characters.`;
const BAD_TYPE = 'Choose a report type from the list.';
const BAD_CATEGORIES = 'Choose categories from the report types list.';
const BAD_DATE = 'Give the issue date as a day (YYYY-MM-DD).';
const BAD_CONTRIBUTORS = 'Name contributors by their account id, and contributing departments by their id.';
const BAD_KIND = 'Submit a draft report, an uploaded file or a link.';
const BAD_FORMAT = 'Choose Markdown, DOCX or PDF.';
const TITLE_ON_VERSION = 'A new version keeps the output’s title. Change the title in the register details instead.';

const obj = (b: unknown): Record<string, unknown> => (b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
const uuid = (v: unknown, refusal: string): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw new BadRequestException(refusal);
  return v;
};
const uuids = (v: unknown, refusal: string): string[] => {
  if (!Array.isArray(v) || v.length > MAX_LIST) throw new BadRequestException(refusal);
  return [...new Set(v.map((x) => uuid(x, refusal)))];
};

/** A title of 1 to 200 characters with no suspected credential (D79: only the kind is named). */
export function readTitle(input: unknown): string {
  const title = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
  if (title === '' || [...title].length > MAX_OUTPUT_TITLE) throw new BadRequestException(BAD_TITLE);
  refuseSecrets(title);
  return title;
}

/** A real calendar day as `YYYY-MM-DD`. */
export function readDay(input: unknown): string {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) throw new BadRequestException(BAD_DATE);
  const d = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== input) throw new BadRequestException(BAD_DATE);
  return input;
}

const optionalType = (v: unknown): string | undefined => (v === undefined || v === null || v === '' ? undefined : uuid(v, BAD_TYPE));

/**
 * The submission: a multipart upload when a file came with the request (fields `title`, `reportTypeId`), otherwise JSON
 * `{ kind: 'draft', draftVersionId, format, title, reportTypeId? }` or `{ kind: 'link', url, title, reportTypeId? }`.
 * With `forVersion` (a new version of an existing output) there is no title: the output keeps its own, and a title
 * sent anyway is refused rather than silently dropped.
 */
export function parseSubmitBody(body: unknown, file: { originalname: string; buffer: Buffer } | undefined, forVersion = false): SubmitInput {
  const b = obj(body);
  if (forVersion && b.title !== undefined) throw new BadRequestException(TITLE_ON_VERSION);
  const title = forVersion ? '' : readTitle(b.title);
  const reportTypeId = optionalType(b.reportTypeId);
  if (file) return { kind: 'upload', filename: file.originalname, bytes: file.buffer, title, reportTypeId };
  if (b.kind === 'draft') {
    if (b.format !== 'md' && b.format !== 'docx' && b.format !== 'pdf') throw new BadRequestException(BAD_FORMAT);
    return { kind: 'draft', draftVersionId: uuid(b.draftVersionId, 'Choose a version of a draft report.'), format: b.format, title, reportTypeId };
  }
  if (b.kind === 'link') {
    if (typeof b.url !== 'string' || b.url.trim() === '' || b.url.length > MAX_LINK) throw new BadRequestException('Give the link to the document.');
    return { kind: 'link', url: b.url.trim(), title, reportTypeId };
  }
  if (b.kind === 'upload') throw new BadRequestException('Attach the file to upload.');
  throw new BadRequestException(BAD_KIND);
}

function readContributors(v: unknown): ContributorInput {
  const c = obj(v);
  const peopleRaw = c.people ?? [];
  if (!Array.isArray(peopleRaw) || peopleRaw.length > MAX_LIST) throw new BadRequestException(BAD_CONTRIBUTORS);
  const people: ContributorInput['people'] = [];
  for (const p of peopleRaw) {
    const o = obj(p);
    const userId = uuid(o.userId, BAD_CONTRIBUTORS);
    const departmentId = o.departmentId === undefined || o.departmentId === null ? null : uuid(o.departmentId, BAD_CONTRIBUTORS);
    if (!people.some((x) => x.userId === userId)) people.push({ userId, departmentId });
  }
  return { people, departmentIds: uuids(c.departmentIds ?? [], BAD_CONTRIBUTORS) };
}

/** `{ title?, reportTypeId, categoryIds?, issueDate?, contributors?: { people: [{ userId, departmentId? }], departmentIds }, audience? }` */
export function parseRegisterBody(body: unknown): RegisterInput {
  const b = obj(body);
  return {
    title: b.title === undefined ? undefined : readTitle(b.title),
    reportTypeId: uuid(b.reportTypeId, BAD_TYPE),
    categoryIds: b.categoryIds === undefined ? undefined : uuids(b.categoryIds, BAD_CATEGORIES),
    issueDate: b.issueDate === undefined || b.issueDate === null ? undefined : readDay(b.issueDate),
    contributors: b.contributors === undefined ? undefined : readContributors(b.contributors),
    audience: b.audience === undefined ? undefined : parseAudienceChange(b.audience),
  };
}

/** PUT: any of title, reportTypeId, categoryIds, issueDate, contributors, with an optional reason. */
export function parsePatchBody(body: unknown): { patch: OutputPatch; reason: string | null } {
  const b = obj(body);
  const patch: OutputPatch = {};
  if (b.title !== undefined) patch.title = readTitle(b.title);
  if (b.reportTypeId !== undefined) patch.reportTypeId = uuid(b.reportTypeId, BAD_TYPE);
  if (b.categoryIds !== undefined) patch.categoryIds = uuids(b.categoryIds, BAD_CATEGORIES);
  if (b.issueDate !== undefined) patch.issueDate = readDay(b.issueDate);
  if (b.contributors !== undefined) patch.contributors = readContributors(b.contributors);
  return { patch, reason: readOptionalReason(b.reason) };
}
