// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';
import * as fs from 'fs';
import * as path from 'path';

test.use({ autoGoto: false });

const fileName = 'simple_notebook.ipynb';

/**
 * CSS giving a page outside of JupyterLab the fonts which Galata pins.
 *
 * The printed notebook is rendered by nbconvert and does not load the Galata
 * extension, so without this CSS its text would use the system fonts. The font
 * files are inlined because that page has no stable URL to the extension assets.
 */
function pinnedFontsCSS(): string {
  const fontFaces = ['@fontsource/dejavu-sans', '@fontsource/dejavu-mono'].map(
    fontPackage => {
      const cssPath = require.resolve(fontPackage);
      return fs
        .readFileSync(cssPath, 'utf-8')
        .replace(/url\(\.\/(files\/[^)]+)\)/g, (_, file: string) => {
          const data = fs.readFileSync(path.join(path.dirname(cssPath), file));
          const type = file.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
          return `url(data:${type};base64,${data.toString('base64')})`;
        });
    }
  );
  return `${fontFaces.join('\n')}
:root {
  --jp-ui-font-family: 'DejaVu Sans' !important;
  --jp-content-font-family: 'DejaVu Sans' !important;
  --jp-code-font-family-default: 'DejaVu Mono' !important;
  font-kerning: normal;
  -webkit-font-smoothing: none;
  -moz-osx-font-smoothing: none;
  font-optical-sizing: none;
}`;
}

test.describe('Print layout', () => {
  test('Notebook', async ({ page, tmpPath }) => {
    await page.emulateMedia({ media: 'print' });
    await page.contents.uploadFile(
      path.resolve(__dirname, `./notebooks/${fileName}`),
      `${tmpPath}/${fileName}`
    );
    await page.contents.uploadFile(
      path.resolve(__dirname, './notebooks/WidgetArch.png'),
      `${tmpPath}/WidgetArch.png`
    );

    await page.goto();

    await page.notebook.openByPath(`${tmpPath}/${fileName}`);

    await page.getByText('Python 3 (ipykernel) | Idle').waitFor();

    await page.notebook.run();

    let printedNotebookURL = '';
    await Promise.all([
      page.waitForRequest(
        async request => {
          const url = request.url();
          if (url.match(/\/nbconvert\//) !== null) {
            printedNotebookURL = url;
            return true;
          }
          return false;
        },
        { timeout: 1000 }
      ),
      page.keyboard.press('Control+P')
    ]);

    const newPage = await page.context().newPage();

    // Add the pinned fonts before MathJax typesets, as it measures the text font
    await newPage.addInitScript(css => {
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
      });
    }, pinnedFontsCSS());

    await newPage.goto(printedNotebookURL, { waitUntil: 'load' });

    // Wait until MathJax loading message disappears
    const mathJaxMessage = newPage.locator('#MathJax_Message');
    await expect(mathJaxMessage).toHaveCount(1);
    await mathJaxMessage.waitFor({ state: 'hidden' });

    await newPage.evaluate(async () => {
      await document.fonts.load("16px 'DejaVu Sans'");
      await document.fonts.load("16px 'DejaVu Mono'");
      await document.fonts.ready;
    });

    expect(await newPage.screenshot()).toMatchSnapshot('printed-notebook.png');
  });
});
