// Render-level probe: bundle the REAL renderMdx (src/renderer/mdx/render.tsx)
// and server-render sample documents to confirm each component produces the
// expected DOM. Components are SSR-safe (hooks set initial state; clipboard/
// timeout only run in event handlers). No browser needed.
import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { rm } from 'node:fs/promises';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const DOCS = {
  Tabs: `<Tabs>\n<Tab label="One">first panel</Tab>\n<Tab label="Two">second panel</Tab>\n</Tabs>`,
  Chart: `<Chart type="bar" title="Rev">\n\`\`\`json\n[{"label":"Q1","value":12},{"label":"Q2","value":19}]\n\`\`\`\n</Chart>`,
  ChartLine: `<Chart type="line">\n\`\`\`json\n[{"label":"a","value":1},{"label":"b","value":5},{"label":"c","value":3}]\n\`\`\`\n</Chart>`,
  DataTable: `<DataTable caption="People">\n\`\`\`json\n[{"name":"Ann","age":30},{"name":"Bo","age":25}]\n\`\`\`\n</DataTable>`,
  DataTableBad: `<DataTable>\n\`\`\`json\n{ not json\n\`\`\`\n</DataTable>`,
  Quiz: `<Quiz topic="Geo">\n<Question prompt="Capital of France?" answer="Paris">\n<Choice>London</Choice>\n<Choice>Paris</Choice>\n</Question>\n</Quiz>`,
  Form: `<Form prompt="Trip" submitLabel="Plan">\n<Field name="dest" label="Destination" />\n<Field name="days" label="Days" type="number" />\n</Form>`,
  Unknown: `<Marquee>scrolling</Marquee>`,
  Security: `Hi {alert(1)}\n\n<script>evil()</script>`
};

const entry = `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderMdx } from ${JSON.stringify(join(root, 'src/renderer/mdx/render.tsx'))};
import { MdxActionContext } from ${JSON.stringify(join(root, 'src/renderer/mdx/ActionContext.tsx'))};
const DOCS = ${JSON.stringify(DOCS)};
const actions = { submit() {}, running: false };
const out = {};
for (const [k, v] of Object.entries(DOCS)) {
  out[k] = renderToStaticMarkup(
    React.createElement(MdxActionContext.Provider, { value: actions }, renderMdx(v))
  );
}
globalThis.__OUT__ = out;
`;

const tmp = join(root, 'scripts', '_render-bundle.mjs');
await esbuild.build({
  stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  packages: 'external', // import react/unified/remark natively; only bundle our source
  jsx: 'automatic',
  outfile: tmp,
  logLevel: 'error'
});
await import('file://' + tmp + '?t=' + Date.now());
await rm(tmp, { force: true });
const out = globalThis.__OUT__;

let ok = true;
const check = (label, cond) => {
  console.log(`  ${cond ? 'ok ' : 'XX '} ${label}`);
  ok = ok && cond;
};

console.log('Render checks:');

// Tabs: tab bar with both labels, only the active panel shown.
check('Tabs renders a tablist', out.Tabs.includes('class="tab-bar"'));
check('Tabs shows both tab labels', out.Tabs.includes('>One<') && out.Tabs.includes('>Two<'));
check('Tabs shows active panel only', out.Tabs.includes('first panel') && !out.Tabs.includes('second panel'));

// Chart: SVG with bars (bar type) / polyline (line type) + title.
check('Chart(bar) renders svg + title', out.Chart.includes('<svg') && out.Chart.includes('Rev'));
check('Chart(bar) draws rect bars', (out.Chart.match(/class="chart-bar"/g) || []).length === 2);
check('Chart(line) draws a polyline + dots', out.ChartLine.includes('class="chart-line"') && (out.ChartLine.match(/class="chart-dot"/g) || []).length === 3);

// DataTable: headers from object keys, sortable buttons, rows, filter input.
check('DataTable renders column headers', out.DataTable.includes('>name') && out.DataTable.includes('>age'));
check('DataTable has sort buttons + filter', out.DataTable.includes('data-table-sort') && out.DataTable.includes('data-table-filter'));
check('DataTable renders data cells', out.DataTable.includes('>Ann<') && out.DataTable.includes('>30<'));
check('DataTable(bad json) shows fallback, not a crash', out.DataTableBad.includes('Could not read table data'));

// Quiz: topic, prompt, choice buttons, a Check button (interactive).
check('Quiz renders topic + prompt', out.Quiz.includes('>Geo<') && out.Quiz.includes('Capital of France?'));
check('Quiz renders choice buttons', out.Quiz.includes('quiz-choice') && out.Quiz.includes('>Paris<'));
check('Quiz renders a Check button', out.Quiz.includes('Check answers'));

// Form: prompt, labeled fields, number input, submit button.
check('Form renders prompt + submit label', out.Form.includes('>Trip<') && out.Form.includes('>Plan<'));
check('Form renders labeled fields', out.Form.includes('>Destination<') && out.Form.includes('>Days<'));
check('Form renders a number input', out.Form.includes('type="number"'));

// Security invariants must still hold at render time.
check('unknown <Marquee> dropped, children kept as text', out.Unknown.includes('scrolling') && !out.Unknown.toLowerCase().includes('<marquee'));
check('JS expression {alert(1)} is NOT rendered', !out.Security.includes('alert(1)'));
// The <script> tag is dropped (not allow-listed); any leftover text is inert and
// HTML-escaped by React — what must never appear is a live <script> element.
check('no live <script> element emitted', !out.Security.includes('<script'));

console.log('\n=== RENDER GATE', ok ? 'PASS' : 'FAIL', '===');
process.exit(ok ? 0 : 1);
