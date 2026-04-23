/**
 * Parse PostgreSQL `::text` timestamp output for use as a JS Date (UTC semantics for naive strings).
 * Avoids Invalid Date from short offsets (e.g. `+00`) that ECMAScript parsers reject.
 */
export function parsePostgresTimestampAsUtc(raw: string): Date {
  const t = raw.trim();
  if (!t) return new Date(NaN);

  let isoish = t.includes(" ") ? t.replace(" ", "T") : t;

  // V8 often rejects "+00" without minutes; normalize trailing ±HH when not already ±HH:MM.
  if (/[+-]\d{2}$/.test(isoish) && !/[+-]\d{2}:\d{2}$/.test(isoish)) {
    isoish = `${isoish}:00`;
  }

  const hasZone =
    /[zZ]$/.test(isoish) ||
    /[+-]\d{2}:\d{2}$/.test(isoish) ||
    /[+-]\d{4}$/.test(isoish);

  const candidate = hasZone ? isoish : `${isoish}Z`;
  return new Date(candidate);
}
