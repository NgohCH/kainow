import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { ModelsService } from '../ai/models.service';
import { CLOCK, type AuthUser, type Clock } from '../auth/tokens';
import { PolicyService } from '../changes/policy.service';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../db/database.module';
import { FeedbackService } from '../discussion/feedback.service';
import { GoLiveService } from '../golive/golive.service';
import { LeadershipGrantsService } from '../leadership/grants.service';
import { NotificationSettingsService } from '../notifications/settings.service';
import { OperationsService } from '../ops/operations.service';
import { AccessSettingsService } from '../organisation/access-settings.service';
import { OrganisationProfileService } from '../organisation/organisation.service';
import { ReportTypesService } from '../outputs/report-types.service';
import { OrganisationService } from '../projects/organisation.service';
import { SecurityService } from '../quarantine/security.service';
import { ResourceSettingsService } from '../resources/settings.service';
import { StorageSummaryService } from '../storage/summary.service';
import { UsersService } from '../users/users.service';
import {
  type OperationsInput, type SettingSummary, accessRule, administratorsRule, aiRule, approvalsRule, departmentsRule, domainsRule,
  emailDeliveryRule, escalatedFeedbackRule, goLiveRule, leadershipRule, operationsRule, organisationRule, remindersRule, reportTypesRule,
  resourcesRule, securityReviewRule, settle, stageTemplatesRule, storageRule,
} from './rules';

const DAY_MS = 86_400_000;
const SEVERITY = { normal: 0, unknown: 1, warning: 2, critical: 3 } as const;

/** The Settings hub's boxes, in hub order. Each setting is read through the service its own page uses. */
@Injectable()
export class SettingsSummaryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly organisation: OrganisationProfileService,
    private readonly users: UsersService,
    private readonly org: OrganisationService,
    private readonly grants: LeadershipGrantsService,
    private readonly policy: PolicyService,
    private readonly notifications: NotificationSettingsService,
    private readonly access: AccessSettingsService,
    private readonly resources: ResourceSettingsService,
    private readonly reportTypes: ReportTypesService,
    private readonly models: ModelsService,
    private readonly storage: StorageSummaryService,
    private readonly operations: OperationsService,
    private readonly goLive: GoLiveService,
    private readonly feedback: FeedbackService,
    private readonly security: SecurityService,
  ) {}

  async summary(user: AuthUser): Promise<{ settings: SettingSummary[]; computedAt: string }> {
    const settings = await Promise.all([
      settle('organisation', async () => {
        const o = await this.organisation.get();
        return organisationRule({
          name: o.name,
          logosUploaded: [o.logos.wide, o.logos.square].filter(Boolean).length,
          protectedKeyLoaded: o.protectedKey.loaded,
          casesWaitingForKey: o.protectedKey.casesWaiting,
        });
      }),
      settle('administrators', async () => {
        const list = await this.users.list();
        return administratorsRule({
          administrators: list.filter((u) => u.role === 'enterprise_administrator' && u.status === 'active').length,
          activePeople: list.filter((u) => u.status === 'active').length,
          disabledPeople: list.filter((u) => u.status !== 'active').length,
        });
      }),
      settle('departments', async () => {
        const all = (await this.org.listDepartments(true)) as { status: string }[];
        return departmentsRule({ active: all.filter((d) => d.status === 'active').length, retired: all.filter((d) => d.status !== 'active').length });
      }),
      settle('domains', async () => domainsRule({ domains: (await this.org.listDomains()).length })),
      settle('leadership', async () => {
        const { grants } = (await this.grants.list()) as { grants: { state: string; accountStatus: string }[] };
        const live = grants.filter((g) => g.state === 'active' || g.state === 'scheduled');
        return leadershipRule({
          active: live.filter((g) => g.state === 'active').length,
          scheduled: live.filter((g) => g.state === 'scheduled').length,
          waitingForAction: live.filter((g) => g.accountStatus !== 'active').length,
        });
      }),
      settle('approvals', async () => {
        const [p, pending] = await Promise.all([this.policy.organisation(), this.policy.pendingAffected({})]);
        return approvalsRule({ required: p.required, projectsMayOverride: p.projectsMayOverride, pending });
      }),
      settle('reminders', async () => {
        const n = await this.notifications.organisationView();
        return remindersRule({ leadDays: n.leadDays, escalationDays: n.escalationDays, dayCounting: n.dayCounting });
      }),
      settle('access', async () => accessRule((await this.access.get()).settings)),
      settle('resources', async () => {
        const s = (await this.resources.get()).settings;
        return resourcesRule({ defaultCurrency: s.defaultCurrency, enabledCurrencies: s.enabledCurrencies.length, projectsMayManageFinance: s.projectsMayManageFinance });
      }),
      settle('reportTypes', async () => {
        const all = await this.reportTypes.list(true);
        return reportTypesRule({ active: all.filter((r) => r.status === 'active').length, retired: all.filter((r) => r.status !== 'active').length });
      }),
      settle('stageTemplates', async () => stageTemplatesRule()),
      settle('ai', async () => aiRule({ models: (await this.models.list()).filter((m) => m.state === 'approved') })),
      settle('emailDelivery', () => this.emailDelivery()),
      settle('storage', async () => {
        const s = await this.storage.summary();
        return storageRule({
          approvedDestinations: s.destinations.filter((d) => d.status === 'approved').length,
          connection: s.connection,
          failedFiles: s.failed,
          sharingToRepair: s.sharingToRepair.length,
        });
      }),
      settle('operations', async () => {
        const v = await this.operations.view();
        const worst = v.storage.locations.reduce<OperationsInput['worstStorageLevel']>((w, l) => (SEVERITY[l.level] > SEVERITY[w] ? l.level : w), 'normal');
        return operationsRule({ backupStatus: v.backups.status, worstStorageLevel: worst, protectiveOn: v.protective.on, lastDrill: v.drills.last?.outcome ?? null });
      }),
      settle('goLive', async () => goLiveRule(await this.goLive.summary(user))),
      settle('escalatedFeedback', async () => escalatedFeedbackRule({ open: (await this.feedback.adminList(user)).feedback.length })),
      settle('securityReview', async () => {
        const { cases } = await this.security.adminCases(user);
        const held = cases.filter((c) => c.state === 'held' || c.state === 'cleaned');
        return securityReviewRule({ heldCases: held.length, waitingForKey: held.filter((c) => c.waitingForKey).length });
      }),
    ]);
    return { settings, computedAt: this.clock().toISOString() };
  }

  /** No service answers "failed in the last 24 hours", so this counts the outbox the Email delivery page lists. */
  private async emailDelivery(): Promise<SettingSummary> {
    const since = new Date(this.clock().getTime() - DAY_MS);
    const r = (
      await this.pool.query<{ failed: number; waiting: number }>(
        `SELECT count(*) FILTER (WHERE status = 'failed'
                   AND COALESCE((SELECT max(a.finished_at) FROM email_attempts a WHERE a.outbox_id = o.id), o.created_at) >= $1)::int AS failed,
                count(*) FILTER (WHERE status IN ('queued', 'sending', 'retry_wait'))::int AS waiting
           FROM email_outbox o`,
        [since],
      )
    ).rows[0];
    return emailDeliveryRule({ provider: this.config.email.provider, failedLast24h: r.failed, waiting: r.waiting });
  }
}
