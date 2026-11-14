/** Why an analysis ran, for display. The one map every screen takes its wording from. */
export type AnalysisTrigger = 'quiet_period' | 'meeting_end' | 'minutes_published' | 'button' | 'selection' | 'request';

export const AUTOMATIC_LABEL: Record<'quiet_period' | 'meeting_end' | 'minutes_published', string> = {
  quiet_period: 'Automatic: quiet period',
  meeting_end: 'Automatic: meeting ended',
  minutes_published: 'Automatic: minutes published',
};

/**
 * The label of a run: the requester's name when a person asked (button, selection, request), otherwise the automatic reason.
 * An automatic run with no known reason reads as the quiet period (the only automatic trigger without its own record).
 */
export function triggerLabel(trigger: string | null, requesterName: string | null): string | null {
  if (requesterName) return requesterName;
  if (trigger === null) return null;
  return (AUTOMATIC_LABEL as Record<string, string>)[trigger] ?? AUTOMATIC_LABEL.quiet_period;
}

/** SQL twin of `triggerLabel` for an expression `triggerExpr` and a (nullable) name expression. */
export function triggerLabelSql(triggerExpr: string, nameExpr: string): string {
  const whens = Object.entries(AUTOMATIC_LABEL).map(([k, v]) => `WHEN '${k}' THEN '${v}'`).join(' ');
  return `COALESCE(${nameExpr}, CASE ${triggerExpr} ${whens} ELSE '${AUTOMATIC_LABEL.quiet_period}' END)`;
}
