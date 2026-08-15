// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// TEMPORARY probe, not meant to be merged. Opens and closes a 75 cell
// notebook repeatedly, without interacting with it, and checks that closed
// panels are released. A small second notebook stays open throughout so the
// class prototypes can be resolved at measurement time.

import { expect, test } from '@jupyterlab/galata';

const CELLS = 75;
const CYCLES = 5;

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
  NotebookPanel: `Object.getPrototypeOf(window.jupyterapp.shell.currentWidget)`,
  Notebook: `Object.getPrototypeOf(window.jupyterapp.shell.currentWidget.content)`,
  CodeCell: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    return Object.getPrototypeOf(nb.widgets.find(c => c.model.type === 'code'));
  })()`
};

test('closed notebooks are released', async ({ page }) => {
  test.setTimeout(900000);
  page.on('console', msg => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`PAGE-${msg.type()}: ${msg.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', err => {
    console.log(`PAGE-EXCEPTION: ${String(err).slice(0, 300)}`);
  });

  // The anchor notebook, kept open for prototype resolution.
  await page.notebook.createNew();
  await page.notebook.setCell(0, 'code', 'pass');

  // The big notebook: built programmatically, saved, then closed.
  await page.notebook.createNew();
  await page.evaluate((count: number) => {
    const nb = (window as any).jupyterapp.shell.currentWidget;
    const sharedModel = nb.context.model.sharedModel;
    const cells = Array.from({ length: count }, (_, i) => ({
      cell_type: 'code',
      source: `x${i} = ${i}`
    }));
    sharedModel.insertCells(sharedModel.cells.length, cells);
  }, CELLS);
  await page.waitForFunction(
    (n: number) =>
      (window as any).jupyterapp.shell.currentWidget?.content?.widgets
        ?.length >= n,
    CELLS
  );
  const bigPath = await page.evaluate(async () => {
    const app = (window as any).jupyterapp;
    // `docmanager:save` would show the rename-on-save dialog for an
    // untitled file and never resolve; save the context directly.
    await app.shell.currentWidget.context.save();
    return app.shell.currentWidget.context.path;
  });
  // close(true) reverts and handles the save prompt that appears when the
  // kernel session dirties the metadata.
  await page.notebook.close(true);
  await expect(page.locator('.jp-Notebook')).toHaveCount(1);

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

  for (let i = 0; i < CYCLES; i++) {
    await page.evaluate(async (path: string) => {
      await (window as any).jupyterapp.commands.execute('docmanager:open', {
        path
      });
    }, bigPath);
    await page.waitForFunction(
      (n: number) =>
        (window as any).jupyterapp.shell.currentWidget?.content?.widgets
          ?.length >= n,
      CELLS
    );
    // Wait for session readiness, which is what gates the handlers
    // registered by the debugger extension, before the close.
    await page.waitForFunction(
      () =>
        (window as any).jupyterapp.shell.currentWidget?.sessionContext
          ?.isReady === true,
      undefined,
      { timeout: 60000 }
    );
    await page.waitForTimeout(500);
    await page.notebook.close(true);
    await expect(page.locator('.jp-Notebook')).toHaveCount(1);
  }

  const after = await measure();

  const mib = (b: number) => (b / 1024 / 1024).toFixed(1);
  console.log('=== CLOSE PROBE ===');
  console.log(`cycles: ${CYCLES}, cells: ${CELLS}`);
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
  console.log('===================');

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

  expect(after.counts.NotebookPanel).toBe(before.counts.NotebookPanel);
  expect(after.counts.Notebook).toBe(before.counts.Notebook);
  expect(after.counts.CodeCell).toBe(before.counts.CodeCell);
});
