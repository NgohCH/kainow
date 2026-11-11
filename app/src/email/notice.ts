/** The notice email for one person in one project: a subject that counts the items and one line per item. */
export function noticeEmail(projectName: string, lines: string[]): { subject: string; body: string } {
  const n = lines.length;
  return {
    subject: n === 1 ? `Kainow: 1 item needs your attention in ${projectName}` : `Kainow: ${n} items need your attention in ${projectName}`,
    body: lines.join('\n'),
  };
}
