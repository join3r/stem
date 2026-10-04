// Data children of the data-carrying components (DataTable, Chart, Stats,
// Compare). Pure JSON.parse — no eval — and every shape the model writes is
// normalized here so the components only ever see clean values.

export type Row = Record<string, unknown>;

/**
 * Parse a table data child into columns + rows. Accepts either an array of
 * objects (keys become columns, in first-seen order), or
 * { columns: [...], rows: [[...], ...] }.
 */
export function parseTable(raw: string | undefined): { columns: string[]; rows: Row[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const rows = parsed.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r));
      const columns: string[] = [];
      for (const r of rows) {
        for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
      }
      return { columns, rows };
    }
    if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
      const columns = parsed.columns.map(String);
      const rows = (parsed.rows as unknown[]).filter(Array.isArray).map((arr) => {
        const o: Row = {};
        columns.forEach((c: string, i: number) => (o[c] = (arr as unknown[])[i]));
        return o;
      });
      return { columns, rows };
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/** A cell as a number: numbers, and strings that are plainly numbers ("1,234", "12.5%"). Else null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const cleaned = v.trim().replace(/[,\s]/g, '').replace(/%$/, '');
  if (!cleaned || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface ChartSeries {
  name: string;
  values: Array<number | null>;
}

export interface ChartData {
  /** The category / x label of each row. */
  labels: string[];
  /** Numeric x of each row, when the first column is numeric (scatter). */
  xs: Array<number | null> | null;
  /** Name of the x column, for the tooltip and table. */
  xName: string;
  series: ChartSeries[];
}

/**
 * Table rows to chart series. The first column whose values are mostly text is
 * the x axis (category labels); every other column with numbers in it is a
 * series. With no text column the first column is the x axis either way, which
 * is what a scatter wants. The legacy `[{label, value}]` shape is just the
 * one-series case of this.
 */
export function toChartData(raw: string | undefined): ChartData | null {
  const table = parseTable(raw);
  if (!table || table.rows.length === 0 || table.columns.length === 0) return null;
  const { columns, rows } = table;
  const numericShare = (c: string) => rows.filter((r) => toNumber(r[c]) !== null).length / rows.length;
  const textColumn = columns.find((c) => numericShare(c) < 0.5);
  const xName = textColumn ?? columns[0];
  const seriesColumns = columns.filter((c) => c !== xName && numericShare(c) > 0);
  if (seriesColumns.length === 0) return null;
  const labels = rows.map((r) => {
    const v = r[xName];
    return v === null || v === undefined ? '' : String(v);
  });
  return {
    labels,
    xs: textColumn ? null : rows.map((r) => toNumber(r[xName])),
    xName,
    series: seriesColumns.map((name) => ({ name, values: rows.map((r) => toNumber(r[name])) }))
  };
}
