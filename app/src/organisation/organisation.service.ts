import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { writeAudit } from '../audit/audit';
import { CLOCK, type Clock } from '../auth/tokens';
import { PG_POOL } from '../db/database.module';
import { type Box, DEFAULT_NAME, LOGO_SHAPES, type LogoShape, PLACES, type Place, chooseLogo, defaultLogo } from './branding';
import { loadLetterhead } from '../email/letterhead';
import { checkLogo } from './image';
import { OrganisationState } from './state';

export type LogoMeta = { width: number; height: number; byteSize: number; uploadedAt: Date };
export type PlaceBranding = { url: string; width: number; height: number; isDefault: boolean };
export type Branding = { registered: boolean; name: string; places: Record<Place, PlaceBranding> };
/** What an email, report or other formal output carries: the name and the logo chosen for its place. */
export type Letterhead = { name: string; registered: boolean; logo: { content: Buffer; mime: string; box: Box } };
export type LogoImage = { content: Buffer; mime: string; version: string };

/** The organisation name as stored: NFC, whitespace collapsed, trimmed, 1 to 200 characters. */
export function cleanOrganisationName(v: unknown): string {
  const name = typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  if (name === '') throw new BadRequestException('Give the organisation a name.');
  if (name.length > 200) throw new BadRequestException('An organisation name can be at most 200 characters.');
  return name;
}

/** The logo shape named in a route, or 404. */
export function logoShape(v: string): LogoShape {
  if (!(LOGO_SHAPES as readonly string[]).includes(v)) throw new NotFoundException();
  return v as LogoShape;
}

const version = (uploadedAt: Date | string): string => String(new Date(uploadedAt).getTime());

export type RecoveryCustodian = { name: string | null; contact: string | null };
export const CUSTODIAN_BLANK = "Give the custodian's name and how to reach them.";
export const CUSTODIAN_LONG = 'The name and the contact can each be at most 200 characters.';

/** The custodian's name and contact as stored: both required, trimmed, each at most 200 characters. */
export function cleanCustodian(body: unknown): { name: string; contact: string } {
  const read = (k: string): string => {
    const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[k] : undefined;
    return typeof v === 'string' ? v.trim() : '';
  };
  const name = read('name');
  const contact = read('contact');
  if (name === '' || contact === '') throw new BadRequestException(CUSTODIAN_BLANK);
  if (name.length > 200 || contact.length > 200) throw new BadRequestException(CUSTODIAN_LONG);
  return { name, contact };
}

/** The organisation this installation serves: its name, its setup, its logos and the branding they make. */
@Injectable()
export class OrganisationProfileService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly now: Clock,
    private readonly state: OrganisationState,
  ) {}

  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
  }

  async get() {
    const org = (await this.pool.query(`SELECT name, registered_at FROM organisation WHERE id = 1`)).rows[0];
    const logos = (await this.pool.query(`SELECT shape, width, height, byte_size, uploaded_at FROM organisation_logos`)).rows;
    const meta = (shape: string): LogoMeta | null => {
      const l = logos.find((r) => r.shape === shape);
      return l ? { width: l.width, height: l.height, byteSize: l.byte_size, uploadedAt: l.uploaded_at } : null;
    };
    return { registered: !!org?.registered_at, name: (org?.name as string | undefined) ?? null, logos: { wide: meta('wide'), square: meta('square') } };
  }

  /** Saves the name during onboarding; after setup it is a rename, recorded with the old and new name. */
  async setName(nameIn: unknown, actorUserId: string): Promise<{ name: string }> {
    const name = cleanOrganisationName(nameIn);
    const at = this.now();
    await this.tx(async (c) => {
      const before = (await c.query(`SELECT name, registered_at FROM organisation WHERE id = 1 FOR UPDATE`)).rows[0];
      await c.query(
        `INSERT INTO organisation (id, name, updated_by, updated_at) VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [name, actorUserId, at],
      );
      if (before?.registered_at && before.name !== name) {
        await writeAudit(c, { at, action: 'organisation.renamed', actorUserId, subjectType: 'organisation', detail: { from: before.name, to: name } });
      }
    });
    return { name };
  }

  /** The recovery custodian (O07): who can restore Administrator access if every Administrator is locked out. */
  async recoveryCustodian(): Promise<RecoveryCustodian> {
    const row = (await this.pool.query(`SELECT recovery_custodian_name, recovery_custodian_contact FROM organisation WHERE id = 1`)).rows[0];
    return { name: row?.recovery_custodian_name ?? null, contact: row?.recovery_custodian_contact ?? null };
  }

  /** Records the recovery custodian; every change is in the audit trail with the old and new values. */
  async setRecoveryCustodian(body: unknown, actorUserId: string): Promise<RecoveryCustodian> {
    const next = cleanCustodian(body);
    const at = this.now();
    await this.tx(async (c) => {
      const row = (await c.query(`SELECT recovery_custodian_name, recovery_custodian_contact FROM organisation WHERE id = 1 FOR UPDATE`)).rows[0];
      if (!row) throw new ConflictException('Set up the organisation first.');
      const from = { name: row.recovery_custodian_name as string | null, contact: row.recovery_custodian_contact as string | null };
      if (from.name === next.name && from.contact === next.contact) return;
      await c.query(
        `UPDATE organisation SET recovery_custodian_name = $1, recovery_custodian_contact = $2, updated_by = $3, updated_at = $4 WHERE id = 1`,
        [next.name, next.contact, actorUserId, at],
      );
      await writeAudit(c, { at, action: 'organisation.recovery_custodian_changed', actorUserId, subjectType: 'organisation', detail: { from, to: next } });
    });
    return next;
  }

  /** Registers the organisation once it has a name, an email domain and an active department. Repeating it changes nothing. */
  async finish(actorUserId: string): Promise<{ registered: true }> {
    const at = this.now();
    await this.tx(async (c) => {
      const org = (await c.query(`SELECT registered_at FROM organisation WHERE id = 1 FOR UPDATE`)).rows[0];
      if (!org) throw new BadRequestException('Give the organisation a name.');
      if (org.registered_at) return;
      const domains = (await c.query(`SELECT count(*)::int AS n FROM eligible_domains WHERE removed_at IS NULL`)).rows[0].n;
      if (domains === 0) throw new BadRequestException('Add at least one email domain.');
      const departments = (await c.query(`SELECT count(*)::int AS n FROM departments WHERE status = 'active'`)).rows[0].n;
      if (departments === 0) throw new BadRequestException('Add at least one department.');
      await c.query(`UPDATE organisation SET registered_by = $1, registered_at = $2, updated_by = $1, updated_at = $2 WHERE id = 1`, [actorUserId, at]);
      await writeAudit(c, { at, action: 'organisation.registered', actorUserId, subjectType: 'organisation' });
    });
    this.state.markRegistered();
    return { registered: true };
  }

  async uploadLogo(shape: LogoShape, body: unknown, actorUserId: string): Promise<{ logo: LogoMeta }> {
    const buf = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const info = checkLogo(shape, buf);
    const at = this.now();
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO organisation_logos (shape, content, mime, width, height, byte_size, uploaded_by, uploaded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (shape) DO UPDATE SET content = EXCLUDED.content, mime = EXCLUDED.mime, width = EXCLUDED.width, height = EXCLUDED.height,
           byte_size = EXCLUDED.byte_size, uploaded_by = EXCLUDED.uploaded_by, uploaded_at = EXCLUDED.uploaded_at`,
        [shape, buf, info.mime, info.width, info.height, buf.length, actorUserId, at],
      );
      // The audit names the logo, never its bytes.
      const detail = { shape, byteSize: buf.length, width: info.width, height: info.height };
      await writeAudit(c, { at, action: 'organisation.logo_set', actorUserId, subjectType: 'organisation', detail });
    });
    return { logo: { width: info.width, height: info.height, byteSize: buf.length, uploadedAt: at } };
  }

  async removeLogo(shape: LogoShape, actorUserId: string): Promise<{ removed: true }> {
    const at = this.now();
    await this.tx(async (c) => {
      const { rowCount } = await c.query(`DELETE FROM organisation_logos WHERE shape = $1`, [shape]);
      if (!rowCount) throw new NotFoundException();
      await writeAudit(c, { at, action: 'organisation.logo_removed', actorUserId, subjectType: 'organisation', detail: { shape } });
    });
    return { removed: true };
  }

  /** The uploaded logo itself, shown to Administrators while onboarding, before it is in use. */
  async preview(shape: LogoShape): Promise<LogoImage> {
    const row = (await this.pool.query(`SELECT content, mime, uploaded_at FROM organisation_logos WHERE shape = $1`, [shape])).rows[0];
    if (!row) throw new NotFoundException();
    return { content: row.content, mime: row.mime, version: version(row.uploaded_at) };
  }

  /** The name and logos in use: the organisation's own only once setup is finished; Kainow's until then. */
  private async inUse(): Promise<{ registered: boolean; name: string; uploaded: Record<LogoShape, string | null> }> {
    const org = (await this.pool.query(`SELECT name, registered_at FROM organisation WHERE id = 1`)).rows[0];
    const registered = !!org?.registered_at;
    const uploaded: Record<LogoShape, string | null> = { wide: null, square: null };
    if (registered) {
      for (const r of (await this.pool.query(`SELECT shape, uploaded_at FROM organisation_logos`)).rows) uploaded[r.shape as LogoShape] = version(r.uploaded_at);
    }
    return { registered, name: registered ? (org.name as string) : DEFAULT_NAME, uploaded };
  }

  /** The name and, for each place, the logo to show. Public: the sign-in page needs it before anyone signs in. */
  async branding(): Promise<Branding> {
    const { registered, name, uploaded } = await this.inUse();
    const places = {} as Record<Place, PlaceBranding>;
    for (const place of PLACES) {
      const choice = chooseLogo(place, { wide: uploaded.wide !== null, square: uploaded.square !== null });
      const v = choice.isDefault ? 'default' : (uploaded[choice.shape] as string);
      places[place] = { url: `/organisation/logo/${choice.shape}?v=${v}`, ...choice.box, isDefault: choice.isDefault };
    }
    return { registered, name, places };
  }

  /** The image in use for a shape. Bytes, type and version come from one read, so they always match. */
  async logoInUse(shape: LogoShape): Promise<LogoImage> {
    if (await this.state.isRegistered()) {
      const row = (await this.pool.query(`SELECT content, mime, uploaded_at FROM organisation_logos WHERE shape = $1`, [shape])).rows[0];
      if (row) return { content: row.content, mime: row.mime, version: version(row.uploaded_at) };
    }
    const d = defaultLogo(shape);
    return { content: d.content, mime: d.mime, version: 'default' };
  }

  /** The name and logo for an email, report or other formal output. */
  async letterhead(place: Place): Promise<Letterhead> {
    return loadLetterhead(this.pool, place);
  }
}
