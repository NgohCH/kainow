export interface CredentialFinding {
  /** Which kind of pattern matched. Never the matched text itself. */
  pattern: string;
  count: number;
}

const PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['API secret key (sk-)', /\bsk-[A-Za-z0-9_-]{20,}/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
  ['password or key assignment', /\b(?:password|passwd|pwd|passcode|secret|api[_ -]?key|access[_ -]?token)\s*[:=]\s*(?=\S*[\d!@#$%^&*])\S{8,}/gi],
  ['password inside a web address', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/gi],
];

/**
 * A basic check (O01) that notes do not carry credentials into an AI request. It looks for common,
 * well-formed secrets and cannot find every one, so it is a safety net and not a guarantee.
 * It reports only the kind and how many, so a finding never repeats the secret.
 */
export function findCredentials(text: string): CredentialFinding[] {
  const found: CredentialFinding[] = [];
  for (const [pattern, re] of PATTERNS) {
    const count = text.match(re)?.length ?? 0;
    if (count > 0) found.push({ pattern, count });
  }
  return found;
}
