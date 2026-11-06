// Score formatting for very large numbers (DESIGN 18.5). Scores are doubles; nothing here truncates to an int32.

/** Unit suffixes from 10^3: K, M, B, T, Qa (10^15), Qi (10^18). */
const UNITS: readonly string[] = ['K', 'M', 'B', 'T', 'Qa', 'Qi'];
/** Below this, scores show every digit; from here on they get a unit. */
export const UNIT_FROM = 1e6;

function group(intStr: string): string {
  let out = '';
  for (let i = 0; i < intStr.length; i++) {
    if (i > 0 && (intStr.length - i) % 3 === 0) out += ',';
    out += intStr[i];
  }
  return out;
}

/**
 * Every digit with thousands separators ("1,234,567"). Above 2^53 a double has no exact integer value to show, so the
 * shortest decimal that round-trips is padded with zeros ("42,000,000,000,000,000,000,000"), never noise digits.
 */
export function formatFull(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const v = Math.floor(n);
  const s = String(v);
  const m = /^(\d)(?:\.(\d+))?e\+(\d+)$/.exec(s);
  if (!m) return group(s);
  const digits = m[1] + (m[2] ?? '');
  return group(digits + '0'.repeat(Math.max(0, Number(m[3]) + 1 - digits.length)));
}

/**
 * Compact score: all digits below 1,000,000, then three significant digits and a unit
 * (1.00M, 12.3M, 123M, 1.00B ... 999Qi, 1,234Qi). A value that rounds up to 1000 moves to the next unit.
 */
export function formatScore(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < UNIT_FROM) return group(String(Math.floor(n)));
  let u = 0; // index into UNITS; v is n in units of UNITS[u]
  let v = n / 1e3;
  while (u < UNITS.length - 1 && v >= 1000) {
    v /= 1000;
    u++;
  }
  // 999.9995M must print as 1.00B, not 1000M
  if (u < UNITS.length - 1 && v >= 999.5) {
    v /= 1000;
    u++;
  }
  let body: string;
  if (v >= 1000) body = group(String(Math.round(v)));
  else if (v >= 100) body = String(Math.round(v));
  else if (v >= 10) body = v.toFixed(1);
  else body = v.toFixed(2);
  // toFixed can round 99.95 up to "100.0" / 9.995 to "10.00": that is fine, it is still 3-4 characters
  return body + UNITS[u];
}

/** Colour class of a score pop-up by size (DESIGN 18.5). */
export type ScoreTone = 'white' | 'cyan' | 'yellow' | 'magenta' | 'rainbow';

export function scoreTone(points: number): ScoreTone {
  if (points < 1e3) return 'white';
  if (points < 1e4) return 'cyan';
  if (points < 1e5) return 'yellow';
  if (points < 1e6) return 'magenta';
  return 'rainbow';
}

/** Pop-up font scale: proportional to log10(points), clamped to 0.75..1.7 (1.0 at about 2,500 points). */
export function scoreSize(points: number): number {
  return Math.min(1.7, Math.max(0.75, Math.log10(Math.max(1, points)) / 3.4));
}
