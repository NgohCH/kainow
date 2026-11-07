import { BadRequestException } from '@nestjs/common';

export const MICRO = 1_000_000n;

/** At most 12 whole digits and 6 decimals: large enough for any real amount, small enough for a bigint column. */
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;

/**
 * Turns a decimal such as "4.1" or 20 into whole micro-units. Exact: no floating point is used
 * for the value. Rejects negatives, exponents, extra decimals and anything that is not a number.
 */
export function parseMicro(value: unknown, field: string): bigint {
  let text: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new BadRequestException(`${field} must be a number`);
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new BadRequestException(`${field} is required`);
  }
  if (!DECIMAL.test(text)) {
    throw new BadRequestException(`${field} must be a plain decimal such as 4.1, with at most 6 decimal places and no sign`);
  }
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, '0'));
}

/** Whole micro-units as a fixed six-decimal string, for example 20000000n gives "20.000000". */
export function formatMicro(micro: bigint): string {
  const sign = micro < 0n ? '-' : '';
  const abs = micro < 0n ? -micro : micro;
  return `${sign}${abs / MICRO}.${(abs % MICRO).toString().padStart(6, '0')}`;
}

/** Division that rounds up. Both values must be non-negative and the divisor positive. */
export function ceilDiv(numerator: bigint, divisor: bigint): bigint {
  return (numerator + divisor - 1n) / divisor;
}
