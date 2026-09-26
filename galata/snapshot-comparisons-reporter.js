// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Records every screenshot comparison that a run makes, and the outcome of
// every test attempt. The JSON report keeps only the error of each failing
// test, so without this record a test whose screenshots all matched looks the
// same as a test that takes no screenshot at all.
//
// Use it next to the other reporters:
//   jlpm test --reporter=list,json,./snapshot-comparisons-reporter.js
//
// The output goes to test-results/snapshot-comparisons.json, or to the file
// that SNAPSHOT_COMPARISONS_FILE names. COMPARISON_LABEL and SHARD, when set,
// are copied into the output to tell the platforms and shards apart.

const fs = require('fs');
const path = require('path');

const MATCHERS = /toMatchSnapshot|toHaveScreenshot/;
const ANSI = /\u001b\[[0-9;]*m/g;

function clean(text) {
  return (text || '').replace(ANSI, '');
}

class SnapshotComparisonsReporter {
  constructor(options = {}) {
    this.outputFile =
      options.outputFile ||
      process.env.SNAPSHOT_COMPARISONS_FILE ||
      'test-results/snapshot-comparisons.json';
    this.baseDir = process.cwd();
    this.sources = new Map();
    this.comparisons = [];
    this.attempts = [];
  }

  onBegin(config) {
    this.baseDir = config.configFile
      ? path.dirname(config.configFile)
      : config.rootDir || process.cwd();
  }

  relative(file) {
    return file ? path.relative(this.baseDir, file) : '';
  }

  // The step title of `expect(buffer).toMatchSnapshot(name)` does not carry
  // the name, so keep the line of source that makes the comparison.
  sourceLine(location) {
    if (!location) {
      return '';
    }
    if (!this.sources.has(location.file)) {
      let lines = [];
      try {
        lines = fs.readFileSync(location.file, 'utf-8').split('\n');
      } catch {
        // The line is only there to help a reader; it is fine without it.
      }
      this.sources.set(location.file, lines);
    }
    return (this.sources.get(location.file)[location.line - 1] || '').trim();
  }

  describe(test) {
    return {
      testId: test.id,
      project: test.parent.project() ? test.parent.project().name : '',
      file: this.relative(test.location.file),
      // titlePath() starts with the root suite, the project and the file.
      title: test.titlePath().slice(3).join(' › ')
    };
  }

  onStepEnd(test, result, step) {
    if (step.category !== 'expect') {
      return;
    }
    const source = this.sourceLine(step.location);
    if (!MATCHERS.test(step.title) && !MATCHERS.test(source)) {
      return;
    }
    this.comparisons.push({
      ...this.describe(test),
      retry: result.retry,
      step: step.title,
      location: step.location
        ? `${this.relative(step.location.file)}:${step.location.line}`
        : '',
      source,
      passed: !step.error,
      error: step.error
        ? clean(step.error.message || String(step.error.value || ''))
        : '',
      attachments: (step.attachments || []).map(attachment => ({
        name: attachment.name,
        path: this.relative(attachment.path)
      }))
    });
  }

  onTestEnd(test, result) {
    this.attempts.push({
      ...this.describe(test),
      retry: result.retry,
      status: result.status,
      expectedStatus: test.expectedStatus,
      duration: result.duration,
      errors: result.errors.map(error =>
        clean(error.message || String(error.value || '')).slice(0, 4000)
      ),
      attachments: result.attachments.map(attachment => ({
        name: attachment.name,
        path: this.relative(attachment.path)
      }))
    });
  }

  onEnd(result) {
    const file = path.resolve(this.baseDir, this.outputFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          label: process.env.COMPARISON_LABEL || '',
          shard: process.env.SHARD || '',
          status: result.status,
          attempts: this.attempts,
          comparisons: this.comparisons
        },
        null,
        1
      )
    );
  }

  printsToStdio() {
    return false;
  }
}

module.exports = SnapshotComparisonsReporter;
