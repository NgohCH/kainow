/**
 * The audit events of the updater (10b spec 9). One small function per action, so each action is a literal the
 * analytics catalogue test can see. Never put command output, keys or typed text in `detail`; fixed codes and versions only.
 */
import type { Pool, PoolClient } from 'pg';
import { type AuditEvent, writeAudit } from '../audit/audit';

type Db = Pool | PoolClient;
type Event = Omit<AuditEvent, 'action'>;

export const auditReleaseAvailable = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.release_available' });
export const auditUpdateApproved = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_approved' });
export const auditUpdateRescheduled = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_rescheduled' });
export const auditUpdateCancelled = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_cancelled' });
export const auditUpdateRefused = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_refused' });
export const auditUpdateSucceeded = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_succeeded' });
export const auditUpdateFailed = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_failed' });
export const auditUpdateRecovered = (db: Db, e: Event) => writeAudit(db, { ...e, action: 'ops.update_recovered' });
