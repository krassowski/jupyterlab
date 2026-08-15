// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// TEMPORARY probe, not meant to be merged. Adds cells with sizeable outputs,
// interacts with each (making it the active cell, which parks the cell
// toolbar in its input area), runs them, then deletes them. Deleting a cell
// removes its model from the document, so anything a retained OutputArea
// still references is exclusively retained, unlike in the clone-and-close
// scenario where views share the model.

import { expect, test } from '@jupyterlab/galata';

const CELLS = 75;
const PAYLOAD = 262144; // characters of stream output per cell

async function countInstances(
  cdp: any,
  prototypeExpression: string
): Promise<number> {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: prototypeExpression
  });
  if (!result.objectId) {
    throw new Error(`Not an object: ${prototypeExpression} -> ${result.type}`);
  }
  const { objects } = await cdp.send('Runtime.queryObjects', {
    prototypeObjectId: result.objectId
  });
  const { result: count } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId,
    functionDeclaration: 'function () { return this.length; }',
    returnByValue: true
  });
  await cdp.send('Runtime.releaseObject', { objectId: objects.objectId });
  await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  return count.value;
}

const PROTOTYPES = {
  CodeCell: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    return Object.getPrototypeOf(nb.widgets.find(c => c.model.type === 'code'));
  })()`,
  OutputArea: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    const cell = nb.widgets.find(c => c.model.type === 'code');
    return Object.getPrototypeOf(cell.outputArea);
  })()`,
  OutputAreaModel: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    const cell = nb.widgets.find(c => c.model.type === 'code');
    return Object.getPrototypeOf(cell.outputArea.model);
  })()`
};

test('deleted cells are released', async ({ page }) => {
  test.setTimeout(1200000);
  await page.notebook.createNew();
  await page.notebook.setCell(0, 'code', 'pass');

  const cdp = await page.context().newCDPSession(page.mainFrame());
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Performance.enable');

  const fullGC = async () => {
    const onChunk = () => undefined;
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  };

  const measure = async () => {
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => setTimeout(resolve, 200))
        )
    );
    await fullGC();
    const counts: Record<string, number> = {};
    for (const [name, expression] of Object.entries(PROTOTYPES)) {
      counts[name] = await countInstances(cdp, expression);
    }
    const { usedSize } = (await cdp.send('Runtime.getHeapUsage')) as {
      usedSize: number;
    };
    const { metrics } = (await cdp.send('Performance.getMetrics')) as {
      metrics: { name: string; value: number }[];
    };
    const domNodes = metrics.find(m => m.name === 'Nodes')?.value ?? 0;
    const listeners =
      metrics.find(m => m.name === 'JSEventListeners')?.value ?? 0;
    return { counts, usedSize, domNodes, listeners };
  };

  const before = await measure();

  // Add the cells, giving each a sizeable stream output.
  for (let i = 1; i <= CELLS; i++) {
    await page.notebook.addCell('code', `print("A" * ${PAYLOAD})`);
  }
  // Run through the command and wait on execution counts: galata's run()
  // execution tracker stalls on this scale of output.
  await page.evaluate(() => {
    void (window as any).jupyterapp.commands.execute('notebook:run-all-cells');
  });
  await page.waitForFunction(
    () => {
      const nb = (window as any).jupyterapp.shell.currentWidget?.content;
      const cells = nb?.model?.cells;
      if (!cells) {
        return false;
      }
      for (let i = 0; i < cells.length; i++) {
        const cell = cells.get(i);
        if (cell.type === 'code' && !cell.executionCount) {
          return false;
        }
      }
      return true;
    },
    undefined,
    { timeout: 300000 }
  );
  await page.waitForFunction(
    (n: number) =>
      (window as any).jupyterapp.shell.currentWidget?.content?.widgets
        ?.length === n,
    CELLS + 1
  );

  // Visit each cell so the cell toolbar is parked in its input area at least
  // once, as happens when a user interacts with the cell.
  for (let i = 1; i <= CELLS; i++) {
    await page.notebook.selectCells(i);
  }

  // Delete all the added cells.
  for (let i = 0; i < CELLS; i++) {
    await page.notebook.selectCells(1);
    await page.keyboard.press('d');
    await page.keyboard.press('d');
  }
  await page.waitForFunction(
    () =>
      (window as any).jupyterapp.shell.currentWidget?.content?.widgets
        ?.length === 1
  );

  const after = await measure();

  const mib = (b: number) => (b / 1024 / 1024).toFixed(1);
  console.log('=== DELETE-CELL PROBE ===');
  console.log(`cells: ${CELLS}, output per cell: ${PAYLOAD} chars`);
  for (const name of Object.keys(PROTOTYPES)) {
    console.log(
      `${name.padEnd(18)} before=${before.counts[name]}  ` +
        `after=${after.counts[name]}  ` +
        `delta=${after.counts[name] - before.counts[name]}`
    );
  }
  console.log(
    `heap used: before=${mib(before.usedSize)} MiB  ` +
      `after=${mib(after.usedSize)} MiB  ` +
      `delta=${mib(after.usedSize - before.usedSize)} MiB`
  );
  console.log(
    `dom nodes: before=${before.domNodes}  after=${after.domNodes}  ` +
      `delta=${after.domNodes - before.domNodes}`
  );
  console.log(
    `listeners: before=${before.listeners}  after=${after.listeners}  ` +
      `delta=${after.listeners - before.listeners}`
  );
  console.log('=========================');

  if (process.env.LEAK_PROBE_SNAPSHOT) {
    const fs = await import('fs');
    const chunks: string[] = [];
    const onChunk = (event: { chunk: string }) => chunks.push(event.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    fs.writeFileSync(process.env.LEAK_PROBE_SNAPSHOT, chunks.join(''));
    console.log(`snapshot written to ${process.env.LEAK_PROBE_SNAPSHOT}`);
  }

  expect(after.counts.OutputArea).toBe(before.counts.OutputArea);
  expect(after.counts.CodeCell).toBe(before.counts.CodeCell);
});
