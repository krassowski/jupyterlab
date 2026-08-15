// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.
//
// TEMPORARY probe, not meant to be merged. Deletes rendered markdown cells
// (no kernel involved). The editor delta guards cell teardown; the
// MarkdownCell delta currently fails on a known separate retention: the
// hidden Table of Contents buffers the previous headings (with `cellRef`)
// in its React tree until the next commit, tracked as a follow-up.

import { expect, test } from '@jupyterlab/galata';

const CELLS = 50;

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
  MarkdownCell: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    return Object.getPrototypeOf(
      nb.widgets.find(c => c.model.type === 'markdown')
    );
  })()`,
  CodeMirrorEditor: `(() => {
    const nb = window.jupyterapp.shell.currentWidget.content;
    const cell = nb.widgets.find(c => c.model.type === 'markdown');
    return Object.getPrototypeOf(cell.editor);
  })()`
};

test('deleted rendered markdown cells are released', async ({ page }) => {
  test.setTimeout(600000);
  await page.notebook.createNew();
  await page.notebook.setCell(0, 'markdown', '# anchor');

  const cdp = await page.context().newCDPSession(page.mainFrame());
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Performance.enable');

  const fullGC = async () => {
    const onChunk = () => undefined;
    cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  };

  const fullyRender = async () => {
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
  };

  const measure = async () => {
    await fullyRender();
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

  // Insert rendered markdown cells programmatically (markdown cells start
  // rendered; no kernel is involved).
  await page.evaluate((count: number) => {
    const nb = (window as any).jupyterapp.shell.currentWidget;
    const sharedModel = nb.context.model.sharedModel;
    const cells = Array.from({ length: count }, (_, i) => ({
      cell_type: 'markdown',
      source: `## Heading ${i}\n\nSome *rendered* text with a [link](https://example.com/${i}).\n`
    }));
    sharedModel.insertCells(sharedModel.cells.length, cells);
  }, CELLS);
  await page.waitForFunction(
    (n: number) =>
      (window as any).jupyterapp.shell.currentWidget?.content?.widgets
        ?.length ===
      n + 1,
    CELLS
  );
  await fullyRender();

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
  console.log('=== DELETE-MD PROBE ===');
  console.log(`markdown cells: ${CELLS}`);
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
  console.log('=======================');

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

  expect(after.counts.MarkdownCell).toBe(before.counts.MarkdownCell);
  expect(after.counts.CodeMirrorEditor).toBe(before.counts.CodeMirrorEditor);
});
