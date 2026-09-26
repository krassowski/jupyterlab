#!/bin/bash

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

# Starts JupyterLab, waits for it, and runs one shard of the Chromium
# `jupyterlab` project against the committed reference screenshots. The
# Playwright configuration is the one on main; only the reporters differ, so
# that every screenshot comparison is recorded.
#
# Format:
#   SHARD=1 SHARDS=6 COMPARISON_LABEL="Fedora 44" [TEST_PATTERN=regex] \
#       bash scripts/run_ui_tests_shard.sh

set -x

cd galata || exit 1
echo "CI=${CI:-}"

jlpm start > /tmp/jupyterlab_server.log 2>&1 &

if ! timeout 360 bash -c 'until curl -sf http://localhost:8888/lab > /dev/null 2>&1; do sleep 1; done'; then
    cat /tmp/jupyterlab_server.log
    exit 1
fi

TEST_ARGS=(--project jupyterlab --shard "${SHARD}/${SHARDS}")
if [[ -n "${TEST_PATTERN:-}" ]]; then
    TEST_ARGS+=(--grep "${TEST_PATTERN}")
fi

PLAYWRIGHT_JSON_OUTPUT_FILE=test-results/report.json \
    jlpm test "${TEST_ARGS[@]}" \
    --reporter=list,json,./snapshot-comparisons-reporter.js
