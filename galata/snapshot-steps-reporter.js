// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Records how many screenshot comparisons each test ran. The JSON report only
// carries failures, so without this a test that never takes a screenshot looks
// the same as one whose screenshots all matched.

var fs = require('fs');
var path = require('path');

var SNAPSHOT_MATCHER = /toMatchSnapshot|toHaveScreenshot/;

class SnapshotStepsReporter {
  constructor(options) {
    this._outputFile =
      (options && options.outputFile) || 'test-results/snapshot-steps.json';
    this._counts = new Map();
    this._baseDir = process.cwd();
  }

  onBegin(config) {
    this._baseDir = config.configFile
      ? path.dirname(config.configFile)
      : config.rootDir || process.cwd();
  }

  onStepEnd(test, result, step) {
    if (step.category !== 'expect' || !SNAPSHOT_MATCHER.test(step.title)) {
      return;
    }
    var previous = this._counts.get(test.id);
    // A retry counts from zero rather than adding to the earlier attempt.
    var entry =
      previous && previous.retry === result.retry
        ? previous
        : { retry: result.retry, comparisons: 0, failed: 0 };
    entry.comparisons += 1;
    if (step.error) {
      entry.failed += 1;
    }
    this._counts.set(test.id, entry);
  }

  onEnd() {
    var byTest = {};
    for (var [id, entry] of this._counts) {
      byTest[id] = { comparisons: entry.comparisons, failed: entry.failed };
    }
    var file = path.resolve(this._baseDir, this._outputFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(byTest, null, 1));
  }
}

module.exports = SnapshotStepsReporter;
