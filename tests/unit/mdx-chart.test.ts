// The hand-rolled chart's pure parts: data shapes, ticks, number formatting,
// bar geometry and the donut's "Other" fold. Rendering is checked by SSR in
// renderer-regressions and by eye in the app.
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { toChartData, toNumber } from '../../src/renderer/mdx/data';
import { barPath, donutSlices, formatCompact, formatValue, niceTicks } from '../../src/renderer/mdx/chart/scale';
import { Chart } from '../../src/renderer/mdx/chart/Chart';

describe('toChartData', () => {
  it('reads the legacy {label, value} shape as one series', () => {
    const d = toChartData(JSON.stringify([{ label: 'Q1', value: 12 }, { label: 'Q2', value: 19 }]))!;
    expect(d.labels).toEqual(['Q1', 'Q2']);
    expect(d.series).toEqual([{ name: 'value', values: [12, 19] }]);
    expect(d.xs).toBeNull();
  });

  it('reads DataTable-shaped rows: first text column is x, numeric columns are series', () => {
    const d = toChartData(
      JSON.stringify([
        { quarter: 'Q1', rent: 3000, food: '1,200', note: 'x' },
        { quarter: 'Q2', rent: 3000, food: 1100, note: 'y' }
      ])
    )!;
    expect(d.xName).toBe('quarter');
    expect(d.series.map((s) => s.name)).toEqual(['rent', 'food']);
    expect(d.series[1].values).toEqual([1200, 1100]);
  });

  it('accepts the {columns, rows} form and numeric x for scatter', () => {
    const d = toChartData(JSON.stringify({ columns: ['price', 'rating'], rows: [[10, 4.1], [25, 4.6]] }))!;
    expect(d.xs).toEqual([10, 25]);
    expect(d.series).toEqual([{ name: 'rating', values: [4.1, 4.6] }]);
  });

  it('rejects data with nothing to plot', () => {
    expect(toChartData('not json')).toBeNull();
    expect(toChartData('[]')).toBeNull();
    expect(toChartData(JSON.stringify([{ a: 'x' }, { a: 'y' }]))).toBeNull();
  });

  it('parses numbers people write', () => {
    expect(toNumber('1,234.5')).toBe(1234.5);
    expect(toNumber('12%')).toBe(12);
    expect(toNumber('n/a')).toBeNull();
    expect(toNumber(Infinity)).toBeNull();
  });
});

describe('scale', () => {
  it('picks round ticks that cover the data', () => {
    expect(niceTicks(0, 92, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(-10, 10, 4)).toEqual([-10, -5, 0, 5, 10]);
    expect(niceTicks(0.1, 0.3, 4)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3]);
    const flat = niceTicks(5, 5);
    expect(flat[0]).toBeLessThanOrEqual(5);
    expect(flat[flat.length - 1]).toBeGreaterThanOrEqual(5);
  });

  it('formats compact ticks and full tooltip values with units', () => {
    expect(formatCompact(12500)).toBe('12.5k');
    expect(formatCompact(3_200_000, '$')).toBe('$3.2M');
    expect(formatCompact(-1500, '€')).toBe('-€1,500');
    expect(formatCompact(45, '%')).toBe('45%');
    // Whole numbers keep their zeros: 100k, not 1k.
    expect(formatCompact(100_000, '€')).toBe('€100k');
    expect(formatCompact(150_000, '€')).toBe('€150k');
    expect(formatCompact(20_000_000)).toBe('20M');
    expect(formatCompact(1_500_000)).toBe('1.5M');
    expect(formatValue(12345.678, 'km')).toBe('12,345.68 km');
  });

  it('rounds the data end of a bar and keeps the baseline square, both directions', () => {
    const up = barPath(10, 20, 200, 100);
    expect(up.startsWith('M10,200')).toBe(true);
    expect(up).toContain('A4,4');
    const down = barPath(10, 20, 100, 160);
    expect(down).toContain('A4,4');
    // A sliver shorter than the radius still draws without inverting.
    expect(barPath(0, 20, 100, 99)).toContain('A1,1');
  });

  it('folds donut slices past six into Other and drops non-positive values', () => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const slices = donutSlices(labels, [50, 1, 40, 30, 2, 20, 10, 0]);
    expect(slices).toHaveLength(6);
    expect(slices.at(-1)).toEqual({ label: 'Other', value: 3, slot: -1 });
    expect(slices.map((s) => s.label)).toEqual(['a', 'c', 'd', 'f', 'g', 'Other']);
    expect(slices.slice(0, 5).map((s) => s.slot)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('Chart rendering', () => {
  const render = (props: Record<string, string>) => renderToStaticMarkup(createElement(Chart, props));
  const rows = JSON.stringify([
    { m: 'Jan', a: 1, b: 2 },
    { m: 'Feb', a: 3, b: 1 }
  ]);

  it('draws a legend for two or more series and none for one', () => {
    expect(render({ type: 'line', data: rows })).toContain('chart-legend');
    expect(render({ type: 'line', data: JSON.stringify([{ label: 'x', value: 1 }]) })).not.toContain('chart-legend');
  });

  it('turns long category labels into horizontal bars', () => {
    const html = render({
      type: 'bar',
      data: JSON.stringify([
        { country: 'Democratic Republic of the Congo', area: 2344858 },
        { country: 'Kazakhstan', area: 2724900 }
      ])
    });
    expect(html).toContain('chart-axis-cat');
  });

  it('renders every kind without throwing', () => {
    for (const type of ['line', 'area', 'bar', 'stacked', 'donut', 'scatter', 'pie', 'nonsense']) {
      expect(render({ type, data: rows }), type).toContain('<svg');
    }
  });

  it('says so when the data cannot be read', () => {
    expect(render({ type: 'bar', data: '[{"label":' })).toContain('Could not read chart data.');
  });
});
