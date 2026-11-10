import type { Pool, PoolClient } from 'pg';
import { DEFAULT_NAME, chooseLogo, defaultLogo, type LogoShape, type Place } from '../organisation/branding';
import type { Letterhead } from '../organisation/organisation.service';

export type Db = Pick<Pool | PoolClient, 'query'>;

/**
 * The name and logo for an email, report or other formal output. The organisation's own once setup is
 * finished; Kainow's until then. One implementation, used by the organisation service and the outbox.
 */
export async function loadLetterhead(db: Db, place: Place = 'email'): Promise<Letterhead> {
  const org = (await db.query(`SELECT name, registered_at FROM organisation WHERE id = 1`)).rows[0];
  const registered = !!org?.registered_at;
  const uploaded: Partial<Record<LogoShape, { content: Buffer; mime: string }>> = {};
  if (registered) {
    for (const r of (await db.query(`SELECT shape, content, mime FROM organisation_logos`)).rows) uploaded[r.shape as LogoShape] = { content: r.content, mime: r.mime };
  }
  const choice = chooseLogo(place, { wide: !!uploaded.wide, square: !!uploaded.square });
  const image = choice.isDefault ? defaultLogo(choice.shape) : (uploaded[choice.shape] ?? defaultLogo(choice.shape));
  return { name: registered ? (org.name as string) : DEFAULT_NAME, registered, logo: { content: image.content, mime: image.mime, box: choice.box } };
}
