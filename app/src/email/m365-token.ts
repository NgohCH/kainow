import type { Clock } from '../auth/tokens';

/** A refused or failed token request. Carries the HTTP status (0 when Microsoft could not be reached), never the secret. */
export class TokenError extends Error {
  constructor(readonly status: number) {
    super(status === 0 ? 'The Microsoft 365 token request could not be completed' : `The Microsoft 365 token request failed (HTTP ${status})`);
    this.name = 'TokenError';
  }
}

export interface M365Credentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const REFRESH_BEFORE_MS = 5 * 60_000;

/** Application (client credentials) token for sending as the one sender mailbox. Cached until five minutes before it expires. */
export class M365TokenSource {
  private cached: { token: string; refreshAt: number } | undefined;
  private pending: Promise<string> | undefined;

  constructor(
    private readonly cfg: M365Credentials,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async token(): Promise<string> {
    const now = this.clock().getTime();
    if (this.cached && now < this.cached.refreshAt) return this.cached.token;
    this.pending ??= this.request(now).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async request(now: number): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
          scope: 'https://outlook.office365.com/.default',
        }).toString(),
      });
    } catch {
      throw new TokenError(0);
    }
    if (!res.ok) throw new TokenError(res.status);
    const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    if (!body || typeof body.access_token !== 'string' || typeof body.expires_in !== 'number') throw new TokenError(502);
    this.cached = { token: body.access_token, refreshAt: now + body.expires_in * 1000 - REFRESH_BEFORE_MS };
    return body.access_token;
  }
}
