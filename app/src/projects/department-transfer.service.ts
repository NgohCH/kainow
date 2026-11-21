import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { readReason } from '../common/reason';
import { UUID, uuidv7 } from '../common/uuid7';
import { PG_POOL } from '../db/database.module';
import { queueStorageJob } from '../storage/outbox';
import { ProjectAccess, type ProjectContext } from './access.service';
import { MOVING_LABEL, type RejectedReason, keptLabel, moveClashes, notMovedLabel, oldPlaces, rejectedLabel } from './department-transfer';

export const ADMIN_ONLY = 'Only an Enterprise Administrator can change a project’s owning department.';
export const CHOOSE_FOLDER = 'This project has filed outputs. Choose whether to move the project’s folder or keep it where it is.';
const CHOOSE_DEPARTMENT = 'Choose an active department.';
const SAME_DEPARTMENT = 'The project already belongs to that department.';
const CONTRIBUTES = 'That department contributes to this project; remove it from the contributing departments first.';
const STILL_MOVING = 'The project’s files are still being moved. Wait until the move finishes.';
const LAST_MOVE_FAILED = 'The last folder move did not finish. Try it again before changing the department again.';
const FOLDER_THERE = 'Kainow already keeps a folder for this project under that department. Choose "Keep it where it is" instead.';
const NOTHING_TO_RETRY = 'There is no failed move of this project’s files to try again.';

export type FolderChoice = 'move' | 'keep';
export type TransferState = 'done' | 'moving' | 'move_failed' | 'rejected';

export interface TransferView {
  id: string;
  from: { id: string; name: string };
  to: { id: string; name: string };
  reason: string;
  folderChoice: FolderChoice | null;
  state: TransferState;
  actor: string;
  at: Date;
  /**
   * "Moving files", "Files not moved — still at <old path>", "Kept at its existing location (filed under <old department>)",
   * "Move rejected: <reason>. …", or null.
   */
  label: string | null;
  /** On a failed move: the Enterprise Administrator may try again. */
  tryAgain?: true;
}

/** The output files a transfer concerns: filed (or in storage) in a project folder, not linked. */
export async function filedOutputFiles(db: Pool | PoolClient, projectId: string): Promise<number> {
  return (
    await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM stored_files
        WHERE project_id = $1 AND purpose = 'output' AND item_id IS NOT NULL AND removed_at IS NULL
          AND state IN ('stored', 'relocating', 'withheld', 'missing')`,
      [projectId],
    )
  ).rows[0].n;
}

/**
 * Changing a project's owning department (spec 10, D108): the Enterprise Administrator only, in any project state, with
 * a reason and, when the project has filed outputs, a choice for their folder. One transaction updates the project,
 * records the transfer and writes the audit; "Move the folder" queues the `transfer-folders` job in it (the storage side
 * is department-transfer.ts). Leadership department scopes follow `owning_department_id` at once; contributing
 * departments and contributor attribution are not touched.
 */
@Injectable()
export class DepartmentTransferService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly access: ProjectAccess,
  ) {}

  async transferDepartment(
    user: AuthUser, projectId: string, input: { departmentId?: unknown; reason?: unknown; folderChoice?: unknown },
  ): Promise<{ transferId: string; state: 'done' | 'moving' }> {
    const at = this.now();
    return this.tx(async (c) => {
      await this.admin(user, projectId, c, true);
      const reason = readReason(input.reason, 'a reason', { refusal: 'A reason is required.' });
      const to = input.departmentId;
      if (typeof to !== 'string' || !UUID.test(to)) throw new BadRequestException(CHOOSE_DEPARTMENT);
      if (!(await c.query(`SELECT 1 FROM departments WHERE id = $1 AND status = 'active'`, [to])).rowCount) throw new BadRequestException(CHOOSE_DEPARTMENT);
      const from = (await c.query<{ d: string }>(`SELECT owning_department_id AS d FROM projects WHERE id = $1`, [projectId])).rows[0].d;
      if (from === to) throw new ConflictException(SAME_DEPARTMENT);
      if ((await c.query(`SELECT 1 FROM project_departments WHERE project_id = $1 AND department_id = $2`, [projectId, to])).rowCount) {
        throw new ConflictException(CONTRIBUTES);
      }
      const latest = (await c.query<{ state: string }>(`SELECT state FROM project_department_transfers WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 1`, [projectId])).rows[0];
      if (latest?.state === 'moving') throw new ConflictException(STILL_MOVING);
      if (latest?.state === 'move_failed') throw new ConflictException(LAST_MOVE_FAILED);
      const filedFiles = await filedOutputFiles(c, projectId);
      let folderChoice: FolderChoice | null = null;
      if (filedFiles > 0) {
        if (input.folderChoice !== 'move' && input.folderChoice !== 'keep') throw new BadRequestException(CHOOSE_FOLDER);
        folderChoice = input.folderChoice;
        if (folderChoice === 'move' && (await moveClashes(c, projectId, from, to))) throw new ConflictException(FOLDER_THERE);
      }
      const state = folderChoice === 'move' ? 'moving' : 'done';
      const transferId = uuidv7(at.getTime());
      await c.query(`UPDATE projects SET owning_department_id = $2 WHERE id = $1`, [projectId, to]);
      await c.query(
        `INSERT INTO project_department_transfers (id, project_id, from_department_id, to_department_id, reason, folder_choice, state, actor_id, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [transferId, projectId, from, to, reason, folderChoice, state, user.id, at],
      );
      await writeAudit(c, {
        at, action: 'project.department_transferred', actorUserId: user.id, subjectType: 'project', subjectId: projectId,
        detail: { from, to, folderChoice, filedFiles },
      });
      if (state === 'moving') await queueStorageJob(c, 'transfer-folders', transferId);
      return { transferId, state };
    });
  }

  /** "Try again" on a failed move: the project's latest transfer only, back to Moving files with the job queued. */
  async retry(user: AuthUser, projectId: string): Promise<{ transferId: string; state: 'moving' }> {
    const at = this.now();
    return this.tx(async (c) => {
      await this.admin(user, projectId, c, true);
      const latest = (
        await c.query<{ id: string; state: string }>(`SELECT id, state FROM project_department_transfers WHERE project_id = $1 ORDER BY at DESC, id DESC LIMIT 1 FOR UPDATE`, [projectId])
      ).rows[0];
      if (!latest || latest.state !== 'move_failed') throw new ConflictException(NOTHING_TO_RETRY);
      await c.query(`UPDATE project_department_transfers SET state = 'moving' WHERE id = $1`, [latest.id]);
      await queueStorageJob(c, 'transfer-folders', latest.id);
      await writeAudit(c, { at, action: 'project.department_transfer_retried', actorUserId: user.id, subjectType: 'project', subjectId: projectId, detail: { transferId: latest.id } });
      return { transferId: latest.id, state: 'moving' as const };
    });
  }

  /** The organisation panel's view: the owning department, how many filed files a transfer concerns, and the latest transfer. */
  async view(user: AuthUser, projectId: string): Promise<{ department: { id: string; name: string }; filedFiles: number; transfer: TransferView | null }> {
    await this.admin(user, projectId, this.pool);
    const department = (
      await this.pool.query<{ id: string; name: string }>(`SELECT d.id, d.name FROM projects p JOIN departments d ON d.id = p.owning_department_id WHERE p.id = $1`, [projectId])
    ).rows[0];
    const r = (
      await this.pool.query(
        `SELECT t.id, t.from_department_id AS "fromId", f.name AS "fromName", t.to_department_id AS "toId", d.name AS "toName", t.reason,
                t.folder_choice AS "folderChoice", t.state, t.rejected_reason AS "rejectedReason", u.display_name AS actor, t.at
           FROM project_department_transfers t JOIN departments f ON f.id = t.from_department_id JOIN departments d ON d.id = t.to_department_id
           JOIN users u ON u.id = t.actor_id
          WHERE t.project_id = $1 ORDER BY t.at DESC, t.id DESC LIMIT 1`,
        [projectId],
      )
    ).rows[0];
    let transfer: TransferView | null = null;
    if (r) {
      const label =
        r.state === 'moving' ? MOVING_LABEL
        : r.state === 'move_failed' ? notMovedLabel(await oldPlaces(this.pool, projectId, r.fromId))
        : r.state === 'rejected' ? rejectedLabel(r.rejectedReason as RejectedReason, r.fromName)
        : r.folderChoice === 'keep' ? keptLabel(r.fromName)
        : null;
      transfer = {
        id: r.id, from: { id: r.fromId, name: r.fromName }, to: { id: r.toId, name: r.toName }, reason: r.reason, folderChoice: r.folderChoice,
        state: r.state, actor: r.actor, at: r.at, label,
      };
      if (r.state === 'move_failed') transfer.tryAgain = true;
    }
    return { department, filedFiles: await filedOutputFiles(this.pool, projectId), transfer };
  }

  private async admin(user: AuthUser, projectId: string, db: Pool | PoolClient, lock = false): Promise<ProjectContext> {
    const ctx = await this.access.context(user, projectId, db, lock);
    if (!ctx.isAdmin) throw new ForbiddenException(ADMIN_ONLY);
    return ctx;
  }

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await work(c);
      await c.query('COMMIT');
      return out;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }
}
