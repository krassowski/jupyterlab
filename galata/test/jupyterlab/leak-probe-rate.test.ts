// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// TEMPORARY probe, not meant to be merged. Counts how many times the metadata
// form is rebuilt per user action, which is what the metadata editor leak
// scales with. Counting insertions of the editor node works on a build with
// the fix in place, where the field itself is reused.

import { expect, test } from '@jupyterlab/galata';

const CELLS = 20;

interface IRebuildWindow extends Window {
  __rebuilds?: number;
}

test('how often the metadata form is rebuilt', async ({ page }) => {
  await page.notebook.createNew();
  await page.notebook.setCell(0, 'code', 'a = 0');
  for (let i = 1; i < CELLS; i++) {
    await page.notebook.addCell('code', `a = ${i}`);
  }

  await page.sidebar.openTab('jp-property-inspector');
  await page
    .locator('.jp-NotebookTools .jp-Collapse', { hasText: 'Advanced Tools' })
    .click();
  await expect(page.locator('.jp-CellMetadataEditor')).toBeVisible();

  // Every rebuild of the form reinserts the editor node into the document.
  await page.evaluate(() => {
    (window as IRebuildWindow).__rebuilds = 0;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (
            node instanceof Element &&
            (node.matches('.jp-CellMetadataEditor') ||
              node.querySelector('.jp-CellMetadataEditor'))
          ) {
            (window as IRebuildWindow).__rebuilds!++;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });

  const rebuilds = async (): Promise<number> =>
    page.evaluate(() => (window as IRebuildWindow).__rebuilds ?? 0);
  const reset = async (): Promise<void> => {
    await page.evaluate(() => ((window as IRebuildWindow).__rebuilds = 0));
  };
  const report: string[] = [];
  const record = async (label: string, actions: number): Promise<void> => {
    const count = await rebuilds();
    report.push(
      `${label.padEnd(34)} ${String(actions).padStart(4)} actions -> ` +
        `${String(count).padStart(4)} rebuilds (${(count / actions).toFixed(2)} each)`
    );
    await reset();
  };

  await reset();

  // Selecting a different cell.
  for (let i = 0; i < 20; i++) {
    await page.notebook.selectCells(i % CELLS);
  }
  await record('select another cell', 20);

  // Moving the selection with the keyboard, as when navigating a notebook.
  await page.notebook.selectCells(0);
  await reset();
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('ArrowDown');
  }
  await record('arrow down in command mode', 20);

  // Typing inside one cell, no change of active cell.
  await page.notebook.selectCells(0);
  await page.notebook.enterCellEditingMode(0);
  await reset();
  await page.keyboard.type('# typing here', { delay: 20 });
  await record('keystrokes in a cell', 13);
  await page.keyboard.press('Escape');

  // Running cells with Shift+Enter, which also advances the active cell.
  await page.notebook.selectCells(0);
  await reset();
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Shift+Enter');
  }
  await record('shift+enter run and advance', 5);

  console.log('=== FORM REBUILD RATE ===');
  for (const line of report) {
    console.log(line);
  }
  console.log('=========================');
});
