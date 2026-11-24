import { useCallback, useEffect, useState } from 'react';
import { ApiError, type Project, api } from '../api.ts';
import { type ProjectAnalysisView, explanationSentence, getProjectAnalysis, inheritanceLines, projectReadOnlyMessage } from '../analysisSettings.ts';
import type { FinanceSettingsView } from '../finance.ts';
import { plural } from '../format.ts';
import { EXPORT_ROLE_LABEL, effectiveSourceLabel, formatLabel } from '../outputs.ts';
import { authorityText, thresholdsText } from '../resourceScreens.ts';
import { leadDaysText } from '../settings.ts';
import { DataTable, type Column } from '../ui/DataTable.tsx';
import { SettingsPage, type SettingsPageItem } from '../ui/SettingsPage.tsx';
import { StatusLabel } from '../ui/StatusLabel.tsx';
import { ProjectAnalysisSettings } from './AnalysisSettings.tsx';
import { Holidays } from './Holidays.tsx';
import { type Group, NOT_ALLOWED, NOT_EDITOR, NotificationSettingsForm, type ProjectView, SOURCE_TEXT, dayList, digestText } from './NotificationSettings.tsx';
import { useRefreshCalendar } from './ProjectCalendar.tsx';
import { ProjectFinanceSettings } from './ProjectFinanceSettings.tsx';
import { StagesEditor, StagesSummary, stagesEditable } from './ProjectStages.tsx';
import { ProjectOutputSettings, useOutputPolicy, who as outputWho } from './ProjectOutputSettings.tsx';

const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'That did not work. Try again.');
const YOURS = 'You may change this.';

/** One line of the "At a glance" table: a value in force, where it comes from and who may change it. */
interface GlanceRow { key: string; setting: string; value: string; warning?: string; source: string; who: string }

const COLUMNS: Column<GlanceRow>[] = [
  { key: 'setting', header: 'Setting', cell: (r) => r.setting },
  {
    key: 'value',
    header: 'In force',
    cell: (r) => (
      <span className="label-stack">
        <span>{r.value}</span>
        {r.warning && <StatusLabel meaning="attention" word={r.warning} />}
      </span>
    ),
  },
  { key: 'source', header: 'Comes from', cell: (r) => r.source },
  { key: 'who', header: 'Who may change it', cell: (r) => r.who },
];

interface HolidaysResponse { holidays: Array<{ removedAt: string | null }>; organisationHolidays: unknown[] }

/**
 * Project → Settings (spec 7.6, 7.9): at a glance, every value in force with where it comes from (the organisation or
 * this project) and who may change it; then each setting in its own box, whose form opens in place. Everyone who can
 * read the project sees the values; someone who may not change a setting opens its details and history instead.
 */
export function ProjectSettings({ project, reload, showFinance = false }: { project: Project; reload: () => void; showFinance?: boolean }) {
  const projectId = project.id;
  const [notices, setNotices] = useState<ProjectView | null>(null);
  const [holidays, setHolidays] = useState<{ own: number; organisation: number } | null>(null);
  const [analysis, setAnalysis] = useState<ProjectAnalysisView | null>(null);
  const [finance, setFinance] = useState<FinanceSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { policy: outputs, reload: reloadOutputs } = useOutputPolicy(projectId);
  const refreshCalendar = useRefreshCalendar();

  const load = useCallback(() => {
    api.get<ProjectView>(`/projects/${projectId}/notification-settings`).then(setNotices, (e) => setError(errText(e)));
    api.get<HolidaysResponse>(`/projects/${projectId}/holidays`).then(
      (h) => setHolidays({ own: h.holidays.filter((x) => !x.removedAt).length, organisation: h.organisationHolidays.length }),
      () => setHolidays(null),
    );
    getProjectAnalysis(projectId).then(setAnalysis, () => setAnalysis(null));
    // Finance settings are shown to the managing roles only; anyone else is answered 403 or 404 and sees no finance row.
    if (showFinance) api.get<FinanceSettingsView>(`/projects/${projectId}/settings/finance`).then(setFinance, () => setFinance(null));
  }, [projectId, showFinance]);
  useEffect(load, [load]);
  const reloadAll = useCallback(() => {
    load();
    reloadOutputs();
  }, [load, reloadOutputs]);

  const whoFor = (g: Group) => (!notices ? '' : notices.canEdit[g] ? YOURS : notices.delegation[g] ? NOT_EDITOR : NOT_ALLOWED);
  const rows: GlanceRow[] = [];
  if (notices) {
    const s = notices.sources;
    rows.push(
      { key: 'dayCounting', setting: 'Day counting', value: notices.dayCounting === 'working' ? 'Working Days' : 'Calendar Days', source: SOURCE_TEXT[s.dayCounting], who: whoFor('calendar') },
      { key: 'weekdays', setting: 'Working weekdays', value: dayList(notices.weekdays), source: SOURCE_TEXT[s.weekdays], who: whoFor('calendar') },
    );
    if (holidays) {
      rows.push({
        key: 'holidays',
        setting: 'Holidays',
        value: `${holidays.organisation} from the organisation, ${holidays.own} set for this project`,
        source: 'The organisation and this project',
        who: whoFor('calendar'),
      });
    }
    rows.push(
      { key: 'leadDays', setting: 'Reminder days before the due date', value: leadDaysText(notices.leadDays), source: SOURCE_TEXT[s.leadDays], who: whoFor('timings') },
      { key: 'escalation', setting: 'Escalation delay after the due date', value: plural(notices.escalationDays, 'day'), source: SOURCE_TEXT[s.escalationDays], who: whoFor('timings') },
      { key: 'digest', setting: 'Action-item email schedule', value: digestText(notices.digest), source: 'Set for this project', who: whoFor('digest') },
    );
  }
  if (analysis) {
    const from = inheritanceLines(analysis);
    const whoA = projectReadOnlyMessage(analysis) ?? YOURS;
    rows.push(
      { key: 'automatic', setting: 'Automatic analysis', value: analysis.automatic ? 'On' : 'Off', source: from.automatic, who: whoA },
      { key: 'quiet', setting: 'Quiet period before analysis', value: `${analysis.quietMinutes} minutes`, source: from.quietMinutes, who: whoA },
    );
  }
  if (outputs) {
    const d = outputs.destination;
    rows.push(
      {
        key: 'destination',
        setting: 'Output destination',
        value: d ? d.label : 'None chosen: outputs cannot be filed yet',
        warning: d?.needsNewLocation ? 'No longer approved: choose another destination' : d?.libraryWarning ?? undefined,
        source: effectiveSourceLabel(outputs.sources.destination),
        who: outputWho(outputs.editable.destination),
      },
      { key: 'formatsIn', setting: 'Formats it accepts (notes and documents)', value: outputs.formats.input.map((f) => formatLabel(f.format)).join(', ') || 'None', source: effectiveSourceLabel(outputs.sources.formats.input), who: outputWho(outputs.editable.formats) },
      { key: 'formatsOut', setting: 'Formats it makes (outputs)', value: outputs.formats.output.map((f) => formatLabel(f.format)).join(', ') || 'None', source: effectiveSourceLabel(outputs.sources.formats.output), who: outputWho(outputs.editable.formats) },
      {
        key: 'exportRoles',
        setting: 'Who may export',
        value: outputs.exportRoles.map((r) => EXPORT_ROLE_LABEL[r] ?? r).join(', ') || 'Nobody',
        source: `${effectiveSourceLabel(outputs.sources.exportRoles)}. Exports also need the Administrator to allow project exports`,
        who: outputWho(outputs.editable.exportRoles),
      },
    );
  }
  if (finance) {
    const f = finance.settings;
    const whoF = authorityText(finance);
    rows.push(
      { key: 'tracking', setting: 'Financial tracking', value: f.tracking === 'enabled' ? 'Enabled' : 'Not required', source: 'Set for this project', who: whoF },
      { key: 'currency', setting: 'Reporting currency', value: f.currency ?? 'Not chosen', source: f.currency ? 'Set for this project' : `Organisation default: ${finance.organisation.defaultCurrency}`, who: finance.currencyFixed ? 'Fixed once figures exist.' : whoF },
      { key: 'thresholds', setting: 'Budget warnings', value: `${finance.effective.thresholds[0]}% and ${finance.effective.thresholds[1]}%`, source: finance.effective.inherited ? 'From the organisation' : 'Set for this project', who: whoF },
      {
        key: 'readers',
        setting: 'Who can read financial detail',
        value: ['Project Manager, Deputies, Owner and Sponsors', ...(f.membersRead ? ['Members'] : []), ...(f.grantsRead ? ['Audit and oversight holders'] : [])].join('; '),
        source: 'Set for this project',
        who: whoF,
      },
    );
  }

  const loading = !notices && !error;
  const glance = (
    <>
      {error && <p role="alert" className="error">{error}</p>}
      <DataTable caption="Settings in force for this project" columns={COLUMNS} rows={rows} rowKey={(r) => r.key} loading={loading} empty="No settings could be read." />
    </>
  );

  const anyNotice = notices ? notices.canEdit.calendar || notices.canEdit.timings || notices.canEdit.digest : false;
  const items: SettingsPageItem[] = [
    {
      key: 'reminders',
      title: 'Calendar, reminders and the action-item email',
      opener: anyNotice ? undefined : 'Details',
      current: notices ? (
        <p>
          {notices.dayCounting === 'working' ? 'Working Days' : 'Calendar Days'}; reminders {leadDaysText(notices.leadDays)} days before the due date; escalation after {plural(notices.escalationDays, 'day')}; action-item email: {digestText(notices.digest)}.
        </p>
      ) : <p className="loading">Loading</p>,
      form: () => <NotificationSettingsForm projectId={projectId} onSaved={reloadAll} />,
    },
    {
      key: 'holidays',
      title: 'Holidays',
      opener: notices?.canEdit.calendar ? undefined : 'Details',
      current: <p>{holidays ? `${plural(holidays.own, 'holiday')} set for this project, ${holidays.organisation} from the organisation.` : 'Loading'}</p>,
      form: () => (
        <Holidays
          projectId={projectId}
          bare
          canEdit={Boolean(notices?.canEdit.calendar)}
          notice={notices && !notices.delegation.calendar ? NOT_ALLOWED : null}
          onChanged={() => {
            refreshCalendar();
            load();
          }}
        />
      ),
    },
    {
      key: 'stages',
      title: 'Stages',
      opener: stagesEditable(project) ? undefined : 'Details',
      current: <StagesSummary project={project} />,
      form: () => <StagesEditor project={project} reload={reload} />,
    },
    {
      key: 'analysis',
      title: 'Automatic analysis',
      opener: analysis && analysis.canEdit ? undefined : 'Details',
      current: <p>{analysis ? explanationSentence(analysis) : 'Loading'}</p>,
      form: () => <ProjectAnalysisSettings projectId={projectId} bare onSaved={load} />,
    },
    {
      key: 'outputs',
      title: 'Outputs',
      opener: outputs && (outputs.editable.destination || outputs.editable.formats || outputs.editable.exportRoles) ? undefined : 'Details',
      current: <p>{outputs ? `Destination: ${outputs.destination?.label ?? 'none chosen'}. Who may export: ${outputs.exportRoles.map((r) => EXPORT_ROLE_LABEL[r] ?? r).join(', ') || 'nobody'}.` : 'Loading'}</p>,
      form: (close) => <ProjectOutputSettings projectId={projectId} bare onSaved={reloadAll} onClose={close} />,
    },
  ];
  if (showFinance && finance) {
    items.push({
      key: 'finance',
      title: 'Finance',
      opener: finance.editable ? undefined : 'Details',
      current: (
        <p>
          Financial tracking: {finance.settings.tracking === 'enabled' ? `Enabled, in ${finance.settings.currency ?? 'no currency yet'}` : 'Not required'}. {thresholdsText(finance.effective)}
        </p>
      ),
      form: () => <ProjectFinanceSettings projectId={projectId} bare onSaved={load} />,
    });
  }

  return <SettingsPage glance={glance} settings={items} />;
}
