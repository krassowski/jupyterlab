// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Renders one self-contained page under a few rendering settings and reports
// the advance widths it measures. The page embeds the same fonts the galata
// extension ships, so running it on macOS, Windows and Linux shows how far
// apart the platforms are without involving JupyterLab or any reference image.
//
//   PROBE_LABEL=default node galata/font-probe.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// Taken from the suite's own configuration so the two cannot drift apart.
const SUITE_ARGS = require('./playwright.config').projects.find(
  project => project.name === 'jupyterlab'
).use.launchOptions.args;

const VARIANTS = [
  { name: 'default', args: [], textRendering: 'auto' },
  { name: 'geometric', args: [], textRendering: 'geometricPrecision' }
];

const SAMPLES = [
  {
    id: 'sans-400',
    font: 'Bundled',
    weight: 400,
    style: 'normal',
    text: 'Notebook kernel idle 1234567890'
  },
  {
    id: 'sans-700-real',
    font: 'Bundled',
    weight: 700,
    style: 'normal',
    text: 'Notebook kernel idle 1234567890'
  },
  {
    id: 'sans-700-faked',
    font: 'Upright Only',
    weight: 700,
    style: 'normal',
    text: 'Notebook kernel idle 1234567890'
  },
  {
    id: 'sans-italic',
    font: 'Bundled',
    weight: 400,
    style: 'italic',
    text: 'Notebook kernel idle 1234567890'
  },
  {
    id: 'mono-400',
    font: 'Bundled Mono',
    weight: 400,
    style: 'normal',
    text: 'def f(x): return x ** 2'
  },
  {
    id: 'menu-item',
    font: 'Bundled',
    weight: 400,
    style: 'normal',
    text: 'Run Selected Cells and Advance    Shift+Enter'
  }
];

function dataUrl(pkg, file) {
  const full = path.join(
    __dirname,
    '..',
    'node_modules',
    '@fontsource',
    pkg,
    'files',
    file
  );
  return `url(data:font/woff2;base64,${fs.readFileSync(full).toString('base64')}) format('woff2')`;
}

function buildPage() {
  const faces = [
    `@font-face{font-family:'Bundled';font-weight:400;font-style:normal;src:${dataUrl('dejavu-sans', 'dejavu-sans-latin-400-normal.woff2')}}`,
    `@font-face{font-family:'Bundled';font-weight:700;font-style:normal;src:${dataUrl('dejavu-sans', 'dejavu-sans-latin-700-normal.woff2')}}`,
    `@font-face{font-family:'Bundled';font-weight:400;font-style:italic;src:${dataUrl('dejavu-sans', 'dejavu-sans-latin-400-italic.woff2')}}`,
    // Declares 400 only, so weight 700 against it is the browser's fake bold.
    `@font-face{font-family:'Upright Only';font-weight:400;font-style:normal;src:${dataUrl('dejavu-sans', 'dejavu-sans-latin-400-normal.woff2')}}`,
    `@font-face{font-family:'Bundled Mono';font-weight:400;font-style:normal;src:${dataUrl('dejavu-mono', 'dejavu-mono-latin-400-normal.woff2')}}`
  ].join('\n');

  const rows = SAMPLES.map(
    s =>
      `<div class="row" style="font-family:'${s.font}'"><span id="${s.id}" style="font-weight:${s.weight};font-style:${s.style}">${s.text}</span></div>`
  ).join('\n');

  return `<!doctype html><meta charset="utf-8"><style>
${faces}
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
       font-kerning: normal; font-optical-sizing: none; }
body { margin: 0; background: #fff; font-size: 13px; }
.row { padding: 3px 8px; }
span { white-space: pre; }
/* Struts: the height that line-height normal resolves to at a given size.
   Blink derives it from the ascent and descent each platform reads from the
   font, so a difference here moves every baseline that relies on normal. */
.strut { font-family: 'Bundled'; line-height: normal; }
</style>${rows}
<div class="strut" id="strut-13" style="font-size:13px">x</div>
<div class="strut" id="strut-14" style="font-size:14px">x</div>`;
}

async function runVariant(variant, outDir) {
  const browser = await chromium.launch({
    channel: 'chromium-headless-shell',
    args: [...SUITE_ARGS, ...variant.args]
  });
  const page = await browser.newPage({ viewport: { width: 460, height: 160 } });
  await page.setContent(buildPage());
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(value => {
    document.documentElement.style.textRendering = value;
  }, variant.textRendering);
  await page.screenshot({ path: path.join(outDir, `${variant.name}.png`) });
  const widths = await page.evaluate(
    ids =>
      Object.fromEntries(
        ids.map(id => [
          id,
          document.getElementById(id).getBoundingClientRect().width
        ])
      ),
    SAMPLES.map(s => s.id)
  );
  for (const id of ['strut-13', 'strut-14']) {
    widths[id] = await page.evaluate(
      key => document.getElementById(key).getBoundingClientRect().height,
      id
    );
  }
  await browser.close();
  return widths;
}

(async () => {
  const label = process.env.PROBE_LABEL || 'default';
  const outDir = path.join(__dirname, 'font-probe-results', label);
  fs.mkdirSync(outDir, { recursive: true });

  const results = {};
  for (const variant of VARIANTS) {
    results[variant.name] = await runVariant(variant, outDir);
  }
  fs.writeFileSync(
    path.join(outDir, 'widths.json'),
    JSON.stringify({ platform: process.platform, label, results }, null, 1)
  );

  const header = `| Sample | ${VARIANTS.map(v => v.name).join(' | ')} |`;
  const lines = [
    `### Text metrics on ${process.platform}, setting: ${label}`,
    '',
    header,
    `| --- | ${VARIANTS.map(() => '---:').join(' | ')} |`,
    ...[...SAMPLES.map(s => s.id), 'strut-13', 'strut-14'].map(
      id => `| ${id} | ${VARIANTS.map(v => results[v.name][id]).join(' | ')} |`
    ),
    ''
  ];
  const text = lines.join('\n');
  process.stdout.write(text + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
})();
