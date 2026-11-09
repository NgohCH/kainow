import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogoShape = 'wide' | 'square';
export type Place = 'header' | 'tab' | 'signIn' | 'email' | 'report';
export type LogoSource = { shape: LogoShape; isDefault: boolean };
export type Box = { width: number; height: number };

export const LOGO_SHAPES: readonly LogoShape[] = ['wide', 'square'];
export const PLACES: readonly Place[] = ['header', 'tab', 'signIn', 'email', 'report'];

/** Kainow's own name, shown until the organisation's setup is finished. */
export const DEFAULT_NAME = 'Kainow';

/** For each place: the preferred shape and the box each shape is drawn in. */
const PLACEMENT: Record<Place, { prefer: LogoShape; boxes: Record<LogoShape, Box> }> = {
  header: { prefer: 'square', boxes: { square: { width: 32, height: 32 }, wide: { width: 96, height: 32 } } },
  tab: { prefer: 'square', boxes: { square: { width: 32, height: 32 }, wide: { width: 32, height: 32 } } },
  signIn: { prefer: 'wide', boxes: { wide: { width: 160, height: 56 }, square: { width: 72, height: 72 } } },
  email: { prefer: 'wide', boxes: { wide: { width: 120, height: 40 }, square: { width: 48, height: 48 } } },
  report: { prefer: 'wide', boxes: { wide: { width: 120, height: 40 }, square: { width: 48, height: 48 } } },
};

/**
 * Which logo a place shows: the organisation's preferred shape, else its other shape, else the Kainow default of the
 * preferred shape. The tab icon only ever shows a square.
 */
export function chooseLogo(place: Place, uploaded: Record<LogoShape, boolean>): LogoSource & { box: Box } {
  const { prefer, boxes } = PLACEMENT[place];
  const other: LogoShape = prefer === 'wide' ? 'square' : 'wide';
  if (uploaded[prefer]) return { shape: prefer, isDefault: false, box: boxes[prefer] };
  if (place !== 'tab' && uploaded[other]) return { shape: other, isDefault: false, box: boxes[other] };
  return { shape: prefer, isDefault: true, box: boxes[prefer] };
}

const ASSETS = join(__dirname, '..', '..', 'assets', 'branding');
const SIZES: Record<LogoShape, Box> = { wide: { width: 240, height: 80 }, square: { width: 128, height: 128 } };
const cache = new Map<LogoShape, Buffer>();

/** Kainow's default logo of a shape, shipped with the product (never stored in the database). */
export function defaultLogo(shape: LogoShape): { content: Buffer; mime: 'image/png'; width: number; height: number } {
  let content = cache.get(shape);
  if (!content) {
    content = readFileSync(join(ASSETS, `kainow-${shape}.png`));
    cache.set(shape, content);
  }
  return { content, mime: 'image/png', ...SIZES[shape] };
}
