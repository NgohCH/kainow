import { BadRequestException } from '@nestjs/common';

export const CURRENCIES = { MYR: { decimals: 2 }, SGD: { decimals: 2 }, USD: { decimals: 2 } } as const;
export type Currency = keyof typeof CURRENCIES;

const AMOUNT_RE = /^\d{1,12}(\.\d{1,2})?$/;
const RATE_RE = /^\d{1,10}(\.\d{1,8})?$/;

/** Parses a decimal string (no commas, no sign, no exponent) into bigint minor units. */
export function parseAmount(s: unknown, opts: { allowZero: boolean }): bigint {
  if (typeof s !== 'string' || !AMOUNT_RE.test(s.trim())) {
    throw new BadRequestException('Enter an amount with at most 2 decimal places.');
  }
  const [whole, frac = ''] = s.trim().split('.');
  const minor = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0'));
  if (minor === 0n && !opts.allowZero) throw new BadRequestException('Enter an amount above 0.');
  return minor;
}

/** Validates a conversion rate (> 0, at most 8 decimals) and returns it normalised. */
export function parseRate(s: unknown): string {
  const bad = () => new BadRequestException('Enter a rate above 0 with at most 8 decimal places.');
  if (typeof s !== 'string' || !RATE_RE.test(s.trim())) throw bad();
  const [whole, frac = ''] = s.trim().split('.');
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = frac.replace(/0+$/, '');
  if (w === '0' && f === '') throw bad();
  return f === '' ? w : `${w}.${f}`;
}

export function toDecimalString(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export function formatAmount(minor: bigint, _c: Currency): string {
  const plain = toDecimalString(minor);
  const neg = plain.startsWith('-');
  const [whole, frac] = (neg ? plain.slice(1) : plain).split('.');
  return `${neg ? '-' : ''}${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${frac}`;
}
