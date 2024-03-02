// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { expect, test } from '@jupyterlab/galata';

const fileName = 'notebook.ipynb';
const TOOLTIP_SELECTOR = '.jp-Tooltip';

test.describe('Inspector tooltip', () => {
  test.describe('Notebook', () => {
    test.beforeEach(async ({ page }) => {
      await page.notebook.createNew(fileName);
    });

    test('Open tooltip on notebook', async ({ page }) => {
      await page.notebook.setCell(0, 'code', 'int');
      await page.notebook.enterCellEditingMode(0);

      await page.keyboard.press('Shift+Tab');
      let tooltip = page.locator(TOOLTIP_SELECTOR);
      await tooltip.waitFor();
      expect(await tooltip.screenshot()).toMatchSnapshot('tooltip.png');

      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
    });

    test('Prevent dedent when tooltip gets opened', async ({ page }) => {
      await page.notebook.setCell(0, 'code', '    int');
      await page.notebook.enterCellEditingMode(0);

      await page.keyboard.press('Shift+Tab');
      let tooltip = page.locator(TOOLTIP_SELECTOR);
      await tooltip.waitFor();

      const cellEditor = await page.notebook.getCellInput(0);
      const text = await cellEditor.textContent();
      expect(text).toBe('    int');
    });
  });
});
