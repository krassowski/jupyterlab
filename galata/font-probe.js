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

const SUITE_ARGS = [
  '--disable-lcd-text',
  '--disable-webgl',
  '--force-color-profile=srgb',
  '--disable-skia-runtime-opts',
  '--font-render-hinting=full',
  '--force-device-scale-factor=1',
  '--disable-gpu',
  '--disable-accelerated-2d-canvas'
];

const VARIANTS = [
  { name: 'default', args: [], textRendering: 'auto' },
  { name: 'geometric', args: [], textRendering: 'geometricPrecision' },
  {
    name: 'contrast0-gamma0',
    args: ['--text-contrast=0', '--text-gamma=0'],
    textRendering: 'auto'
  },
  {
    name: 'contrast1-gamma2.2',
    args: ['--text-contrast=1', '--text-gamma=2.2'],
    textRendering: 'auto'
  }
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
      `<div class="row"><span id="${s.id}" style="font-family:'${s.font}';font-weight:${s.weight};font-style:${s.style}">${s.text}</span></div>`
  ).join('\n');

  return `<!doctype html><meta charset="utf-8"><style>
${faces}
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
       font-kerning: normal; font-optical-sizing: none; }
body { margin: 0; background: #fff; font-size: 13px; }
.row { padding: 3px 8px; }
span { white-space: pre; }
</style>${rows}`;
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
    `### Advance widths on ${process.platform}, setting: ${label}`,
    '',
    header,
    `| --- | ${VARIANTS.map(() => '---:').join(' | ')} |`,
    ...SAMPLES.map(
      s =>
        `| ${s.id} | ${VARIANTS.map(v => results[v.name][s.id]).join(' | ')} |`
    ),
    ''
  ];
  const text = lines.join('\n');
  process.stdout.write(text + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
})();
