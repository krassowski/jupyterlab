// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// TEMPORARY probe, not meant to be merged. Measures whether notebook views are
// released once disposed, by cloning a notebook view and closing the clone in a
// loop. The context (and so the notebook model) stays alive throughout because
// the original view stays open, which is exactly the "sender outlives the
// receiver" situation `jupyter/prefer-signal-this-arg` reports.

import { expect, test } from '@jupyterlab/galata';
import * as fs from 'fs';

const CYCLES = 5;
const CELL_COUNT = 75;

/**
 * Count the live objects whose prototype is the one `expression` evaluates to.
 *
 * `Runtime.queryObjects` alone is not trustworthy: its implicit collection is
 * weaker than the one a heap snapshot forces, so `measure()` below settles
 * pending disposal work and forces a full GC before counting.
 */
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
  Notebook: `Object.getPrototypeOf(window.jupyterapp.shell.currentWidget.content)`,
  CodeCell: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    return Object.getPrototypeOf(nb.widgets.find(c => c.model.type === 'code'));
  })()`,
  OutputArea: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    const cell = nb.widgets.find(c => c.model.type === 'code');
    return Object.getPrototypeOf(cell.outputArea);
  })()`,
  CodeMirrorEditor: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    const cell = nb.widgets.find(c => c.model.type === 'code');
    return Object.getPrototypeOf(cell.editor);
  })()`
};

test('notebook views are released after being closed', async ({ page }) => {
  test.setTimeout(1200000);
  await page.notebook.createNew();
  await page.notebook.setCell(0, 'code', 'print("cell 0")');
  // Build the remaining cells programmatically: typing 75 sources through
  // the UI is too slow and galata's run() idle detection is flaky at this
  // scale.
  await page.evaluate((count: number) => {
    const nb = (window as any).jupyterapp.shell.currentWidget;
    const sharedModel = nb.context.model.sharedModel;
    const cells = Array.from({ length: count - 1 }, (_, i) => ({
      cell_type: 'code',
      source: `print("cell ${i + 1}")`
    }));
    sharedModel.insertCells(sharedModel.cells.length, cells);
  }, CELL_COUNT);
  await page.waitForFunction(
    (n: number) =>
      (window as any).jupyterapp.shell.currentWidget?.content?.widgets
        ?.length === n,
    CELL_COUNT
  );
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

  // Galata's `page` is a proxy, so hand the CDP session the real main frame.
  const cdp = await page.context().newCDPSession(page.mainFrame());
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Performance.enable');

  // `HeapProfiler.collectGarbage` is best effort and demonstrably weaker
  // than the full collection a heap snapshot forces: counts taken after it
  // can exceed what the very next snapshot contains. Taking (and
  // discarding) a snapshot is the one reliable way to force the full GC.
  const fullGC = async () => {
    const onChunk = () => undefined;
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  };

  const measure = async () => {
    // Bring the live view to a deterministic fully-rendered state first:
    // windowed rendering creates cell content lazily, so cells initialized
    // between the two measurements would show up as false growth.
    await page.evaluate(async () => {
      const content = (window as any).jupyterapp.shell.currentWidget.content;
      for (let i = 0; i < content.widgets.length; i++) {
        await content.scrollToItem(i);
      }
      await content.scrollToItem(0);
    });
    await page.waitForFunction(() => {
      const content = (window as any).jupyterapp.shell.currentWidget.content;
      return content.widgets.every((w: any) => w.placeholder === false);
    });
    // Let in-flight disposal debris settle first: rejected ticks of disposed
    // pollers hold their frames (and through them the widgets) until the
    // promise reaction queue drains, which is transient churn, not a leak.
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() =>
            setTimeout(
              () => requestAnimationFrame(() => setTimeout(resolve, 1000)),
              1000
            )
          )
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
    // DOM view of the leak: the V8 heap misses detached-DOM weight.
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
    await page.evaluate(async () => {
      await (window as any).jupyterapp.commands.execute('docmanager:clone');
    });
    // Wait for the clone to create its own cell widgets.
    await expect(page.locator('.jp-Notebook')).toHaveCount(2);
    await page.waitForFunction(
      (n: number) =>
        (window as any).jupyterapp.shell.currentWidget?.content?.widgets
          ?.length === n,
      CELL_COUNT
    );
    // Let the clone finish rendering before closing it, as a user looking at
    // the view would: outputs still rendering at close are parked by the
    // async render pipeline (a separate, bounded issue tracked upstream).
    await page.waitForFunction(() => {
      const content = (window as any).jupyterapp.shell.currentWidget?.content;
      return content?.widgets?.every((w: any) => w.placeholder === false);
    });
    await page.evaluate(
      () =>
        new Promise(resolve =>
          requestAnimationFrame(() => setTimeout(resolve, 300))
        )
    );
    await page.evaluate(() => {
      (window as any).jupyterapp.shell.currentWidget.close();
    });
    await expect(page.locator('.jp-Notebook')).toHaveCount(1);
  }

  const after = await measure();

  const mib = (b: number) => (b / 1024 / 1024).toFixed(1);
  console.log('=== LEAK PROBE ===');
  console.log(`cycles: ${CYCLES}, cells per view: ${CELL_COUNT}`);
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
  console.log('==================');

  if (process.env.LEAK_PROBE_SNAPSHOT) {
    const chunks: string[] = [];
    const onChunk = (event: { chunk: string }) => chunks.push(event.chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
    fs.writeFileSync(process.env.LEAK_PROBE_SNAPSHOT, chunks.join(''));
    console.log(`snapshot written to ${process.env.LEAK_PROBE_SNAPSHOT}`);
  }

  // A released view leaves nothing behind, so the counts should not grow.
  expect(after.counts.Notebook).toBe(before.counts.Notebook);
  expect(after.counts.CodeCell).toBe(before.counts.CodeCell);
  expect(after.counts.OutputArea).toBe(before.counts.OutputArea);
});
