// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// Configuration for checking the Linux reference screenshots on other
// platforms. Playwright starts the server itself here, because backgrounding a
// process between workflow steps does not behave the same on Windows as it
// does on Linux and macOS.

var baseConfig = require('./playwright.config');

module.exports = {
  ...baseConfig,
  webServer: {
    command: 'jupyter lab --config ./jupyter_server_test_config.py',
    url: 'http://localhost:8888/lab',
    timeout: 360000,
    // Reuse a lab already running locally; on CI nothing should hold the
    // port, and a process that does is a problem worth failing on.
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe'
  },
  // A mismatch is the expected outcome, so a retry would only double the time.
  retries: 0,
  use: {
    ...baseConfig.use,
    // The expected, actual and diff images are the artifacts that matter, and
    // a video per failing test would make the upload unusable.
    video: 'off',
    trace: 'off'
  },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/report.json' }],
    [
      require.resolve('./snapshot-steps-reporter.js'),
      { outputFile: 'test-results/snapshot-steps.json' }
    ]
  ]
};
