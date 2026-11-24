// Verbatim copy of app/src/organisation/colour.ts (the web cannot import server code). Keep the two files identical.
// Pure: no imports. The web app keeps a verbatim copy of this file, so keep it free of anything server-specific.

export type SchemeTokens = {
  menu: string;
  menuInk: string;
  menuActive: string;
  accent: string;
  accentContrast: string;
  accentDeep: string;
  accentWash: string;
};

export const COLOUR_TOO_LIGHT = 'This colour is too light for white text on buttons. Choose a darker shade.';

const WHITE = '#ffffff';

function parse(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = parse(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = parse(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

function fromHsl(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = Math.min(100, Math.max(0, l)) / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/** How far the current menu item must stand out from the menu (beside its white edge and bold text). */
const MENU_STEP = 1.5;

/** The organisation colour as the current menu item, lightened for a colour as dark as the menu itself. */
function activeOn(menu: string, accent: string): string {
  let active = accent;
  const [h, s, l] = toHsl(accent);
  for (let step = 1; contrastRatio(active, menu) < MENU_STEP; step += 1) active = fromHsl(h, s, l + step);
  return active;
}

/** The colour scheme made from an organisation colour, or the reason it cannot carry white text and visible links. */
export function deriveScheme(hex: string): { ok: true; scheme: SchemeTokens } | { ok: false; reason: string } {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return { ok: false, reason: 'Use a colour written as # and six letters or digits, such as #b0182e.' };
  const accent = hex.toLowerCase();
  const [h, s, l] = toHsl(accent);
  const menu = fromHsl(h, s, Math.min(l, 18));
  if (contrastRatio(WHITE, accent) < 4.5 || contrastRatio(WHITE, menu) < 4.5 || contrastRatio(accent, WHITE) < 3) {
    return { ok: false, reason: COLOUR_TOO_LIGHT };
  }
  return {
    ok: true,
    scheme: {
      menu,
      menuInk: WHITE,
      menuActive: activeOn(menu, accent),
      accent,
      accentContrast: WHITE,
      accentDeep: fromHsl(h, s, l - 12),
      accentWash: fromHsl(h, s, 93),
    },
  };
}
