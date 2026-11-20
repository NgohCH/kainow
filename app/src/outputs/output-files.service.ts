import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { decide } from '../projects/matrix';
import { STORAGE_CONNECTORS, type StorageConnectorFactory, StorageWaitingForKey } from '../storage/connector-factory';
import { makeStorageNotify } from '../storage/notices';
import { quickXorHash } from '../storage/quickxor';
import { StorageError } from '../storage/types';
import {
  BLOCKING, type CheckDeps, type CheckStatus, FileActionRefused, OPEN_CHECK_MS, checkActions, checkFile, checkLabel, loadFile,
  registerChangedContent, relinkFile,
} from './checks';
import { NOT_KEPT, filingFailedLabel } from './filing';
import { OutputsService, type OutputDetail } from './outputs.service';

/** Shown when the provider cannot be asked right now (a download, relink or registering a change). */
export const STORE_UNREACHABLE = 'The storage service cannot be reached right now. Try again later.';

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};

/** Why a version's file is not opened: its filing or check state, its label, and what the PM or a Deputy can do. */
export interface FileRefusal { state: string; label: string; actions: string[] }

export interface DownloadedFile { filename: string; mediaType: string; bytes: Buffer }

interface VersionFile { versionId: string; status: string; format: string; fileId: string | null; state: string | null; failureCode: string | null }

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Opening and downloading filed or linked output versions through Kainow (spec 5.7), and the PM's and Deputies'
 * reconciliation of what the checks find (spec 5.8, D107). Readers only (404 for anyone else); reconciliation is
 * `output.manage`.
 */
@Injectable()
export class OutputFilesService {
  private readonly deps: CheckDeps;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(STORAGE_CONNECTORS) connectors: StorageConnectorFactory,
    private readonly outputs: OutputsService,
  ) {
    this.deps = { pool, connectors, clock, notify: makeStorageNotify(pool, clock) };
  }

  /**
   * The web URL to send a reader to, after a quick check (at most once a minute per file: a file found as recorded
   * less than a minute ago is not asked about again). A file found Changed, Missing or Access denied is refused with its
   * state instead; a moved file is opened where it is now; when the provider cannot be asked the last known place is
   * used unless the last check found it unusable.
   */
  async open(user: AuthUser, projectId: string, outputId: string, versionNo: number): Promise<string> {
    const { ctx } = await this.outputs.visible(user, projectId, outputId);
    const manages = decide({ action: 'output.manage', roles: ctx.roles, status: ctx.project.status }).allowed;
    const v = await this.versionFile(outputId, versionNo);
    const f = v.fileId ? await loadFile(this.pool, v.fileId) : undefined;
    if (!f || (f.state !== 'stored' && f.state !== 'linked')) throw this.notOpenable(v);
    const fresh = f.check_status === 'ok' && f.last_checked_at && this.clock().getTime() - new Date(f.last_checked_at).getTime() < OPEN_CHECK_MS;
    if (fresh && f.web_url) return f.web_url;
    const checked = await checkFile(this.deps, f.id);
    const status: CheckStatus = checked.status === 'unverified' ? f.check_status : checked.status;
    if (BLOCKING.includes(status)) throw this.refused(status, v.status, manages);
    const url = checked.item?.webUrl ?? f.web_url;
    if (!url) throw this.refused('unverified', v.status, manages);
    return url;
  }

  /**
   * The file, streamed through Kainow from the provider, for readers. The bytes are checked against the record (the
   * SHA-256 of a filed file; size and QuickXorHash of a linked one) before they are handed out: a file that differs is
   * found Changed and refused, like one already Changed, Missing or Access denied.
   */
  async download(user: AuthUser, projectId: string, outputId: string, versionNo: number): Promise<DownloadedFile> {
    const { ctx } = await this.outputs.visible(user, projectId, outputId);
    const manages = decide({ action: 'output.manage', roles: ctx.roles, status: ctx.project.status }).allowed;
    const v = await this.versionFile(outputId, versionNo);
    const f = v.fileId ? await loadFile(this.pool, v.fileId) : undefined;
    if (!f || (f.state !== 'stored' && f.state !== 'linked') || !f.destination_id || !f.item_id) throw this.notOpenable(v);
    if (BLOCKING.includes(f.check_status)) throw this.refused(f.check_status, v.status, manages);
    if (f.dest_status !== 'approved') throw this.refused((await checkFile(this.deps, f.id)).status, v.status, manages);
    let bytes: Buffer;
    try {
      const { connector, dest } = await this.deps.connectors.forDestination(f.destination_id);
      bytes = await connector.download(dest, f.item_id);
    } catch (err) {
      if (err instanceof StorageError && (err.code === 'not_found' || err.code === 'forbidden')) {
        throw this.refused((await checkFile(this.deps, f.id)).status, v.status, manages);
      }
      if (err instanceof StorageError || err instanceof StorageWaitingForKey) throw new ServiceUnavailableException(STORE_UNREACHABLE);
      throw err;
    }
    const sizeOk = f.size_bytes === null || Number(f.size_bytes) === bytes.length;
    const same = f.state === 'stored' && f.sha256 ? sha256(bytes) === f.sha256 : !f.provider_hash || quickXorHash(bytes) === f.provider_hash;
    if (!sizeOk || !same) {
      const status = (await checkFile(this.deps, f.id)).status;
      throw this.refused(BLOCKING.includes(status) ? status : 'changed', v.status, manages);
    }
    return { filename: f.name, mediaType: MEDIA_TYPES[v.format] ?? 'application/octet-stream', bytes };
  }

  /** PM or Deputy: points a moved or missing file at where it is now (the same item, or the one `url` names). */
  async relink(user: AuthUser, projectId: string, outputId: string, versionNo: number, url: string | null): Promise<OutputDetail> {
    await this.outputs.assertManage(user, projectId, outputId);
    const v = await this.versionFile(outputId, versionNo);
    if (!v.fileId) throw this.notOpenable(v);
    await this.reconcile(() => relinkFile(this.deps, v.fileId as string, user.id, url));
    return this.outputs.get(user, projectId, outputId);
  }

  /** PM or Deputy: registers a changed file's current content as a new Draft version and restores the original where it can. */
  async registerChanged(user: AuthUser, projectId: string, outputId: string, versionNo: number): Promise<OutputDetail> {
    await this.outputs.assertManage(user, projectId, outputId);
    const v = await this.versionFile(outputId, versionNo);
    await this.reconcile(() => registerChangedContent(this.deps, v.versionId, user.id));
    return this.outputs.get(user, projectId, outputId);
  }

  private async reconcile(work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (err instanceof FileActionRefused) throw new ConflictException(err.message);
      if (err instanceof StorageError || err instanceof StorageWaitingForKey) throw new ServiceUnavailableException(STORE_UNREACHABLE);
      throw err;
    }
  }

  private async versionFile(outputId: string, versionNo: number): Promise<VersionFile> {
    const v = (
      await this.pool.query<VersionFile>(
        `SELECT v.id AS "versionId", v.status, v.format, v.stored_file_id AS "fileId", f.state, f.failure_code AS "failureCode"
           FROM output_versions v LEFT JOIN stored_files f ON f.id = v.stored_file_id
          WHERE v.output_id = $1 AND v.version_no = $2`,
        [outputId, versionNo],
      )
    ).rows[0];
    if (!v) throw new NotFoundException();
    return v;
  }

  /** A version with no file to open: not filed (or no longer kept), waiting, failed, withheld or moving. */
  private notOpenable(v: VersionFile): ConflictException {
    const label =
      !v.state ? 'Not filed'
      : v.state === 'failed' ? filingFailedLabel(v.failureCode)
      : v.state === 'pending' || v.state === 'storing' ? 'Waiting to file'
      : v.state === 'withheld' ? 'Withheld'
      : v.state === 'relocating' ? 'Moving'
      : v.state === 'missing' ? 'Missing'
      : NOT_KEPT;
    const body: FileRefusal = { state: v.state ?? 'not_filed', label, actions: [] };
    return new ConflictException({ statusCode: 409, message: label, ...body });
  }

  private refused(status: CheckStatus, versionStatus: string, manages: boolean): ConflictException {
    const body: FileRefusal = { state: status, label: checkLabel(status, versionStatus), actions: checkActions(status, manages) };
    return new ConflictException({ statusCode: 409, message: body.label, ...body });
  }
}
