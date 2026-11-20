import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { ReportKind } from '../assist/reports';
import { draftAccess, loadDraftRow } from '../assist/reports.service';
import { writeAudit } from '../audit/audit';
import { ChangesService, type RequestView } from '../changes/changes.service';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import type { AudienceChange, Person } from '../discussion/audience';
import { refuseSecrets } from '../discussion/messages';
import { UploadRejected, readUpload } from '../notes/readers';
import { MAX_UPLOAD_BYTES } from '../notes/text';
import { type ProjectContext, ProjectAccess } from '../projects/access.service';
import { decide } from '../projects/matrix';
import { todayUtc8 } from '../projects/membership';
import { STORAGE_CONNECTORS, type StorageConnectorFactory, StorageWaitingForKey } from '../storage/connector-factory';
import { type OutputFormat, loadStorageSettings } from '../storage/settings';
import { type ItemState, StorageError } from '../storage/types';
import { DOES_NOT_APPROVE_COMMITMENTS, approveOutputHandler, endOutputApprovalRequests } from './approval-handler';
import { checkOutputAudience, createOutputAudience, withdrawOutput, writeOutputAudience } from './audience';
import { type CheckStatus, NOT_RECOVERED, REGISTER_FAILED, REGISTER_PENDING, approvedPlaceOf, changeStateSql, checkActions, checkLabel, pathInDestination } from './checks';
import { ALREADY_FILED, BEING_FILED, KEPT_LABEL, STORED_LABELS, LINKED_NOT_FILED, NOT_KEPT, NO_DESTINATION, REGISTER_FIRST, filingFailedLabel, requestFiling } from './filing';
import { type ExportFilters, type ExportKind, assertMayExport, buildExport, defaultExportTitle, recordExport } from './exports';
import { effectiveFormats, outputRefusal } from './formats';
import { outputFileName } from './naming';
import { type ContributorInput, type OutputPatch, type RegisterInput, type SubmitInput, readTitle } from './outputs-input';
import { ACCESS_REVIEW_LABEL, OUTPUT_MANAGER_ROLES, type OutputAccessRow, contentReaderContexts, loadOutputAccessRow, materialReaders, readsOutput, readsRemainingMaterial, remainingMaterialReaders } from './readers';
import { RenderTooLarge, parseBlocks } from './render/blocks';
import { renderDocx } from './render/docx';
import { loadDocumentHeader } from './render/header';
import { renderMarkdown } from './render/markdown';
import { renderPdf } from './render/pdf';
import { notSharedFor } from './sharing';
import { queueOutputPlacement } from './sharing-queue';
import { MOVING_LABEL, keptLabel, notMovedLabel, oldPlaces } from '../projects/department-transfer';

type Db = Pool | PoolClient;

/** Generated or uploaded bytes stay in the database until filed, or this long (spec 5.4). */
export const KEEP_UNFILED_DAYS = 90;

export { KEPT_LABEL };
export const LINK_REFUSED = 'Kainow can only register documents in approved storage locations.';
export const SHARING_OUTSIDE = 'Sharing for this document is managed outside Kainow';
const UPLOAD_KINDS = 'Upload a Markdown, DOCX, PDF or CSV file. Other documents can be registered by link.';
const NARROW_FIRST = 'This version uses material some of this output’s readers cannot read. Narrow its audience to people who can read it first.';
const NOT_SUBMITTED = 'Only a submitted output can be registered or declined.';
const ALREADY_REGISTERED = 'This output is already registered.';
const NOT_REGISTERED = 'Versions are added to a registered output.';
const CLOSED_OUTPUT = 'A declined or withdrawn output cannot be changed.';
const NOT_CONTRIBUTOR = 'Only people who take or took part in this project can be named as contributors.';
const BAD_DEPARTMENT = 'Choose departments from the active departments.';
const BAD_TYPE = 'Choose a report type from the list.';
const NOTHING_TO_CHANGE = 'Nothing to change.';
const STORAGE_UNAVAILABLE = 'The storage service cannot be reached right now, so the link could not be checked. Try again later.';
const ACCEPT_INTO_ITSELF = 'Choose another output to add this submission to.';
const ACCEPT_INTO_REGISTERED = 'A submission can be added only to a registered output.';
const SAME_TIME = 'Someone else changed this output at the same time. Try again.';
const AUDIENCE_SET_AT_REGISTRATION = 'Set when the output was registered';
const AUDIENCE_SET_AT_SUBMISSION = 'Restricted when submitted: built from material some of the project’s readers cannot read';

/** A deleted output as the PM or a Deputy sees it to restore it (sub-project 5: who, when, why). */
export interface DeletedOutput {
  id: string;
  title: string;
  status: OutputSummary['status'];
  deletedAt: Date;
  deletedBy: Person;
  reason: string;
}

/** D77 draft kinds and the report type each is suggested as (spec 4.4). */
export const DEFAULT_REPORT_TYPES: Readonly<Record<ReportKind, string>> = {
  status: 'Status reports',
  decisions_actions: 'Decisions and actions',
  risks: 'Risk summaries',
  specification: 'Specifications',
  free_form: 'Other',
};

type VersionFormat = OutputFormat | 'txt' | 'other';

/** One version, ready to store: its bytes (or link), checksum, where it came from and who may read its material. */
interface PreparedVersion {
  origin: 'draft_report' | 'export' | 'upload' | 'link';
  /** For a saved export: what to record as `project.exported` once the version is stored (kind, filters, row count). */
  exported?: { kind: ExportKind; filters: ExportFilters; rows: number };
  format: VersionFormat;
  bytes: Buffer | null;
  sha256: string;
  size: number;
  draftVersionId: string | null;
  aiAssisted: boolean;
  /** Content readers who may read all of the version's Kainow material; null when it has none (upload, link). */
  material: Set<string> | null;
  link: { destinationId: string; connector: 'graph' | 'local'; driveId: string; item: ItemState } | null;
  /** The report type a draft's kind suggests. */
  defaultTypeId: string | null;
}

interface HeaderFacts {
  title: string;
  reportTypeId: string | null;
  issueDate: string;
  versionNo: number;
}

export interface Filing {
  state: string;
  label: string;
  sharing?: string;
  checkStatus: string | null;
  lastCheckedAt: Date | null;
  /** The provider path: shown to the PM, Deputies, Owner and Sponsors only (spec 4.6). */
  path?: string | null;
  /** Filing failed and the PM or a Deputy may file it again ("Try again"). */
  tryAgain?: true;
  /**
   * A file filed under a department that no longer owns the project (spec 10): "Moving files" while a department
   * transfer moves its folder, "Files not moved — still at <old path>" when that move failed, otherwise (the folder
   * was kept) "Kept at its existing location (filed under <department>)".
   */
  location?: string;
  /** Checked, Changed, Moved, Missing, Access denied or Unverified (spec 5.8), for a filed or linked file. */
  checkLabel?: string;
  /** "The approved content could not be recovered from storage", when a registered change left the original Changed. */
  recovery?: string;
  /** "Registering the changed file as a new version", while that job is waiting or running. */
  registering?: string;
  /** For the PM and Deputies: the last request to register the change failed (they may ask again). */
  registerFailed?: string;
  /** What the PM or a Deputy can do about the check result: `register_changed`, `relink`, `add_version`. */
  actions?: string[];
  /** A file relinked into another destination is labelled with it (D32); PM, Deputies, Owner and Sponsors only. */
  destination?: string;
}

export interface OutputVersionView {
  no: number;
  origin: string;
  format: string;
  status: 'draft' | 'approved' | 'superseded';
  sizeBytes: number;
  createdAt: Date;
  createdBy: Person;
  filing: Filing;
}

/** What a registrar sees after registering an output whose audience leaves them out. */
export interface NoLongerReadable {
  id: string;
  status: 'registered';
  readable: false;
}

export interface OutputSummary {
  id: string;
  title: string;
  status: 'submitted' | 'registered' | 'declined' | 'withdrawn';
  reviewRequired: boolean;
  /** "Access review required" while in review (only its reviewers read it then); null otherwise. */
  reviewLabel: string | null;
  reportType: { id: string; name: string } | null;
  categories: Array<{ id: string; name: string }>;
  issueDate: string | null;
  author: Person;
  aiAssisted: boolean;
  audience: { mode: 'project' | 'restricted' };
  latestVersion: OutputVersionView | null;
  createdAt: Date;
  registeredAt: Date | null;
}

export interface OutputDetail extends Omit<OutputSummary, 'audience'> {
  projectId: string;
  registeredBy: Person | null;
  audience: { mode: 'project' | 'restricted'; people: Person[] };
  contributors: { people: Array<Person & { departmentId: string | null; departmentName: string | null }>; departments: Array<{ id: string; name: string }> };
  versions: OutputVersionView[];
  history: Array<{ kind: string; at: Date; actor: Person | null; reason: string | null; versionNo: number | null }>;
  may: { register: boolean; decline: boolean; update: boolean; addVersion: boolean; changeAudience: boolean; review: boolean };
  /** PM, Deputies, Owner and Sponsors only: "Not shared in SharePoint — no Microsoft account found for <email>". */
  notShared?: Array<{ person: Person; message: string }>;
}


const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const extOf = (name: string) => /\.([A-Za-z0-9]+)$/.exec(name.trim())?.[1].toLowerCase() ?? '';
const UPLOAD_FORMATS: Readonly<Record<string, OutputFormat>> = { md: 'md', markdown: 'md', docx: 'docx', pdf: 'pdf', csv: 'csv' };
const LINK_FORMATS: Readonly<Record<string, VersionFormat>> = { md: 'md', markdown: 'md', docx: 'docx', pdf: 'pdf', csv: 'csv', txt: 'txt' };

@Injectable()
export class OutputsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STORAGE_CONNECTORS) private readonly connectors: StorageConnectorFactory,
    private readonly access: ProjectAccess,
    private readonly changes: ChangesService,
  ) {
    changes.register(approveOutputHandler);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Submitting (spec 4.1)
  // -------------------------------------------------------------------------------------------------------------------

  /** Any Active participant of an open project: a draft, an upload or a link becomes a Submitted output with version 1. */
  async submit(user: AuthUser, projectId: string, input: SubmitInput): Promise<OutputDetail> {
    const ctx = await this.access.authorize(user, 'output.submit', projectId);
    const at = this.clock();
    const title = readTitle(input.kind === 'export' ? (input.title ?? defaultExportTitle(input.exportKind, at)) : input.title);
    const chosenType = input.reportTypeId ? await this.activeType(this.pool, input.reportTypeId) : null;
    const prepared = await this.prepare(ctx, projectId, input, { title, reportTypeId: chosenType, issueDate: todayUtc8(at), versionNo: 1 }, at);
    const audience = prepared.material ? await this.defaultAudience(this.pool, projectId, prepared.material, user.id, at) : null;
    const id = uuidv7(at.getTime());
    await this.tx(async (c) => {
      await this.access.authorize(user, 'output.submit', projectId, c, true);
      const audienceId = audience ? await createOutputAudience(c, projectId, audience, user.id, at, AUDIENCE_SET_AT_SUBMISSION) : null;
      await c.query(
        `INSERT INTO outputs (id, project_id, title, report_type_id, audience_id, status, ai_assisted, author_id, created_at)
         VALUES ($1, $2, $3, $4, $5, 'submitted', $6, $7, $8)`,
        [id, projectId, title, chosenType ?? prepared.defaultTypeId, audienceId, prepared.aiAssisted, user.id, at],
      );
      const versionId = await this.insertVersion(c, id, projectId, 1, prepared, user.id, at);
      await this.event(c, id, 'submitted', user.id, at, { versionId, detail: { origin: prepared.origin, format: prepared.format, restricted: !!audience } });
      await writeAudit(c, { at, action: 'output.submitted', actorUserId: user.id, subjectType: 'output', subjectId: id, detail: { origin: prepared.origin, format: prepared.format } });
      if (prepared.exported) await recordExport(c, at, user.id, projectId, prepared.exported.kind, prepared.exported.filters, prepared.exported.rows, { outputId: id });
    });
    return this.get(user, projectId, id);
  }

  /** The default audience (D101) when the material is narrower than the project's readers: PM, Deputies, Owner and Sponsors among its readers, and the submitter so they still see it; null when everyone can read it. */
  private async defaultAudience(db: Db, projectId: string, material: Set<string>, submitterId: string, at: Date): Promise<string[] | null> {
    const readers = await contentReaderContexts(db, projectId, at);
    if (readers.every((r) => material.has(r.viewerId))) return null;
    const ids = readers.filter((r) => material.has(r.viewerId) && r.roles.some((x) => OUTPUT_MANAGER_ROLES.includes(x))).map((r) => r.viewerId);
    if (material.has(submitterId) && !ids.includes(submitterId)) ids.push(submitterId);
    return ids.sort();
  }

  private async prepare(ctx: ProjectContext, projectId: string, input: SubmitInput, facts: HeaderFacts, at: Date): Promise<PreparedVersion> {
    if (input.kind === 'draft') return this.fromDraft(ctx, projectId, input, facts, at);
    if (input.kind === 'upload') return this.fromUpload(projectId, input);
    if (input.kind === 'export') return this.fromExport(ctx, projectId, input, at);
    return this.fromLink(input.url);
  }

  /**
   * A project export saved as a CSV version (spec 7.3): built now for this person, who must be allowed to export (D106)
   * and the project must allow CSV outputs. Its audience is the project's; the export is recorded once it is stored.
   */
  private async fromExport(ctx: ProjectContext, projectId: string, input: Extract<SubmitInput, { kind: 'export' }>, at: Date): Promise<PreparedVersion> {
    await assertMayExport(this.pool, ctx);
    await this.assertOutputFormat(projectId, 'csv');
    const built = await buildExport(this.pool, projectId, input.exportKind, input.filters, ctx, at, { shared: true });
    return {
      origin: 'export',
      format: 'csv',
      bytes: built.csv,
      sha256: sha256(built.csv),
      size: built.csv.length,
      draftVersionId: null,
      aiAssisted: false,
      material: null,
      link: null,
      defaultTypeId: await this.typeByName('Exports'),
      exported: { kind: input.exportKind, filters: input.filters, rows: built.rows },
    };
  }

  /** Renders a D77 draft version the person can read, in a format the project allows (spec 6). */
  private async fromDraft(ctx: ProjectContext, projectId: string, input: Extract<SubmitInput, { kind: 'draft' }>, facts: HeaderFacts, at: Date): Promise<PreparedVersion> {
    const v = (await this.pool.query<{ draftId: string; body: string }>(`SELECT draft_id AS "draftId", body FROM report_draft_versions WHERE id = $1`, [input.draftVersionId])).rows[0];
    const draft = v ? await loadDraftRow(this.pool, v.draftId) : undefined;
    if (!v || !draft || draft.projectId !== projectId || (await draftAccess(this.pool, ctx, draft)) !== 'readable') throw new NotFoundException();
    await this.assertOutputFormat(projectId, input.format);
    // Every generated file passes the credential check (D79) before it is made.
    refuseSecrets(v.body);
    const aiAssisted = await this.aiDerived(input.draftVersionId);
    const defaultTypeId = await this.typeByName(DEFAULT_REPORT_TYPES[draft.kind]);
    const typeId = facts.reportTypeId ?? defaultTypeId;
    const typeName = typeId ? (await this.pool.query<{ name: string }>(`SELECT name FROM report_types WHERE id = $1`, [typeId])).rows[0]?.name : undefined;
    const projectName = (await this.pool.query<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [projectId])).rows[0].name;
    const header = await loadDocumentHeader(this.pool, {
      title: facts.title,
      projectName,
      reportType: typeName ?? DEFAULT_REPORT_TYPES.free_form,
      versionNo: facts.versionNo,
      issueDate: facts.issueDate,
      aiAssisted,
      generatedAt: at,
    });
    let bytes: Buffer;
    try {
      if (input.format === 'md') bytes = renderMarkdown(header, v.body);
      else {
        const blocks = parseBlocks(v.body, this.config.appUrl);
        bytes = input.format === 'docx' ? await renderDocx(header, blocks) : await renderPdf(header, blocks);
      }
    } catch (err) {
      if (err instanceof RenderTooLarge) throw new BadRequestException(err.message);
      throw err;
    }
    return {
      origin: 'draft_report',
      format: input.format,
      bytes,
      sha256: sha256(bytes),
      size: bytes.length,
      draftVersionId: input.draftVersionId,
      aiAssisted,
      material: await materialReaders(this.pool, input.draftVersionId, projectId, at),
      link: null,
      defaultTypeId,
    };
  }

  /** A DOCX, PDF, Markdown or CSV file in a format the project allows; its text passes the credential check (D79). */
  private async fromUpload(projectId: string, input: Extract<SubmitInput, { kind: 'upload' }>): Promise<PreparedVersion> {
    const format = UPLOAD_FORMATS[extOf(input.filename)];
    if (!format) throw new BadRequestException(UPLOAD_KINDS);
    const bytes = input.bytes;
    if (bytes.length === 0) throw new BadRequestException('The file is empty.');
    if (bytes.length > MAX_UPLOAD_BYTES) throw new BadRequestException(`The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB.`);
    await this.assertOutputFormat(projectId, format);
    let text: string;
    try {
      if (format === 'csv') {
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new BadRequestException('The CSV file is not UTF-8 text.');
        }
      } else {
        text = (await readUpload(`upload.${format}`, bytes)).text;
      }
    } catch (err) {
      if (err instanceof UploadRejected) throw new BadRequestException(err.message);
      throw err;
    }
    refuseSecrets(text);
    return { origin: 'upload', format, bytes, sha256: sha256(bytes), size: bytes.length, draftVersionId: null, aiAssisted: false, material: null, link: null, defaultTypeId: null };
  }

  /**
   * A link to a document in any approved output destination, resolved through the provider (spec 4.1). The document
   * stays where it is; Kainow keeps no copy and no checksum of its own (only the provider's).
   */
  private async fromLink(url: string): Promise<PreparedVersion> {
    try {
      const connector = await this.connectors.forNew('sharepoint_library');
      const resolved = await connector.resolveLink(url);
      const ref = resolved.dest;
      if (!ref?.driveId) throw new BadRequestException(LINK_REFUSED);
      // Any approved output destination counts, the earliest approved first (spec 4.1).
      const dest = await approvedPlaceOf(this.pool, connector, ref, resolved.item, { driveRootId: ref.rootItemId });
      if (!dest) throw new BadRequestException(LINK_REFUSED);
      // Kept relative to the destination's own folder, as the checks compare it (spec 5.8).
      const item = { ...resolved.item, path: await pathInDestination(connector, ref, dest.rootItemId, resolved.item.path) };
      return {
        origin: 'link',
        format: LINK_FORMATS[extOf(item.name)] ?? 'other',
        bytes: null,
        sha256: '',
        size: item.size,
        draftVersionId: null,
        aiAssisted: false,
        material: null,
        link: { destinationId: dest.id, connector: dest.connector, driveId: ref.driveId, item },
        defaultTypeId: null,
      };
    } catch (err) {
      if (err instanceof StorageWaitingForKey) throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
      if (err instanceof StorageError) {
        // Not there, not a link, or not somewhere Kainow may reach: outside the approved locations. Anything else is a fault.
        if (['not_found', 'invalid', 'forbidden'].includes(err.code)) throw new BadRequestException(LINK_REFUSED);
        throw new ServiceUnavailableException(STORAGE_UNAVAILABLE);
      }
      throw err;
    }
  }

  private async assertOutputFormat(projectId: string, format: OutputFormat): Promise<void> {
    const storage = await loadStorageSettings(this.pool);
    const own = (await this.pool.query<{ output_formats: string[] | null }>(`SELECT output_formats FROM project_output_settings WHERE project_id = $1`, [projectId])).rows[0];
    const allowed = effectiveFormats(storage, own ? { inputFormats: null, outputFormats: own.output_formats } : null).output;
    if (!allowed.some((a) => a.format === format)) throw new BadRequestException(outputRefusal(format));
  }

  /** True when the draft version is an AI version or was edited (at any remove) from one (spec 4.2). */
  private async aiDerived(draftVersionId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ ai: boolean }>(
      `WITH RECURSIVE chain AS (
         SELECT id, origin, edited_from_id FROM report_draft_versions WHERE id = $1
         UNION SELECT v.id, v.origin, v.edited_from_id FROM report_draft_versions v JOIN chain c ON v.id = c.edited_from_id)
       SELECT COALESCE(bool_or(origin = 'ai'), false) AS ai FROM chain`,
      [draftVersionId],
    );
    return rows[0].ai;
  }

  private async typeByName(name: string): Promise<string | null> {
    return (await this.pool.query<{ id: string }>(`SELECT id FROM report_types WHERE name = $1 AND status = 'active'`, [name])).rows[0]?.id ?? null;
  }

  private async activeType(db: Db, id: string): Promise<string> {
    if (!UUID.test(id)) throw new BadRequestException(BAD_TYPE);
    const ok = await db.query(`SELECT 1 FROM report_types WHERE id = $1 AND status = 'active'`, [id]);
    if (!ok.rowCount) throw new BadRequestException(BAD_TYPE);
    return id;
  }

  private async activeTypes(db: Db, ids: string[]): Promise<string[]> {
    for (const id of ids) await this.activeType(db, id);
    return ids;
  }

  private async insertVersion(c: PoolClient, outputId: string, projectId: string, versionNo: number, p: PreparedVersion, actorId: string, at: Date): Promise<string> {
    const versionId = uuidv7(at.getTime());
    let storedFileId: string | null = null;
    if (p.link) {
      // A linked document is referenced where it is (D32): Kainow did not create it and manages none of its sharing.
      storedFileId = uuidv7(at.getTime());
      const it = p.link.item;
      await c.query(
        `INSERT INTO stored_files (id, purpose, project_id, destination_id, connector, drive_id, item_id, path, name, size_bytes, provider_hash, etag, ctag, web_url, state, created_at)
         VALUES ($1, 'output', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'linked', $14)`,
        [storedFileId, projectId, p.link.destinationId, p.link.connector, p.link.driveId, it.itemId, it.path, it.name, it.size, it.providerHash, it.etag, it.ctag, it.webUrl, at],
      );
    }
    await c.query(
      `INSERT INTO output_versions (id, output_id, version_no, origin, format, draft_version_id, stored_file_id, status, sha256, size_bytes, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11)`,
      [versionId, outputId, versionNo, p.origin, p.format, p.draftVersionId, storedFileId, p.sha256, p.size, actorId, at],
    );
    if (p.bytes) {
      await c.query(`INSERT INTO output_version_bytes (output_version_id, bytes, kept_until) VALUES ($1, $2, $3)`, [
        versionId,
        p.bytes,
        new Date(at.getTime() + KEEP_UNFILED_DAYS * 86_400_000),
      ]);
    }
    return versionId;
  }

  private async event(c: PoolClient, outputId: string, kind: string, actorId: string, at: Date, opts: { versionId?: string; reason?: string | null; detail?: Record<string, unknown> } = {}): Promise<void> {
    await c.query(`INSERT INTO output_events (id, output_id, version_id, kind, actor_id, at, reason, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
      uuidv7(at.getTime()),
      outputId,
      opts.versionId ?? null,
      kind,
      actorId,
      at,
      opts.reason ?? null,
      JSON.stringify(opts.detail ?? {}),
    ]);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Registering, declining, changing and new versions (spec 4.2, 4.3; PM or Deputy)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Registers a submission. A registrar who leaves themselves out of a Restricted audience gets only that it was
   * registered: the detail is for its readers.
   */
  async register(user: AuthUser, projectId: string, outputId: string, input: RegisterInput): Promise<OutputDetail | NoLongerReadable> {
    await this.visible(user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { ctx, row } = await this.manage(c, user, projectId, outputId);
      if (row.status !== 'submitted') throw new ConflictException(row.status === 'registered' ? ALREADY_REGISTERED : NOT_SUBMITTED);
      const typeId = await this.activeType(c, input.reportTypeId);
      const categories = input.categoryIds ? await this.activeTypes(c, input.categoryIds) : [];
      const issueDate = input.issueDate ?? todayUtc8(at);
      if (input.contributors) await this.setContributors(c, ctx, outputId, input.contributors, at);
      const audience = input.audience ? await this.setAudience(c, row, input.audience, user.id, at, AUDIENCE_SET_AT_REGISTRATION) : null;
      await c.query(
        `UPDATE outputs SET status = 'registered', title = COALESCE($2, title), report_type_id = $3, issue_date = $4, registered_by = $5, registered_at = $6 WHERE id = $1`,
        [outputId, input.title ?? null, typeId, issueDate, user.id, at],
      );
      await this.setCategories(c, outputId, categories);
      await this.event(c, outputId, 'registered', user.id, at, { detail: { reportTypeId: typeId, categories: categories.length, issueDate, ...(audience ? { audience } : {}) } });
      await writeAudit(c, { at, action: 'output.registered', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail: { reportTypeId: typeId, issueDate } });
    });
    try {
      return await this.get(user, projectId, outputId);
    } catch (err) {
      if (err instanceof NotFoundException) return { id: outputId, status: 'registered', readable: false };
      throw err;
    }
  }

  /** A submission declined with a reason: Declined, still visible to its submitter; nothing is deleted. */
  async decline(user: AuthUser, projectId: string, outputId: string, reasonInput: unknown): Promise<OutputDetail> {
    await this.visible(user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { row } = await this.manage(c, user, projectId, outputId);
      if (row.status !== 'submitted') throw new ConflictException(NOT_SUBMITTED);
      const reason = readReason(reasonInput);
      await c.query(`UPDATE outputs SET status = 'declined' WHERE id = $1`, [outputId]);
      await endOutputApprovalRequests(c, outputId, user.id, at);
      await this.event(c, outputId, 'declined', user.id, at, { reason });
      await writeAudit(c, { at, action: 'output.declined', actorUserId: user.id, subjectType: 'output', subjectId: outputId });
    });
    return this.get(user, projectId, outputId);
  }

  /** Title, type, categories, issue date and contributors of a Submitted or Registered output. */
  async update(user: AuthUser, projectId: string, outputId: string, patch: OutputPatch, reason: string | null = null): Promise<OutputDetail> {
    await this.visible(user, projectId, outputId);
    const fields = Object.keys(patch).filter((k) => patch[k as keyof OutputPatch] !== undefined);
    if (fields.length === 0) throw new BadRequestException(NOTHING_TO_CHANGE);
    const at = this.clock();
    await this.tx(async (c) => {
      const { ctx, row } = await this.manage(c, user, projectId, outputId);
      if (row.status !== 'submitted' && row.status !== 'registered') throw new ConflictException(CLOSED_OUTPUT);
      if (patch.title !== undefined) await c.query(`UPDATE outputs SET title = $2 WHERE id = $1`, [outputId, patch.title]);
      if (patch.reportTypeId !== undefined) await c.query(`UPDATE outputs SET report_type_id = $2 WHERE id = $1`, [outputId, await this.activeType(c, patch.reportTypeId)]);
      if (patch.issueDate !== undefined) await c.query(`UPDATE outputs SET issue_date = $2 WHERE id = $1`, [outputId, patch.issueDate]);
      if (patch.categoryIds !== undefined) await this.setCategories(c, outputId, await this.activeTypes(c, patch.categoryIds));
      if (patch.contributors !== undefined) await this.setContributors(c, ctx, outputId, patch.contributors, at);
      await this.event(c, outputId, 'updated', user.id, at, { reason, detail: { fields } });
      await writeAudit(c, { at, action: 'output.updated', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail: { fields } });
    });
    return this.get(user, projectId, outputId);
  }

  /** A new Draft version of a Registered output, by the same routes as submitting (spec 4.3). */
  async addVersion(user: AuthUser, projectId: string, outputId: string, input: SubmitInput): Promise<OutputDetail> {
    await this.visible(user, projectId, outputId);
    const ctx = await this.access.authorize(user, 'output.manage', projectId);
    const at = this.clock();
    const cur = (
      await this.pool.query<{ title: string; typeId: string | null; issueDate: string | null; status: string; latest: number }>(
        `SELECT o.title, o.report_type_id AS "typeId", to_char(o.issue_date, 'YYYY-MM-DD') AS "issueDate", o.status,
                (SELECT COALESCE(max(v.version_no), 0) FROM output_versions v WHERE v.output_id = o.id)::int AS latest
           FROM outputs o WHERE o.id = $1`,
        [outputId],
      )
    ).rows[0];
    if (cur.status !== 'registered') throw new ConflictException(NOT_REGISTERED);
    const versionNo = cur.latest + 1;
    const prepared = await this.prepare(ctx, projectId, input, { title: cur.title, reportTypeId: cur.typeId, issueDate: cur.issueDate ?? todayUtc8(at), versionNo }, at);
    await this.tx(async (c) => {
      const { row } = await this.manage(c, user, projectId, outputId);
      if (row.status !== 'registered') throw new ConflictException(NOT_REGISTERED);
      const latest = (await c.query<{ n: number }>(`SELECT COALESCE(max(version_no), 0)::int AS n FROM output_versions WHERE output_id = $1`, [outputId])).rows[0].n;
      if (latest + 1 !== versionNo) throw new ConflictException(SAME_TIME);
      if (prepared.material) {
        // The version's material must be readable by everyone the output is read by now (D101).
        const readers = await contentReaderContexts(c, projectId, at);
        const current = readers.map((r) => r.viewerId).filter((id) => row.audienceMode !== 'restricted' || row.audienceUserIds.includes(id));
        if (current.some((id) => !prepared.material?.has(id))) throw new ConflictException(NARROW_FIRST);
      }
      const versionId = await this.insertVersion(c, outputId, projectId, versionNo, prepared, user.id, at);
      if (prepared.aiAssisted) await c.query(`UPDATE outputs SET ai_assisted = true WHERE id = $1`, [outputId]);
      await this.event(c, outputId, 'version_added', user.id, at, { versionId, detail: { versionNo, origin: prepared.origin, format: prepared.format } });
      await writeAudit(c, { at, action: 'output.version_added', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail: { versionNo, origin: prepared.origin, format: prepared.format } });
      if (prepared.exported) await recordExport(c, at, user.id, projectId, prepared.exported.kind, prepared.exported.filters, prepared.exported.rows, { outputId });
    });
    return this.get(user, projectId, outputId);
  }

  /**
   * Accepts a participant's Submitted output into an existing Registered output of the same project (spec 4.3): its
   * versions become new Draft versions of the target, numbered after the target's last, and the submission is Declined
   * with "Accepted into <target title>". The submission's material must be readable by everyone who reads the target.
   * Its bytes and any linked file move with the versions; nothing is copied or deleted.
   */
  async acceptInto(user: AuthUser, projectId: string, outputId: string, targetOutputId: string): Promise<OutputDetail> {
    await this.visible(user, projectId, outputId);
    if (targetOutputId === outputId) throw new BadRequestException(ACCEPT_INTO_ITSELF);
    await this.visible(user, projectId, targetOutputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { row: source } = await this.manage(c, user, projectId, outputId);
      const { row: target } = await this.visible(user, projectId, targetOutputId, c, true);
      if (source.status !== 'submitted') throw new ConflictException(NOT_SUBMITTED);
      if (target.status !== 'registered') throw new ConflictException(ACCEPT_INTO_REGISTERED);
      const material = await this.outputMaterial(c, source, at);
      if (material) {
        const readers = await contentReaderContexts(c, projectId, at);
        const current = readers.map((r) => r.viewerId).filter((id) => target.audienceMode !== 'restricted' || target.audienceUserIds.includes(id));
        if (current.some((id) => !material.has(id))) throw new ConflictException(NARROW_FIRST);
      }
      const t = (await c.query<{ title: string; latest: number }>(
        `SELECT o.title, (SELECT COALESCE(max(v.version_no), 0) FROM output_versions v WHERE v.output_id = o.id)::int AS latest FROM outputs o WHERE o.id = $1`,
        [targetOutputId],
      )).rows[0];
      const versions = (await c.query(
        `SELECT id, version_no AS no, origin, format, draft_version_id AS "draftVersionId", stored_file_id AS "storedFileId", sha256, size_bytes AS "sizeBytes", created_by AS "createdBy"
           FROM output_versions WHERE output_id = $1 ORDER BY version_no`,
        [outputId],
      )).rows;
      let no = t.latest;
      for (const v of versions) {
        no += 1;
        const newId = uuidv7(at.getTime());
        if (v.storedFileId) await c.query(`UPDATE output_versions SET stored_file_id = NULL WHERE id = $1`, [v.id]);
        await c.query(
          `INSERT INTO output_versions (id, output_id, version_no, origin, format, draft_version_id, stored_file_id, status, sha256, size_bytes, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10, $11)`,
          [newId, targetOutputId, no, v.origin, v.format, v.draftVersionId, v.storedFileId, v.sha256, v.sizeBytes, v.createdBy, at],
        );
        await c.query(
          `INSERT INTO output_version_bytes (output_version_id, bytes, kept_until) SELECT $2, bytes, kept_until FROM output_version_bytes WHERE output_version_id = $1`,
          [v.id, newId],
        );
        await c.query(`DELETE FROM output_version_bytes WHERE output_version_id = $1`, [v.id]);
        await this.event(c, targetOutputId, 'version_added', user.id, at, { versionId: newId, detail: { versionNo: no, origin: v.origin, format: v.format, acceptedFrom: outputId } });
      }
      await c.query(`UPDATE outputs SET ai_assisted = ai_assisted OR (SELECT ai_assisted FROM outputs WHERE id = $2) WHERE id = $1`, [targetOutputId, outputId]);
      await c.query(`UPDATE outputs SET status = 'declined' WHERE id = $1`, [outputId]);
      await endOutputApprovalRequests(c, outputId, user.id, at);
      await this.event(c, outputId, 'declined', user.id, at, { reason: `Accepted into ${t.title}`, detail: { acceptedInto: targetOutputId } });
      await writeAudit(c, { at, action: 'output.accepted_into', actorUserId: user.id, subjectType: 'output', subjectId: targetOutputId, detail: { from: outputId, versions: versions.length } });
    });
    return this.get(user, projectId, targetOutputId);
  }

  private async setCategories(c: PoolClient, outputId: string, ids: string[]): Promise<void> {
    await c.query(`DELETE FROM output_categories WHERE output_id = $1 AND NOT (report_type_id = ANY($2::uuid[]))`, [outputId, ids]);
    for (const id of ids) await c.query(`INSERT INTO output_categories (output_id, report_type_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [outputId, id]);
  }

  /**
   * Contributing people (participants of the project, current or former) and departments (active). A person already
   * recorded keeps the department recorded when they were added: it is never rewritten (outputs rules section 3).
   */
  private async setContributors(c: PoolClient, ctx: ProjectContext, outputId: string, input: ContributorInput, at: Date): Promise<void> {
    for (const p of input.people) if (!ctx.rows.some((m) => m.userId === p.userId)) throw new BadRequestException(NOT_CONTRIBUTOR);
    const departments = [...new Set([...input.departmentIds, ...input.people.map((p) => p.departmentId).filter((d): d is string => !!d)])];
    if (departments.length > 0) {
      const ok = await c.query(`SELECT count(*)::int AS n FROM departments WHERE id = ANY($1::uuid[]) AND status = 'active'`, [departments]);
      if (ok.rows[0].n !== departments.length) throw new BadRequestException(BAD_DEPARTMENT);
    }
    const existing = (await c.query<{ userId: string | null; departmentId: string | null }>(
      `SELECT user_id AS "userId", department_id AS "departmentId" FROM output_contributors WHERE output_id = $1`,
      [outputId],
    )).rows;
    const people = input.people.map((p) => p.userId);
    await c.query(`DELETE FROM output_contributors WHERE output_id = $1 AND user_id IS NOT NULL AND NOT (user_id = ANY($2::uuid[]))`, [outputId, people]);
    await c.query(`DELETE FROM output_contributors WHERE output_id = $1 AND user_id IS NULL AND NOT (department_id = ANY($2::uuid[]))`, [outputId, input.departmentIds]);
    for (const p of input.people) {
      if (existing.some((e) => e.userId === p.userId)) continue;
      await c.query(`INSERT INTO output_contributors (output_id, user_id, department_id, added_at) VALUES ($1, $2, $3, $4)`, [outputId, p.userId, p.departmentId, at]);
    }
    for (const d of input.departmentIds) {
      if (existing.some((e) => e.userId === null && e.departmentId === d)) continue;
      await c.query(`INSERT INTO output_contributors (output_id, user_id, department_id, added_at) VALUES ($1, NULL, $2, $3)`, [outputId, d, at]);
    }
  }

  /** The people who may read all the remaining Kainow material the output was built from; null when it has none. */
  private async outputMaterial(db: Db, row: OutputAccessRow, at: Date): Promise<Set<string> | null> {
    return remainingMaterialReaders(db, row, at);
  }

  /**
   * Sets the audience at registration (D101): Project-wide unless its material is narrower than the project's readers;
   * a Restricted audience names current readers of the project who can read all its material. Changing an existing
   * Restricted audience is recorded in `audience_events`.
   */
  private async setAudience(c: PoolClient, row: OutputAccessRow, change: AudienceChange, actorId: string, at: Date, reason: string): Promise<'project' | 'restricted'> {
    const readers = new Set((await contentReaderContexts(c, row.projectId, at)).map((r) => r.viewerId));
    checkOutputAudience(change, readers, await this.outputMaterial(c, row, at));
    return writeOutputAudience(c, row, change, actorId, at, reason);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Filing (spec 5.4; PM or Deputy)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Files a version of a registered output in the project's output destination: the stored file is recorded pending
   * and the `file-output` job queued in the same transaction. A version whose filing failed is filed again ("Try
   * again"). The output row is locked, so two requests at once give one stored file: the second is told the version is
   * already being filed.
   */
  async file(user: AuthUser, projectId: string, outputId: string, versionNo: number): Promise<OutputDetail> {
    await this.visible(user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { row } = await this.manage(c, user, projectId, outputId);
      const v = (
        await c.query<{ id: string; origin: string; format: string; storedFileId: string | null; state: string | null; kept: boolean; title: string }>(
          `SELECT v.id, v.origin, v.format, v.stored_file_id AS "storedFileId", f.state, o.title,
                  EXISTS (SELECT 1 FROM output_version_bytes b WHERE b.output_version_id = v.id AND b.bytes IS NOT NULL) AS kept
             FROM output_versions v JOIN outputs o ON o.id = v.output_id LEFT JOIN stored_files f ON f.id = v.stored_file_id
            WHERE v.output_id = $1 AND v.version_no = $2
              FOR UPDATE OF v`,
          [outputId, versionNo],
        )
      ).rows[0];
      if (!v) throw new NotFoundException();
      if (v.origin === 'link' || v.state === 'linked') throw new ConflictException(LINKED_NOT_FILED);
      if (row.status !== 'registered') throw new ConflictException(REGISTER_FIRST);
      if (v.state === 'pending' || v.state === 'storing') throw new ConflictException(BEING_FILED);
      if (v.state && v.state !== 'failed') throw new ConflictException(ALREADY_FILED);
      if (!v.kept) throw new ConflictException(NOT_KEPT);
      const dest = (
        await c.query<{ id: string }>(
          `SELECT d.id FROM project_output_settings s JOIN storage_destinations d ON d.id = s.destination_id
            WHERE s.project_id = $1 AND d.purpose = 'outputs' AND d.status = 'approved'`,
          [projectId],
        )
      ).rows[0];
      if (!dest) throw new BadRequestException(NO_DESTINATION);
      await requestFiling(c, { versionId: v.id, projectId, storedFileId: v.storedFileId, fileName: outputFileName(v.title, versionNo, v.format) }, dest.id, at);
      await writeAudit(c, { at, action: 'output.filing_requested', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail: { versionNo, again: v.state === 'failed' } });
    });
    return this.get(user, projectId, outputId);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Approval (spec 4.3; the PM or a Deputy asks, Owners and Sponsors approve through the project's approval policy)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Puts one exact version for approval: a pending `approve_output` change request, and the output's
   * `approval_requested` event, in one transaction. Whether the version may be approved is the handler's to say.
   */
  async requestApproval(user: AuthUser, projectId: string, outputId: string, versionNo: number): Promise<{ request: RequestView; notice: string }> {
    await this.visible(user, projectId, outputId);
    let request: RequestView | undefined;
    await this.tx(async (c) => {
      await this.visible(user, projectId, outputId, c, true);
      const v = (await c.query(`SELECT id FROM output_versions WHERE output_id = $1 AND version_no = $2`, [outputId, versionNo])).rows[0];
      if (!v) throw new NotFoundException();
      const made = await this.changes.submitWithin(c, user, projectId, { kind: 'approve_output', targetKind: 'output_version', targetId: v.id, terms: {} }, {}, () => undefined);
      request = made.request;
    });
    return { request: request as RequestView, notice: DOES_NOT_APPROVE_COMMITMENTS };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Withdrawing, deleting and restoring (spec 4.3, 4.7; PM or Deputy)
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Withdraws a Submitted or Registered output with a reason (spec 4.3): a final state; its pending approval requests
   * end and its files move to its own output folder, which has no Kainow grants (spec 5.5).
   */
  async withdrawOutput(user: AuthUser, projectId: string, outputId: string, reasonInput: unknown): Promise<OutputDetail> {
    await this.visible(user, projectId, outputId);
    const reason = readReason(reasonInput);
    const at = this.clock();
    await this.tx(async (c) => {
      await this.manage(c, user, projectId, outputId);
      await withdrawOutput(c, outputId, user.id, reason, at);
    });
    return this.get(user, projectId, outputId);
  }

  /**
   * Deletes a register entry (spec 4.7, sub-project 5's rules): by the PM or a Deputy who reads it, with a reason, while
   * the project is open. Nothing is removed: the output gains who, when and why, leaves every view and list, its
   * pending approval requests end, and its files move to its own output folder, which has no Kainow grants. The
   * external file is never deleted. A held output is not found here until its case is released.
   */
  async deleteOutput(user: AuthUser, projectId: string, outputId: string, reasonInput: unknown): Promise<{ id: string; deleted: true }> {
    await this.visible(user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { ctx, row } = await this.visible(user, projectId, outputId, c, true);
      const verdict = decide({ action: 'output.delete', roles: ctx.roles, status: ctx.project.status });
      if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
      const reason = readReason(reasonInput);
      await c.query(`UPDATE outputs SET deleted_at = $2, deleted_by = $3, delete_reason = $4 WHERE id = $1`, [outputId, at, user.id, reason]);
      await this.event(c, outputId, 'deleted', user.id, at, { reason, detail: { status: row.status } });
      await endOutputApprovalRequests(c, outputId, user.id, at);
      if (row.status === 'registered') await queueOutputPlacement(c, outputId, 'narrow');
      await writeAudit(c, { at, action: 'output.deleted', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail: { projectId, status: row.status } });
    });
    return { id: outputId, deleted: true };
  }

  /**
   * Restores a deleted output with a reason, in any project state (sub-project 5). The restorer must hold
   * `output.restore` and would read it once restored (its audience and review rules are checked again now); anyone who
   * would not read it is told nothing (404). Its files move back where its readers need them, and are shared again.
   */
  async restoreOutput(user: AuthUser, projectId: string, outputId: string, reasonInput: unknown): Promise<OutputDetail> {
    await this.deletedFor(this.pool, user, projectId, outputId);
    const at = this.clock();
    await this.tx(async (c) => {
      const { row } = await this.deletedFor(c, user, projectId, outputId, true);
      const reason = readReason(reasonInput);
      await c.query(`UPDATE outputs SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = $1`, [outputId]);
      await this.event(c, outputId, 'restored', user.id, at, { reason, detail: { status: row.status } });
      if (row.status === 'registered') await queueOutputPlacement(c, outputId, 'widen');
      await writeAudit(c, { at, action: 'output.restored', actorUserId: user.id, subjectType: 'output', subjectId: outputId, detail: { projectId, status: row.status } });
    });
    return this.get(user, projectId, outputId);
  }

  /** The project's deleted outputs this person may restore (each one they would read once restored), newest deletion first. */
  async deletedOutputs(user: AuthUser, projectId: string): Promise<DeletedOutput[]> {
    const ctx = await this.access.context(user, projectId);
    if (!decide({ action: 'output.restore', roles: ctx.roles, status: ctx.project.status }).allowed) return [];
    const { rows } = await this.pool.query(
      `SELECT o.id, o.title, o.status, o.deleted_at AS "deletedAt", o.deleted_by AS "deletedById", u.display_name AS "deletedByName", o.delete_reason AS reason
         FROM outputs o JOIN users u ON u.id = o.deleted_by
        WHERE o.project_id = $1 AND o.deleted_at IS NOT NULL AND o.held_case_id IS NULL
        ORDER BY o.deleted_at DESC, lower(o.title), o.id`,
      [projectId],
    );
    const out: DeletedOutput[] = [];
    for (const r of rows) {
      const row = await loadOutputAccessRow(this.pool, r.id);
      if (!row || !(await readsOutput(this.pool, ctx, { ...row, deletedAt: null }))) continue;
      out.push({ id: r.id, title: r.title, status: r.status, deletedAt: r.deletedAt, deletedBy: { id: r.deletedById, displayName: r.deletedByName }, reason: r.reason });
    }
    return out;
  }

  /**
   * A deleted output for someone who may restore it: 404 unless it is deleted (and not held) in this project and they
   * would read it once restored; then 403 unless they hold `output.restore`. With `lock`, the project and output rows
   * are locked.
   */
  private async deletedFor(db: Db, user: AuthUser, projectId: string, outputId: string, lock = false): Promise<{ ctx: ProjectContext; row: OutputAccessRow }> {
    if (!UUID.test(outputId)) throw new NotFoundException();
    const ctx = await this.access.context(user, projectId, db, lock);
    if (lock) await db.query(`SELECT 1 FROM outputs WHERE id = $1 FOR UPDATE`, [outputId]);
    const row = await loadOutputAccessRow(db, outputId);
    if (!row || row.projectId !== projectId || !row.deletedAt || row.heldCaseId) throw new NotFoundException();
    if (!(await readsOutput(db, ctx, { ...row, deletedAt: null }))) throw new NotFoundException();
    const verdict = decide({ action: 'output.restore', roles: ctx.roles, status: ctx.project.status });
    if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
    return { ctx, row };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reading (spec 4.6)
  // -------------------------------------------------------------------------------------------------------------------

  /** The register: outputs this person may see, latest issue date first (undated last), then title. */
  async list(user: AuthUser, projectId: string, filters: { status?: string; reportTypeId?: string } = {}): Promise<OutputSummary[]> {
    const ctx = await this.access.context(user, projectId);
    const params: unknown[] = [projectId];
    let where = '';
    if (filters.status) {
      params.push(filters.status);
      where += ` AND o.status = $${params.length}`;
    }
    if (filters.reportTypeId) {
      params.push(filters.reportTypeId);
      where += ` AND (o.report_type_id = $${params.length} OR EXISTS (SELECT 1 FROM output_categories oc WHERE oc.output_id = o.id AND oc.report_type_id = $${params.length}))`;
    }
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT o.id FROM outputs o WHERE o.project_id = $1 AND o.deleted_at IS NULL ${where} ORDER BY o.issue_date DESC NULLS LAST, lower(o.title), o.id`,
      params,
    );
    const out: OutputSummary[] = [];
    for (const r of rows) {
      const row = await loadOutputAccessRow(this.pool, r.id);
      if (row && (await readsOutput(this.pool, ctx, row))) out.push(await this.summary(ctx, r.id));
    }
    return out;
  }

  async get(user: AuthUser, projectId: string, outputId: string): Promise<OutputDetail> {
    const { ctx, row } = await this.visible(user, projectId, outputId);
    const s = await this.summary(ctx, outputId);
    const o = (
      await this.pool.query(
        `SELECT o.registered_by AS "registeredById", ru.display_name AS "registeredByName", a.mode AS "audienceMode"
           FROM outputs o LEFT JOIN users ru ON ru.id = o.registered_by LEFT JOIN audiences a ON a.id = o.audience_id WHERE o.id = $1`,
        [outputId],
      )
    ).rows[0];
    const audiencePeople = (
      await this.pool.query<Person>(
        `SELECT u.id, u.display_name AS "displayName" FROM outputs o JOIN audiences a ON a.id = o.audience_id AND a.mode = 'restricted'
           JOIN audience_members am ON am.audience_id = a.id JOIN users u ON u.id = am.user_id WHERE o.id = $1 ORDER BY u.display_name, u.id`,
        [outputId],
      )
    ).rows;
    const contributors = (
      await this.pool.query(
        `SELECT oc.user_id AS "userId", u.display_name AS "displayName", oc.department_id AS "departmentId", d.name AS "departmentName"
           FROM output_contributors oc LEFT JOIN users u ON u.id = oc.user_id LEFT JOIN departments d ON d.id = oc.department_id
          WHERE oc.output_id = $1 ORDER BY u.display_name NULLS LAST, d.name NULLS LAST, oc.user_id, oc.department_id`,
        [outputId],
      )
    ).rows;
    const history = (
      await this.pool.query(
        `SELECT e.kind, e.at, e.actor_id AS "actorId", u.display_name AS "actorName", e.reason, v.version_no AS "versionNo"
           FROM output_events e LEFT JOIN users u ON u.id = e.actor_id LEFT JOIN output_versions v ON v.id = e.version_id
          WHERE e.output_id = $1 ORDER BY e.at, e.id`,
        [outputId],
      )
    ).rows;
    const manage = decide({ action: 'output.manage', roles: ctx.roles, status: ctx.project.status }).allowed;
    // The same rule as the audience routes (spec 11): `output.audience`, reading all the remaining material, still open.
    const audience =
      decide({ action: 'output.audience', roles: ctx.roles, status: ctx.project.status }).allowed &&
      (s.status === 'submitted' || s.status === 'registered') &&
      (await readsRemainingMaterial(this.pool, ctx, row));
    // People Kainow could not share the files with, for the PM, Deputies, Owner and Sponsors (spec 5.5).
    const notShared = ctx.roles.some((r) => OUTPUT_MANAGER_ROLES.includes(r)) ? await notSharedFor(this.pool, outputId) : undefined;
    return {
      ...s,
      ...(notShared ? { notShared } : {}),
      projectId,
      registeredBy: o.registeredById ? { id: o.registeredById, displayName: o.registeredByName } : null,
      audience: { mode: o.audienceMode === 'restricted' ? 'restricted' : 'project', people: o.audienceMode === 'restricted' ? audiencePeople : [] },
      contributors: {
        people: contributors.filter((x) => x.userId).map((x) => ({ id: x.userId, displayName: x.displayName, departmentId: x.departmentId, departmentName: x.departmentName })),
        departments: contributors.filter((x) => !x.userId).map((x) => ({ id: x.departmentId, name: x.departmentName })),
      },
      versions: await this.versions(ctx, outputId),
      history: history.map((h) => ({ kind: h.kind, at: h.at, actor: h.actorId ? { id: h.actorId, displayName: h.actorName } : null, reason: h.reason, versionNo: h.versionNo ?? null })),
      may: {
        register: manage && s.status === 'submitted',
        decline: manage && s.status === 'submitted',
        update: manage && (s.status === 'submitted' || s.status === 'registered'),
        addVersion: manage && s.status === 'registered',
        changeAudience: audience,
        review: audience && s.reviewRequired,
      },
    };
  }

  private async summary(ctx: ProjectContext, outputId: string): Promise<OutputSummary> {
    const o = (
      await this.pool.query(
        `SELECT o.id, o.title, o.status, o.review_state AS "reviewState", o.report_type_id AS "typeId", t.name AS "typeName",
                to_char(o.issue_date, 'YYYY-MM-DD') AS "issueDate", o.author_id AS "authorId", u.display_name AS "authorName", o.ai_assisted AS "aiAssisted",
                a.mode AS "audienceMode", o.created_at AS "createdAt", o.registered_at AS "registeredAt"
           FROM outputs o JOIN users u ON u.id = o.author_id LEFT JOIN report_types t ON t.id = o.report_type_id LEFT JOIN audiences a ON a.id = o.audience_id
          WHERE o.id = $1`,
        [outputId],
      )
    ).rows[0];
    const categories = (
      await this.pool.query<{ id: string; name: string }>(
        `SELECT t.id, t.name FROM output_categories oc JOIN report_types t ON t.id = oc.report_type_id WHERE oc.output_id = $1 ORDER BY t.position, lower(t.name), t.id`,
        [outputId],
      )
    ).rows;
    const versions = await this.versions(ctx, outputId);
    return {
      id: o.id,
      title: o.title,
      status: o.status,
      reviewRequired: o.reviewState === 'review_required',
      reviewLabel: o.reviewState === 'review_required' ? ACCESS_REVIEW_LABEL : null,
      reportType: o.typeId ? { id: o.typeId, name: o.typeName } : null,
      categories,
      issueDate: o.issueDate,
      author: { id: o.authorId, displayName: o.authorName },
      aiAssisted: o.aiAssisted,
      audience: { mode: o.audienceMode === 'restricted' ? 'restricted' : 'project' },
      latestVersion: versions.at(-1) ?? null,
      createdAt: o.createdAt,
      registeredAt: o.registeredAt,
    };
  }

  private async versions(ctx: ProjectContext, outputId: string): Promise<OutputVersionView[]> {
    const seesPath = ctx.roles.some((r) => OUTPUT_MANAGER_ROLES.includes(r));
    const { rows } = await this.pool.query(
      `SELECT v.version_no AS no, v.origin, v.format, v.status, v.size_bytes AS "sizeBytes", v.created_at AS "createdAt",
              v.created_by AS "createdById", u.display_name AS "createdByName",
              f.state AS "fileState", f.failure_code AS "failureCode", f.check_status AS "checkStatus", f.last_checked_at AS "lastCheckedAt", f.path,
              b.output_version_id IS NOT NULL AND b.bytes IS NOT NULL AS kept,
              CASE WHEN f.destination_id IS DISTINCT FROM s.destination_id THEN d.label END AS "otherDestination",
              ${changeStateSql('v.id').registered} AS "changeRegistered", ${changeStateSql('v.id').pending} AS "changePending",
              ${changeStateSql('v.id').failed} AS "changeFailed",
              CASE WHEN split_part(sf.key, '/', 1) <> p.owning_department_id::text THEN split_part(sf.key, '/', 1) END AS "awayDepartmentId",
              ad.name AS "awayDepartment"
         FROM output_versions v JOIN users u ON u.id = v.created_by
         JOIN outputs o ON o.id = v.output_id
         JOIN projects p ON p.id = o.project_id
         LEFT JOIN project_output_settings s ON s.project_id = o.project_id
         LEFT JOIN stored_files f ON f.id = v.stored_file_id
         LEFT JOIN storage_destinations d ON d.id = f.destination_id
         LEFT JOIN output_version_bytes b ON b.output_version_id = v.id
         LEFT JOIN storage_folders sf ON sf.id = f.folder_id
         LEFT JOIN departments ad ON ad.id::text = split_part(sf.key, '/', 1)
        WHERE v.output_id = $1 ORDER BY v.version_no`,
      [outputId],
    );
    // The project's latest department transfer, for files still filed under the department it left (spec 10).
    const transfer = (
      await this.pool.query<{ from: string; choice: string | null; state: string }>(
        `SELECT from_department_id AS from, folder_choice AS choice, state FROM project_department_transfers
          WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 1`,
        [ctx.project.id],
      )
    ).rows[0];
    /** For files the latest transfer chose to move: "Moving files", or after a failure where they still are. */
    const pendingMove = transfer?.choice === 'move' && transfer.state !== 'done'
      ? transfer.state === 'moving' ? MOVING_LABEL : notMovedLabel(await oldPlaces(this.pool, ctx.project.id, transfer.from))
      : null;
    const mayFile = decide({ action: 'output.manage', roles: ctx.roles, status: ctx.project.status }).allowed;
    return rows.map((r) => {
      let filing: Filing;
      if ((!r.fileState || r.fileState === 'failed') && !r.kept) {
        // Not filed and its bytes are gone (90 days unfiled, spec 5.4): there is nothing left to file.
        filing = { state: 'not_kept', label: NOT_KEPT, checkStatus: null, lastCheckedAt: null };
      } else if (!r.fileState) {
        filing = { state: 'not_filed', label: 'Not filed', checkStatus: null, lastCheckedAt: null };
      } else if (r.fileState === 'failed') {
        filing = { state: 'failed', label: filingFailedLabel(r.failureCode), checkStatus: r.checkStatus, lastCheckedAt: r.lastCheckedAt };
        if (mayFile) filing.tryAgain = true;
      } else if (r.fileState === 'linked') {
        filing = { state: 'linked', label: KEPT_LABEL, sharing: SHARING_OUTSIDE, checkStatus: r.checkStatus, lastCheckedAt: r.lastCheckedAt };
      } else {
        filing = { state: r.fileState, label: STORED_LABELS[r.fileState] ?? r.fileState, checkStatus: r.checkStatus, lastCheckedAt: r.lastCheckedAt };
      }
      if (r.fileState === 'stored' || r.fileState === 'linked') {
        const status = r.checkStatus as CheckStatus;
        filing.checkLabel = checkLabel(status, r.status);
        filing.actions = checkActions(status, mayFile, { filed: r.fileState === 'stored', pending: r.changePending });
        if (status === 'changed' && r.changeRegistered) filing.recovery = NOT_RECOVERED;
        if (status === 'changed' && r.changePending) filing.registering = REGISTER_PENDING;
        if (status === 'changed' && r.changeFailed && mayFile) filing.registerFailed = REGISTER_FAILED;
        if (seesPath && r.otherDestination) filing.destination = r.otherDestination;
      }
      if (seesPath && r.fileState) filing.path = r.path;
      if (r.awayDepartmentId && ['stored', 'relocating', 'withheld', 'missing'].includes(r.fileState)) {
        filing.location = pendingMove && transfer?.from === r.awayDepartmentId ? pendingMove : keptLabel(r.awayDepartment);
      }
      return {
        no: r.no,
        origin: r.origin,
        format: r.format,
        status: r.status,
        sizeBytes: Number(r.sizeBytes),
        createdAt: r.createdAt,
        createdBy: { id: r.createdById, displayName: r.createdByName },
        filing,
      };
    });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Access helpers
  // -------------------------------------------------------------------------------------------------------------------

  /** The output, for someone who may see it now: 404 for anyone else (before any 403, so its existence is not revealed). */
  async visible(user: AuthUser, projectId: string, outputId: string, db: Db = this.pool, lock = false): Promise<{ ctx: ProjectContext; row: OutputAccessRow }> {
    if (!UUID.test(outputId)) throw new NotFoundException();
    const ctx = await this.access.context(user, projectId, db, lock);
    if (lock) await db.query(`SELECT 1 FROM outputs WHERE id = $1 FOR UPDATE`, [outputId]);
    const row = await loadOutputAccessRow(db, outputId);
    if (!row || row.projectId !== projectId || !(await readsOutput(db, ctx, row))) throw new NotFoundException();
    return { ctx, row };
  }

  /** The output, for the PM or a Deputy (`output.manage`), not locked: 404, then 403 with the matrix's reason. */
  async assertManage(user: AuthUser, projectId: string, outputId: string): Promise<{ ctx: ProjectContext; row: OutputAccessRow }> {
    const seen = await this.visible(user, projectId, outputId);
    const verdict = decide({ action: 'output.manage', roles: seen.ctx.roles, status: seen.ctx.project.status });
    if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
    return seen;
  }

  /** The output locked for a change by the PM or a Deputy (`output.manage`): 404, then 403 with the matrix's reason. */
  private async manage(c: PoolClient, user: AuthUser, projectId: string, outputId: string): Promise<{ ctx: ProjectContext; row: OutputAccessRow }> {
    const seen = await this.visible(user, projectId, outputId, c, true);
    const verdict = decide({ action: 'output.manage', roles: seen.ctx.roles, status: seen.ctx.project.status });
    if (!verdict.allowed) throw new ForbiddenException(verdict.reason);
    return seen;
  }

  private async tx(work: (c: PoolClient) => Promise<void>): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await work(c);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
