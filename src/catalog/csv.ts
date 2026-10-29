/**
 * Minimal RFC 4180 CSV parser: quoted fields (with "" for a quote and line
 * breaks inside), CRLF or LF, a UTF-8 BOM. The delimiter is `,` or `;`
 * (Excel in Spanish exports with `;`), whichever appears more in the header
 * line outside quotes. Blank lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRows(text).map((r) => r.values);
}

/**
 * Like {@link parseCsv}, with the spreadsheet row of each record (1-based):
 * skipped blank rows still count, and a quoted cell with line breaks is one
 * row, so "Fila N" points at the row the person sees.
 */
export function parseCsvRows(
  text: string,
): Array<{ row: number; values: string[] }> {
  const input = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const delimiter = detectDelimiter(input);
  const rows: Array<{ row: number; values: string[] }> = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let rowNumber = 1;

  const endRow = () => {
    row.push(field);
    if (row.some((value) => value.trim() !== '')) {
      rows.push({ row: rowNumber, values: row });
    }
    rowNumber += 1;
    row = [];
    field = '';
  };

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') {
        i += 1;
      }
      endRow();
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return rows;
}

function detectDelimiter(input: string): ',' | ';' {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === '\n' || char === '\r')) {
      break;
    } else if (!quoted && char === ',') {
      commas += 1;
    } else if (!quoted && char === ';') {
      semicolons += 1;
    }
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * CSV rows as records keyed by the header line (trimmed headers), with the
 * spreadsheet row number of each record.
 */
export function csvRecords(text: string): {
  headers: string[];
  records: Record<string, string>[];
  rows: number[];
} {
  const [header, ...rest] = parseCsvRows(text);
  const headers = (header?.values ?? []).map((h) => h.trim());
  const records = rest.map(({ values }) =>
    Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])),
  );
  return { headers, records, rows: rest.map((r) => r.row) };
}
