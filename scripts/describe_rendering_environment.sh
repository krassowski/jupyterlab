#!/bin/bash

# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.

# Prints what decides how the headless browser draws text: the distribution,
# the font packages, the fonts that fontconfig finds, the fontconfig settings,
# and the browser build. Run it from the repository root after the browser is
# installed.

set -uo pipefail

section() {
    echo
    echo "=== $1"
}

section "Distribution"
cat /etc/os-release

# The Ubuntu runner has rpm installed too, so ask dpkg first.
section "Font packages"
if [[ -f /etc/debian_version ]]; then
    dpkg-query -W -f '${Package} ${Version}\n' | grep -i font | sort
else
    rpm -qa --qf '%{NAME} %{VERSION}-%{RELEASE}\n' | grep -i font | sort
fi

section "Text rendering libraries"
if [[ -f /etc/debian_version ]]; then
    dpkg-query -W libfontconfig1 fontconfig-config libfreetype6 libharfbuzz0b libpango-1.0-0 libcairo2 2>&1
else
    rpm -q fontconfig libfontconfig1 freetype libfreetype6 harfbuzz pango cairo 2>&1 | grep -v 'is not installed'
    rpm -q --whatprovides 'font(:lang=en)' 2>&1
fi
fc-list --version 2>&1

section "Fonts found by fontconfig ($(fc-list | wc -l))"
fc-list --format '%{file} | %{family[0]} | %{style[0]}\n' | sort

section "Font matches"
for pattern in sans-serif serif monospace system-ui emoji 'DejaVu Sans' 'DejaVu Sans Mono' 'Noto Sans SC'; do
    printf '%-18s -> %s\n' "${pattern}" "$(fc-match "${pattern}")"
done

section "Rendering settings for sans-serif"
fc-match -v sans-serif | grep -E '^\s*(antialias|hinting|hintstyle|autohint|rgba|lcdfilter|embeddedbitmap|fontversion):'

section "Fontconfig configuration files in use"
if fc-conflist > /dev/null 2>&1; then
    fc-conflist | grep '^+'
else
    ls -l /etc/fonts/conf.d
fi

section "Browser"
BROWSERS_JSON=node_modules/playwright-core/browsers.json
if [[ -f "${BROWSERS_JSON}" ]]; then
    grep -A5 '"chromium' "${BROWSERS_JSON}"
fi
BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
BROWSER_BIN="$(find "${BROWSERS_DIR}" -type f \( -name chrome-headless-shell -o -name headless_shell \) | head -n 1)"
echo "Binary: ${BROWSER_BIN}"
if [[ -n "${BROWSER_BIN}" ]]; then
    "${BROWSER_BIN}" --version 2>&1 | head -n 3
    echo "Libraries that are missing or that draw text:"
    ldd "${BROWSER_BIN}" | grep -E 'not found|fontconfig|freetype|harfbuzz|expat|png' || echo "(none)"
fi

exit 0
