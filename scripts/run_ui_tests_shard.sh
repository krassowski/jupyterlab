#!/bin/bash

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

# Starts JupyterLab unless it already runs, waits for it, and runs one shard
# of the Chromium `jupyterlab` project against the committed reference
# screenshots. The Playwright configuration is the one of the code under test;
# only the reporters differ, so that every screenshot comparison is recorded.
#
# Run it from the root of the code under test. The reporter comes from the
# checkout that holds this script, which may be another directory.
#
# Format:
#   SHARD=1 SHARDS=6 COMPARISON_LABEL="Fedora 44" [TEST_PATTERN=regex] \
#       [EXTRA_TEST_ARGS="test/jupyterlab/print.test.ts --update-snapshots=changed"] \
#       bash scripts/run_ui_tests_shard.sh

set -x

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORTER="${TOOLS_DIR}/galata/snapshot-comparisons-reporter.js"

cd galata || exit 1
echo "CI=${CI:-}"

if ! curl -sf http://localhost:8888/lab > /dev/null 2>&1; then
    jlpm start >> /tmp/jupyterlab_server.log 2>&1 &
fi

if ! timeout 360 bash -c 'until curl -sf http://localhost:8888/lab > /dev/null 2>&1; do sleep 1; done'; then
    cat /tmp/jupyterlab_server.log
    exit 1
fi

TEST_ARGS=(--project jupyterlab --shard "${SHARD}/${SHARDS}")
if [[ -n "${TEST_PATTERN:-}" ]]; then
    TEST_ARGS+=(--grep "${TEST_PATTERN}")
fi
if [[ -n "${EXTRA_TEST_ARGS:-}" ]]; then
    # The arguments are split into words on purpose.
    # shellcheck disable=SC2206
    TEST_ARGS+=(${EXTRA_TEST_ARGS})
fi

PLAYWRIGHT_JSON_OUTPUT_FILE=test-results/report.json \
    jlpm test "${TEST_ARGS[@]}" \
    --reporter="list,json,${REPORTER}"
