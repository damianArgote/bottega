import type { LeadField } from '../agents/agent-profile.schema.js';

/** One lead as the export reads it. */
export interface LeadCsvRow {
  createdAt: Date;
  profileName: string | null;
  waId: string;
  /** Lead.data: captured values by lead field key. */
  data: Readonly<Record<string, unknown>>;
}

/**
 * Starts a spreadsheet reads as a formula (CSV/formula injection, OWASP):
 * such a cell gets a leading `'`, so Excel and Sheets show it as text.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One quoted cell: quotes doubled, formulas neutralized. */
export function csvCell(value: string): string {
  const safe = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** YYYY-MM-DD HH:mm in the business's zone. */
function localDateTime(timeZone: string, at: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The leads as CSV: one column per lead field (by its label, in the
 * profile's order), then date, profile name and phone. UTF-8 with a BOM
 * and CRLF line ends (RFC 4180), so Excel opens accents right.
 */
export function leadsCsv(
  fields: readonly LeadField[],
  rows: readonly LeadCsvRow[],
  timeZone: string,
): string {
  const header = [
    ...fields.map((f) => f.label),
    'Fecha',
    'Nombre de perfil',
    'Teléfono',
  ];
  const lines = [
    header,
    ...rows.map((row) => [
      ...fields.map((f) => asText(row.data[f.key])),
      localDateTime(timeZone, row.createdAt),
      row.profileName ?? '',
      row.waId,
    ]),
  ];
  return `\uFEFF${lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
