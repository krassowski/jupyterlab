# Copyright (c) Jupyter Development Team.
# Distributed under the terms of the Modified BSD License.
"""Count the screenshot comparisons of UI test runs on several platforms.

Reads every snapshot-comparisons.json under the given directory. Each file is
written by galata/snapshot-comparisons-reporter.js for one shard on one
platform, and names its platform in its ``label`` field.

For each platform it prints the number of screenshot comparisons that ran,
matched and mismatched, each mismatch with its reference file and differing
pixel count, and the tests that failed for a reason other than a screenshot.

Only the last attempt of each test counts towards the totals. Comparisons made
in an earlier attempt of a retried test are listed separately.

Format:
    python scripts/summarise_snapshot_comparisons.py DIR [--control LABEL]
        [--markdown summary.md] [--json summary.json]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from pathlib import Path

PIXELS_RE = re.compile(r"(\d+) pixels \(ratio ([\d.]+) of all image pixels\) are different")
SIZE_RE = re.compile(r"Expected an image (\d+)px by (\d+)px, received (\d+)px by (\d+)px")
SNAPSHOT_RE = re.compile(r"^\s*Snapshot: (.+?)\s*$", re.MULTILINE)
# A literal name in the line that makes the comparison, for comparisons that
# matched and so carry no name in an error message.
SOURCE_NAME_RE = re.compile(r"[\"'`]([^\"'`]+\.png)[\"'`]")
MISSING_TEXT = "A snapshot doesn't exist"

MATCHED = "matched"
PIXELS = "pixel mismatch"
SIZE = "size mismatch"
MISSING = "reference missing"
TIMEOUT = "timeout"
OTHER = "other error"
MISMATCHES = (PIXELS, SIZE)

FAILED_STATUSES = ("failed", "timedOut", "interrupted")

# How one comparison fared across the attempts of its test.
FIRST_TRY = "matched on the first attempt"
FLAKY = "mismatched, then matched on the retry"
HARD = "mismatched on every attempt"
NOT_REACHED = "mismatched, then not reached on the retry"
RETRY_ONLY_MATCH = "first reached on the retry, matched"
RETRY_ONLY_MISMATCH = "first reached on the retry, mismatched"
SPLIT_ORDER = [FIRST_TRY, FLAKY, HARD, NOT_REACHED, RETRY_ONLY_MATCH, RETRY_ONLY_MISMATCH]
# U+203A, the separator Playwright uses between a describe block and a test.
SEPARATOR = " \u203a "


@dataclass
class Comparison:
    label: str
    shard: str
    test_id: str
    file: str
    title: str
    retry: int
    location: str
    occurrence: int
    source: str
    kind: str
    snapshot: str = ""
    reference: str = ""
    diff_pixels: int | None = None
    ratio: float | None = None
    size: str = ""
    error: str = ""

    @property
    def key(self) -> tuple[str, str, str, int]:
        return (self.file, self.title, self.location, self.occurrence)


@dataclass
class TestOutcome:
    label: str
    shard: str
    test_id: str
    file: str
    title: str
    outcome: str
    attempts: list[dict] = field(default_factory=list)


def first_line(text: str) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def classify(record: dict, attempt_attachments: list[dict]) -> tuple[str, dict]:  # noqa: C901
    """Say what one comparison found, and by how much when it differs."""
    if record.get("passed"):
        return MATCHED, {}
    message = record.get("error") or ""
    details: dict = {}
    snapshot = SNAPSHOT_RE.search(message)
    if snapshot:
        details["snapshot"] = snapshot.group(1)

    attachments = list(record.get("attachments") or [])
    if not attachments and snapshot:
        stem = Path(snapshot.group(1)).stem
        attachments = [
            item for item in attempt_attachments if (item.get("name") or "").startswith(stem + "-")
        ]
    for item in attachments:
        if (item.get("name") or "").endswith("-expected.png") and item.get("path"):
            details["reference"] = Path(item["path"]).name
            break

    pixels = PIXELS_RE.search(message)
    if pixels:
        details["diff_pixels"] = int(pixels.group(1))
        details["ratio"] = float(pixels.group(2))
    size = SIZE_RE.search(message)
    if size:
        details["size"] = (
            f"reference {size.group(1)}x{size.group(2)}, got {size.group(3)}x{size.group(4)}"
        )
        return SIZE, details
    if pixels:
        return PIXELS, details
    if MISSING_TEXT in message:
        return MISSING, details
    if "Timeout" in message or "timed out" in message:
        return TIMEOUT, details
    return OTHER, details


def load(directory: Path) -> tuple[list[Comparison], list[TestOutcome]]:
    comparisons: list[Comparison] = []
    outcomes: list[TestOutcome] = []
    for path in sorted(directory.rglob("snapshot-comparisons.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        label = data.get("label") or path.parent.name
        shard = str(data.get("shard") or "")

        attempts_by_test: dict[str, list[dict]] = defaultdict(list)
        for attempt in data.get("attempts", []):
            attempts_by_test[attempt["testId"]].append(attempt)

        seen: Counter = Counter()
        for record in data.get("comparisons", []):
            attempt_key = (record["testId"], record["retry"])
            seen[(*attempt_key, record.get("location", ""))] += 1
            occurrence = seen[(*attempt_key, record.get("location", ""))]
            attempt_attachments = next(
                (
                    attempt.get("attachments", [])
                    for attempt in attempts_by_test.get(record["testId"], [])
                    if attempt["retry"] == record["retry"]
                ),
                [],
            )
            kind, details = classify(record, attempt_attachments)
            if "snapshot" not in details:
                name = SOURCE_NAME_RE.search(record.get("source") or "")
                if name:
                    details["snapshot"] = name.group(1)
            comparisons.append(
                Comparison(
                    label=label,
                    shard=shard,
                    test_id=record["testId"],
                    file=record.get("file", ""),
                    title=record.get("title", ""),
                    retry=int(record.get("retry", 0)),
                    location=record.get("location", ""),
                    occurrence=occurrence,
                    source=record.get("source", ""),
                    kind=kind,
                    error=first_line(record.get("error") or ""),
                    **details,
                )
            )

        for test_id, attempts in attempts_by_test.items():
            attempts.sort(key=lambda attempt: attempt["retry"])
            final = attempts[-1]
            if final["status"] == "skipped":
                outcome = "skipped"
            elif final["status"] in FAILED_STATUSES:
                outcome = "failed"
            elif len(attempts) > 1:
                outcome = "flaky"
            else:
                outcome = "passed"
            outcomes.append(
                TestOutcome(
                    label=label,
                    shard=shard,
                    test_id=test_id,
                    file=final.get("file", ""),
                    title=final.get("title", ""),
                    outcome=outcome,
                    attempts=attempts,
                )
            )
    return comparisons, outcomes


def final_retry_by_test(outcomes: list[TestOutcome]) -> dict[tuple[str, str], int]:
    return {(outcome.label, outcome.test_id): outcome.attempts[-1]["retry"] for outcome in outcomes}


def split_attempts(  # noqa: C901, PLR0912
    comparisons: list[Comparison], outcomes: list[TestOutcome]
) -> dict:
    """Follow each comparison through the attempts of its test.

    A comparison is identified by its test, its line and its occurrence on
    that line, so the same screenshot in the first attempt and in the retry
    counts as one comparison.
    """
    attempts_of = {
        (outcome.label, outcome.test_id): [attempt["retry"] for attempt in outcome.attempts]
        for outcome in outcomes
    }
    by_key: dict[tuple, dict[int, Comparison]] = defaultdict(dict)
    for comparison in comparisons:
        key = (comparison.label, comparison.test_id, comparison.location, comparison.occurrence)
        by_key[key][comparison.retry] = comparison

    counts: dict[str, Counter] = defaultdict(Counter)
    hard = []
    # Comparisons that did not match on the first attempt somewhere, with what
    # happened to them on every platform, to line the platforms up.
    notable: dict[str, dict] = {}
    categories: dict[tuple, str] = {}
    for key, per_retry in by_key.items():
        label, test_id = key[0], key[1]
        retries = attempts_of.get((label, test_id)) or sorted(per_retry)
        first = per_retry.get(retries[0])
        later = [per_retry.get(retry) for retry in retries[1:]]
        reached = [comparison for comparison in later if comparison is not None]
        if first is not None and first.kind == MATCHED:
            category = FIRST_TRY
        elif first is not None:
            if reached and reached[-1].kind == MATCHED:
                category = FLAKY
            elif len(reached) == len(later):
                category = HARD
            else:
                category = NOT_REACHED
        elif reached and reached[-1].kind == MATCHED:
            category = RETRY_ONLY_MATCH
        else:
            category = RETRY_ONLY_MISMATCH
        counts[label][category] += 1
        runs = [comparison for comparison in [first, *reached] if comparison is not None]
        last = runs[-1]
        shared = SEPARATOR.join([last.file, last.title, last.location, str(last.occurrence)])
        categories[(label, shared)] = category
        if category != FIRST_TRY:
            entry = notable.setdefault(
                shared,
                {
                    "test": last.file + SEPARATOR + last.title,
                    "reference": "",
                    "platforms": {},
                },
            )
            for comparison in runs:
                entry["reference"] = (
                    entry["reference"] or comparison.reference or comparison.snapshot
                )
            entry["platforms"][label] = {
                "category": category,
                "diff_pixels": [comparison.diff_pixels for comparison in runs],
                "kinds": [comparison.kind for comparison in runs],
            }
        if category == HARD:
            runs = [first, *reached]
            diffs = [(comparison.diff_pixels, comparison.size) for comparison in runs]
            last = runs[-1]
            hard.append(
                {
                    "label": label,
                    "test": last.file + SEPARATOR + last.title,
                    "reference": last.reference or last.snapshot,
                    "kind": last.kind,
                    "diff_pixels": [comparison.diff_pixels for comparison in runs],
                    "same_diff": len(set(diffs)) == 1,
                }
            )
    # Fill in the platforms where the same comparison matched first time.
    for shared, entry in notable.items():
        for (label, key), category in categories.items():
            if key == shared and label not in entry["platforms"]:
                entry["platforms"][label] = {"category": category}
    return {
        "counts": {label: dict(counter) for label, counter in counts.items()},
        "hard": hard,
        "notable": notable,
    }


def summarise(  # noqa: C901
    comparisons: list[Comparison], outcomes: list[TestOutcome], control: str | None
) -> dict:
    final_retry = final_retry_by_test(outcomes)
    labels = sorted(
        {outcome.label for outcome in outcomes}, key=lambda label: (label == control, label)
    )

    final = [
        comparison
        for comparison in comparisons
        if final_retry.get((comparison.label, comparison.test_id)) == comparison.retry
    ]
    final_ids = {id(comparison) for comparison in final}
    earlier = [comparison for comparison in comparisons if id(comparison) not in final_ids]

    by_label_key: dict[str, dict[tuple, Comparison]] = defaultdict(dict)
    for comparison in final:
        by_label_key[comparison.label][comparison.key] = comparison

    failed_final_tests = {
        (comparison.label, comparison.test_id) for comparison in final if comparison.kind != MATCHED
    }

    platforms = []
    for label in labels:
        tests = [outcome for outcome in outcomes if outcome.label == label]
        outcome_counts = Counter(outcome.outcome for outcome in tests)
        runs = [comparison for comparison in final if comparison.label == label]
        kinds = Counter(comparison.kind for comparison in runs)
        all_runs = [comparison for comparison in comparisons if comparison.label == label]
        all_kinds = Counter(comparison.kind for comparison in all_runs)
        other_failures = [
            outcome
            for outcome in tests
            if outcome.outcome == "failed" and (label, outcome.test_id) not in failed_final_tests
        ]
        platforms.append(
            {
                "label": label,
                "shards": sorted({outcome.shard for outcome in tests}),
                "tests": len(tests),
                "passed": outcome_counts["passed"],
                "flaky": outcome_counts["flaky"],
                "failed": outcome_counts["failed"],
                "skipped": outcome_counts["skipped"],
                "comparisons": len(runs),
                "matched": kinds[MATCHED],
                "mismatched": sum(kinds[kind] for kind in MISMATCHES),
                "pixel_mismatches": kinds[PIXELS],
                "size_mismatches": kinds[SIZE],
                "missing_references": kinds[MISSING],
                "screenshot_timeouts": kinds[TIMEOUT],
                "other_screenshot_errors": kinds[OTHER],
                "comparisons_all_attempts": len(all_runs),
                "matched_all_attempts": all_kinds[MATCHED],
                "mismatched_all_attempts": sum(all_kinds[kind] for kind in MISMATCHES),
                "other_failures": [
                    {
                        "test": outcome.file + SEPARATOR + outcome.title,
                        "error": first_line((outcome.attempts[-1].get("errors") or [""])[0]),
                    }
                    for outcome in other_failures
                ],
            }
        )

    def result_on(label: str, key: tuple) -> str:
        comparison = by_label_key[label].get(key)
        if comparison is None:
            return "not run"
        if comparison.kind == MATCHED:
            return "matched"
        if comparison.diff_pixels is not None:
            return f"{comparison.kind}, {comparison.diff_pixels} px"
        return comparison.kind

    order = {label: index for index, label in enumerate(labels)}
    non_matching = [comparison for comparison in final if comparison.kind != MATCHED]
    non_matching.sort(
        key=lambda comparison: (order[comparison.label], comparison.file, comparison.title)
    )
    mismatches = []
    for comparison in non_matching:
        row = asdict(comparison)
        row["others"] = {
            label: result_on(label, comparison.key) for label in labels if label != comparison.label
        }
        mismatches.append(row)

    # Only tests that passed on a retry: a test that failed every attempt is
    # already listed with its last attempt.
    flaky_tests = {
        (outcome.label, outcome.test_id) for outcome in outcomes if outcome.outcome == "flaky"
    }
    retried = [
        comparison
        for comparison in earlier
        if comparison.kind != MATCHED and (comparison.label, comparison.test_id) in flaky_tests
    ]
    retried.sort(
        key=lambda comparison: (order[comparison.label], comparison.file, comparison.title)
    )

    flaky_other = []
    for outcome in outcomes:
        if outcome.outcome != "flaky":
            continue
        for attempt in outcome.attempts[:-1]:
            screenshot_failed = any(
                comparison.label == outcome.label
                and comparison.test_id == outcome.test_id
                and comparison.retry == attempt["retry"]
                and comparison.kind != MATCHED
                for comparison in comparisons
            )
            if not screenshot_failed:
                flaky_other.append(
                    {
                        "label": outcome.label,
                        "test": outcome.file + SEPARATOR + outcome.title,
                        "error": first_line((attempt.get("errors") or [""])[0]),
                    }
                )

    split = split_attempts(comparisons, outcomes)
    split["hard"].sort(key=lambda row: (order[row["label"]], row["test"]))

    return {
        "labels": labels,
        "split": split,
        "platforms": platforms,
        "mismatches": mismatches,
        "earlier_attempt_mismatches": [asdict(comparison) for comparison in retried],
        "flaky_other": flaky_other,
    }


def render(summary: dict) -> str:  # noqa: C901, PLR0912
    lines = ["## Screenshot comparisons against the committed Linux references", ""]
    lines += [
        "Counts use the last attempt of each test. A test stops at its first failing "
        "screenshot unless the assertion is soft, so later screenshots in that test do not run.",
        "",
        "| Platform | Tests | Passed | Flaky | Failed | Skipped | Comparisons | Matched | Mismatched | Other screenshot errors | Other failed tests |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for platform in summary["platforms"]:
        other_screenshot = (
            platform["missing_references"]
            + platform["screenshot_timeouts"]
            + platform["other_screenshot_errors"]
        )
        lines.append(
            f"| {platform['label']} | {platform['tests']} | {platform['passed']} | "
            f"{platform['flaky']} | {platform['failed']} | {platform['skipped']} | "
            f"{platform['comparisons']} | {platform['matched']} | {platform['mismatched']} | "
            f"{other_screenshot} | {len(platform['other_failures'])} |"
        )
    lines.append("")

    split = summary["split"]
    used = [
        category
        for category in SPLIT_ORDER
        if any(split["counts"].get(label, {}).get(category) for label in summary["labels"])
    ]
    lines += ["### Comparisons across attempts", ""]
    lines += [
        "Each comparison is followed from the first attempt of its test to the retry.",
        "",
        "| Platform | Comparisons | " + " | ".join(used) + " |",
        "| --- | ---: | " + " | ".join("---:" for _ in used) + " |",
    ]
    for label in summary["labels"]:
        counts = split["counts"].get(label, {})
        cells = " | ".join(str(counts.get(category, 0)) for category in used)
        lines.append(f"| {label} | {sum(counts.values())} | {cells} |")
    lines.append("")
    if split["hard"]:
        lines += ["### Comparisons that mismatched on every attempt", ""]
        lines += [
            "| Platform | Test | Reference | Result | Differing pixels per attempt | Same diff |",
            "| --- | --- | --- | --- | --- | --- |",
        ]
        for row in split["hard"]:
            pixels = " / ".join(
                "" if value is None else f"{value:,}" for value in row["diff_pixels"]
            )
            same = "yes" if row["same_diff"] else "no"
            lines.append(
                f"| {row['label']} | {row['test']} | {row['reference']} | {row['kind']} | "
                f"{pixels} | {same} |"
            )
        lines.append("")

    if summary["mismatches"]:
        lines += ["### Comparisons that did not match in the last attempt", ""]
        lines += [
            "| Platform | Test | Reference | Result | Differing pixels | Ratio | Elsewhere |",
            "| --- | --- | --- | --- | ---: | ---: | --- |",
        ]
        for row in summary["mismatches"]:
            pixels = "" if row["diff_pixels"] is None else f"{row['diff_pixels']:,}"
            ratio = "" if row["ratio"] is None else f"{row['ratio']:.4f}"
            elsewhere = "; ".join(f"{label}: {result}" for label, result in row["others"].items())
            reference = row["reference"] or row["snapshot"]
            result = row["kind"] + (f" ({row['size']})" if row["size"] else "")
            if row["kind"] not in MISMATCHES:
                result += f": {row['error'][:120]}"
            lines.append(
                f"| {row['label']} | {row['file']}{SEPARATOR}{row['title']} | {reference} | {result} | "
                f"{pixels} | {ratio} | {elsewhere} |"
            )
        lines.append("")

    if summary["earlier_attempt_mismatches"]:
        lines += ["### Comparisons that failed before the test passed on a retry", ""]
        lines += [
            "| Platform | Test | Reference | Result | Differing pixels |",
            "| --- | --- | --- | --- | ---: |",
        ]
        for row in summary["earlier_attempt_mismatches"]:
            pixels = "" if row["diff_pixels"] is None else f"{row['diff_pixels']:,}"
            reference = row["reference"] or row["snapshot"]
            lines.append(
                f"| {row['label']} | {row['file']}{SEPARATOR}{row['title']} | {reference} | "
                f"{row['kind']} | {pixels} |"
            )
        lines.append("")

    others = [
        (platform["label"], failure)
        for platform in summary["platforms"]
        for failure in platform["other_failures"]
    ]
    if others:
        lines += ["### Tests that failed for another reason", ""]
        lines += ["| Platform | Test | First error line |", "| --- | --- | --- |"]
        for label, failure in others:
            lines.append(f"| {label} | {failure['test']} | {failure['error'][:160]} |")
        lines.append("")

    if summary["flaky_other"]:
        lines += ["### Retried tests whose first attempt failed for another reason", ""]
        lines += ["| Platform | Test | First error line |", "| --- | --- | --- |"]
        for row in summary["flaky_other"]:
            lines.append(f"| {row['label']} | {row['test']} | {row['error'][:160]} |")
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path, help="Directory with the downloaded artifacts")
    parser.add_argument("--control", default=None, help="Label of the control platform")
    parser.add_argument("--markdown", type=Path, default=None, help="Write the table here too")
    parser.add_argument("--json", type=Path, default=None, help="Write the counts as JSON here")
    args = parser.parse_args()

    comparisons, outcomes = load(args.directory)
    if not outcomes:
        sys.stderr.write(f"No snapshot-comparisons.json under {args.directory}\n")
        return 1
    summary = summarise(comparisons, outcomes, args.control)
    text = render(summary)
    sys.stdout.write(text + "\n")
    if args.markdown:
        args.markdown.write_text(text + "\n", encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps(summary, indent=1), encoding="utf-8")
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
