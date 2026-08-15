// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// TEMPORARY probe, not meant to be merged. Switches the active cell with the
// metadata editor open, which rebuilds the rjsf form each time, and reports how
// much of the heap that leaves behind.

import { expect, test } from '@jupyterlab/galata';
import * as fs from 'fs';

const ROUNDS = 10;
const CELLS = 3;

test('metadata editor fields survive form rebuilds', async ({ page }) => {
  await page.notebook.createNew();
  await page.notebook.setCell(0, 'code', 'print(0)');
  for (let i = 1; i < CELLS; i++) {
    await page.notebook.addCell('code', `print(${i})`);
  }

  // Distinct metadata per cell, so that the editor content is a signal that
  // the form has been rebuilt for the cell just selected.
  await page.evaluate(count => {
    const notebook = (window as any).jupyterapp.shell.currentWidget.content;
    for (let i = 0; i < count; i++) {
      notebook.model.cells.get(i).setMetadata('probe', `cell-${i}`);
    }
  }, CELLS);

  await page.sidebar.openTab('jp-property-inspector');
  await page.click('.jp-PropertyInspector >> text=Common Tools');
  await page
    .locator('.jp-NotebookTools .jp-Collapse', { hasText: 'Advanced Tools' })
    .click();
  // Both sections have to be rendering, otherwise their field renderers never
  // run and a count of zero would say nothing.
  await expect(page.locator('.jp-ActiveCellTool')).toBeVisible();
  const editor = page.locator('.jp-CellMetadataEditor .cm-content');
  // `addCell` leaves the last cell active.
  await page.notebook.selectCells(0);
  await expect(editor).toContainText('cell-0');

  const cdp = await page.context().newCDPSession(page.mainFrame());
  await cdp.send('HeapProfiler.enable');

  const heapUsed = async (): Promise<number> => {
    await cdp.send('HeapProfiler.collectGarbage');
    const usage: any = await cdp.send('Runtime.getHeapUsage');
    return usage.usedSize;
  };

  const snapshot = async (path: string): Promise<void> => {
    const chunks: string[] = [];
    const onChunk = (event: { chunk: string }) => chunks.push(event.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    fs.writeFileSync(path, chunks.join(''));
  };

  const prefix = process.env.LEAK_PROBE_SNAPSHOT ?? '';
  const before = await heapUsed();
  if (prefix) {
    await snapshot(`${prefix}-before.heapsnapshot`);
  }

  for (let round = 0; round < ROUNDS; round++) {
    for (let index = 0; index < CELLS; index++) {
      await page.notebook.selectCells(index);
      // Waits for the form to have been rebuilt for this cell, and paces the
      // loop so the next switch cannot overtake it.
      await expect(editor).toContainText(`cell-${index}`);
    }
  }

  const after = await heapUsed();
  if (prefix) {
    await snapshot(`${prefix}-after.heapsnapshot`);
  }

  const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
  console.log('=== METADATA LEAK PROBE ===');
  console.log(`form rebuilds: ${ROUNDS * CELLS}`);
  console.log(
    `heap used: before=${mib(before)} MiB  after=${mib(after)} MiB  ` +
      `delta=${mib(after - before)} MiB`
  );
  console.log('===========================');
});
