/** The wording of emails that are queued in the outbox (pure: no clock, no database). */
export interface EmailText {
  subject: string;
  body: string;
}

export function invitationEmail(projectName: string, role: string, link: string, expiresAt: Date): EmailText {
  return {
    subject: `You are invited to ${projectName} in Kainow`,
    body:
      `You have been invited to the project "${projectName}" in Kainow as ${role}.\n\n` +
      `Open this link, sign in with the code Kainow emails you, then accept or decline:\n${link}\n\n` +
      `The invitation expires on ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
  };
}

export function holdAlertEmail(projectName: string, link: string): EmailText {
  return {
    subject: `Kainow: action needed in ${projectName}`,
    body:
      `A member of the project "${projectName}" is On Hold and needs investigating.\n\n` +
      `Open the project's People tab to record a finding and restore or remove the membership:\n${link}`,
  };
}

export function closureNoticeEmail(projectName: string, outcome: string, link: string): EmailText {
  return {
    subject: `${projectName} was closed by its Project Manager`,
    body:
      `The Project Manager closed the project "${projectName}" in Kainow, as you allowed, with the outcome ${outcome}.\n\n` +
      `Open the project to see what was kept outstanding or left unresolved:\n${link}`,
  };
}
