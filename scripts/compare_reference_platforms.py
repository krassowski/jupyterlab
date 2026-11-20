# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.
"""Summarise how the Linux reference screenshots fared on another platform.

Reads a Playwright JSON report from a run with ``GALATA_REFERENCE_PLATFORM``
set, and reports for every test whether it matched, how far off it was, or
whether it failed for a reason that has nothing to do with the pixels.

A test that passes matched every screenshot it asserts on. A test that fails on
a screenshot stops there, so any screenshot after the failing one in the same
test is never compared.

Format:
    python scripts/compare_reference_platforms.py [report.json] [--label macOS]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

PNG_HEADER = b"\x89PNG\r\n\x1a\n"
PNG_HEADER_SIZE = 24

ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
PIXELS_RE = re.compile(r"(\d+) pixels \(ratio [\d.]+ of all image pixels\) are different")
SIZE_RE = re.compile(r"Expected an image (\d+)px by (\d+)px, received (\d+)px by (\d+)px")
MISSING_RE = re.compile(
    r"A snapshot doesn't exist at (\S+?)(?:, writing actual)?\.?$", re.MULTILINE
)
SNAPSHOT_RE = re.compile(r"^\s*Snapshot: (\S+)\s*$", re.MULTILINE)

MATCHED = "matched"
NO_SCREENSHOT = "no screenshot"
PIXELS = "pixel mismatch"
SIZE = "size mismatch"
MISSING = "reference missing"
OTHER = "failed elsewhere"
SKIPPED = "skipped"

ORDER = [MATCHED, NO_SCREENSHOT, PIXELS, SIZE, MISSING, OTHER, SKIPPED]
# U+203A, the separator Playwright uses between a describe block and a test.
TITLE_SEPARATOR = " \u203a "
COMPARED = (MATCHED, PIXELS, SIZE)
EMPTY_COUNTS = {"comparisons": 0, "failed": 0}


@dataclass
class Row:
    title: str
    verdict: str
    comparisons: int = 0
    matched_comparisons: int = 0
    reference: str = ""
    diff_pixels: int | None = None
    total_pixels: int | None = None
    detail: str = ""

    @property
    def ratio(self) -> float | None:
        if self.diff_pixels is None or not self.total_pixels:
            return None
        return self.diff_pixels / self.total_pixels


def png_size(path: Path) -> tuple[int, int] | None:
    """Read width and height out of a PNG header."""
    try:
        header = path.open("rb").read(PNG_HEADER_SIZE)
    except OSError:
        return None
    if len(header) < PNG_HEADER_SIZE or not header.startswith(PNG_HEADER):
        return None
    return struct.unpack(">II", header[16:24])


def iter_specs(node: dict, titles: tuple[str, ...] = ()):
    for spec in node.get("specs", []):
        yield titles, spec
    for suite in node.get("suites", []):
        yield from iter_specs(suite, (*titles, suite.get("title", "")))


def expected_attachment(result: dict, search_dirs: list[Path]) -> Path | None:
    """Locate the reference image Playwright compared against."""
    for attachment in result.get("attachments", []):
        name = attachment.get("name") or ""
        if name != "expected" and not name.endswith("-expected.png"):
            continue
        raw = attachment.get("path")
        if raw and Path(raw).is_file():
            return Path(raw)
        # The report may come from another machine. Look the file up by name,
        # trying the attachment name too: `toHaveScreenshot` points `path` at
        # the reference in the checkout, which is not in the uploaded results.
        candidates = [name] + ([Path(raw).name] if raw else [])
        for directory in search_dirs:
            for candidate in candidates:
                for found in directory.rglob(candidate):
                    return found
    return None


def message_of(result: dict) -> str:
    parts = [result.get("error", {}).get("message") or ""]
    parts += [error.get("message") or "" for error in result.get("errors", [])]
    return ANSI_RE.sub("", "\n".join(parts))


def classify_failure(
    title: str, result: dict, search_dirs: list[Path], ran: int, matched: int
) -> Row:
    """Say why one failing test failed, and by how much when it is pixels."""
    message = message_of(result)

    missing = MISSING_RE.search(message)
    if missing:
        return Row(
            title,
            MISSING,
            reference=Path(missing.group(1)).name,
            comparisons=ran,
            matched_comparisons=matched,
        )

    reference = expected_attachment(result, search_dirs)
    snapshot = SNAPSHOT_RE.search(message)
    name = reference.name if reference else (snapshot.group(1) if snapshot else "")

    size = SIZE_RE.search(message)
    if size:
        detail = f"reference {size.group(1)}x{size.group(2)}, got {size.group(3)}x{size.group(4)}"
        return Row(
            title,
            SIZE,
            reference=name,
            detail=detail,
            comparisons=ran,
            matched_comparisons=matched,
        )

    pixels = PIXELS_RE.search(message)
    if pixels:
        row = Row(
            title,
            PIXELS,
            reference=name,
            diff_pixels=int(pixels.group(1)),
            comparisons=ran,
            matched_comparisons=matched,
        )
        dimensions = png_size(reference) if reference else None
        if dimensions:
            row.total_pixels = dimensions[0] * dimensions[1]
        return row

    first_line = next((line for line in message.splitlines() if line.strip()), "")
    return Row(
        title,
        OTHER,
        detail=first_line.strip()[:110] or "no error message",
        comparisons=ran,
        matched_comparisons=matched,
    )


def classify(title: str, test: dict, search_dirs: list[Path], counts: dict | None) -> Row:
    """Decide what one test says about the references it compared against."""
    status = test.get("status")
    ran = counts["comparisons"] if counts else 0
    matched = ran - counts["failed"] if counts else 0

    if status == "skipped":
        return Row(title, SKIPPED)
    if status in ("expected", "flaky"):
        # Without the counts every passing test looks like a match, so only
        # make the distinction when they are there.
        if counts is not None and ran == 0:
            return Row(title, NO_SCREENSHOT)
        return Row(title, MATCHED, comparisons=ran, matched_comparisons=matched)

    result = (test.get("results") or [{}])[-1]
    return classify_failure(title, result, search_dirs, ran, matched)


def render(rows: list[Row], label: str, counted: bool) -> str:
    counts = Counter(row.verdict for row in rows)
    compared = sum(counts[key] for key in COMPARED)
    lines = [f"## Linux reference screenshots on {label}", ""]
    lines += ["| Outcome | Tests |", "| --- | ---: |"]
    lines += [f"| {key} | {counts[key]} |" for key in ORDER if counts[key]]
    lines += [f"| **total** | **{len(rows)}** |", ""]
    if counted:
        ran = sum(row.comparisons for row in rows)
        ok = sum(row.matched_comparisons for row in rows)
        lines += [
            f"{ok} of the {ran} screenshot assertions that ran matched the Linux "
            f"references. A test stops at its first mismatch, so the screenshots "
            f"after that one in the same test never ran.",
            "",
        ]
    elif compared:
        lines += [
            f"{counts[MATCHED]} of the {compared} tests that reached a pixel "
            f"comparison matched the Linux references. Without snapshot-steps.json "
            f"a test that takes no screenshot at all is counted as a match here.",
            "",
        ]

    mismatched = [row for row in rows if row.verdict in (PIXELS, SIZE)]
    mismatched.sort(key=lambda row: (row.ratio is None, row.ratio or 0))
    if mismatched:
        lines += ["### How far off the mismatches are", ""]
        lines += [
            "| Test | Reference | Differing pixels | Ratio | Size |",
            "| --- | --- | ---: | ---: | --- |",
        ]
        for row in mismatched:
            pixels = "" if row.diff_pixels is None else f"{row.diff_pixels:,}"
            ratio = "" if row.ratio is None else f"{row.ratio * 100:.3f}%"
            lines.append(f"| {row.title} | {row.reference} | {pixels} | {ratio} | {row.detail} |")
        lines.append("")

    others = [row for row in rows if row.verdict in (OTHER, MISSING)]
    if others:
        lines += ["### Failures that never reached a pixel comparison", ""]
        lines += ["| Test | Why |", "| --- | --- |"]
        for row in others:
            lines.append(f"| {row.title} | {row.detail or row.reference + ' is missing'} |")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "report",
        nargs="?",
        type=Path,
        default=Path("galata/test-results/report.json"),
        help="Playwright JSON report",
    )
    parser.add_argument("--label", default=sys.platform, help="Platform the run happened on")
    parser.add_argument(
        "--steps",
        type=Path,
        default=None,
        help="Screenshot counts from snapshot-steps-reporter.js "
        "(defaults to snapshot-steps.json next to the report)",
    )
    parser.add_argument(
        "--search",
        type=Path,
        action="append",
        default=None,
        help="Directory to look up attachments in when the report comes from another machine",
    )
    args = parser.parse_args()

    if not args.report.is_file():
        sys.stderr.write(f"No report at {args.report}\n")
        return 1

    report = json.loads(args.report.read_text())
    search_dirs = [path for path in (args.search or [args.report.parent]) if path.is_dir()]

    steps_path = args.steps or args.report.parent / "snapshot-steps.json"
    steps = json.loads(steps_path.read_text()) if steps_path.is_file() else None
    if steps is None:
        sys.stderr.write(f"No screenshot counts at {steps_path}\n")

    rows = []
    for suite in report.get("suites", []):
        for titles, spec in iter_specs(suite, (suite.get("title", ""),)):
            title = TITLE_SEPARATOR.join([*titles[1:], spec.get("title", "")])
            # A test missing from the counts ran no comparison at all.
            counts = None if steps is None else steps.get(spec.get("id"), EMPTY_COUNTS)
            rows.extend(
                classify(title, test, search_dirs, counts) for test in spec.get("tests", [])
            )

    text = render(rows, args.label, steps is not None)
    sys.stdout.write(text + "\n")

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
