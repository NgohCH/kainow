/**
 * The leadership card field catalogue (dashboards spec 6.3, C60): the single source of the keys, their labels and which
 * fields can never be hidden. Leaders cannot add fields that are not here. Sub-project 8 adds resource and budget fields.
 */
export const LEADERSHIP_FIELDS: readonly { key: string; label: string; required?: true }[] = [
  { key: 'name', label: 'Project name', required: true },
  { key: 'owningDepartment', label: 'Owning department' },
  { key: 'contributingDepartments', label: 'Contributing departments' },
  { key: 'projectManager', label: 'Project Manager' },
  { key: 'status', label: 'Status' },
  { key: 'stage', label: 'Stage' },
  { key: 'taskCompletion', label: 'Task completion' },
  { key: 'onTime', label: 'On-time completion' },
  { key: 'plannedEnd', label: 'Planned end' },
  { key: 'overdue', label: 'Overdue tasks' },
  { key: 'blocked', label: 'Blocked tasks' },
  { key: 'significantRisks', label: 'Significant risks' },
  { key: 'resources', label: 'Resources' },
  { key: 'budget', label: 'Budget' },
  { key: 'nextDates', label: 'Next dates' },
  { key: 'attentionFlags', label: 'Attention flags', required: true },
  { key: 'refresh', label: 'Last refreshed', required: true },
];
