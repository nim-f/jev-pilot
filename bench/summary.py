#!/usr/bin/env python3
"""Compares the opus and jev arms of bench/results/.

    python3 bench/summary.py            # Markdown tables to stdout
    JEV_USD_PER_CALL=0.0002 python3 bench/summary.py   # add Jev's own cost

Claude Code's cost and API time are cumulative within a resumed session, so a
run's totals are the last prompt's values. Claude Code's cost does not include
the Haiku summaries jev-pilot makes or the Jev (TypeSafe) requests; both are
read from the jev-pilot log between the run's start and end and added here.
"""
import json
import os
import pathlib
import statistics
import sys

BENCH = pathlib.Path(__file__).resolve().parent
RESULTS = BENCH / "results"
# The opus arm: kept per model and effort, reused across jev runs (see run.sh).
BASELINE = BENCH / "baseline" / f'{os.environ.get("MODEL", "claude-opus-5-5")}-{os.environ.get("EFFORT", "high")}'
STORE = pathlib.Path.home() / ".claude/plugins/store/jev-pilot_inline-3abb531a691c.json"
HAIKU_IN, HAIKU_OUT = 0.10 / 1e6, 0.50 / 1e6  # Claude Haiku 5.5, prompts up to 100K tokens
JEV_USD_PER_CALL = float(os.environ.get("JEV_USD_PER_CALL", "0"))


def load_log():
    try:
        return json.loads(STORE.read_text()).get("log", [])
    except (OSError, ValueError):
        return []


def run_stats(run: pathlib.Path, log):
    results = sorted(run.glob("result-*.json"), key=lambda p: int(p.stem.split("-")[1]))
    if not results or not (run / "end-ms").exists():
        return None
    data = []
    for p in results:
        try:
            data.append(json.loads(p.read_text()))
        except ValueError:
            data.append({})
    last = data[-1]
    prompts = []
    prev_cost = 0.0
    for i, d in enumerate(data, 1):
        cost = d.get("total_cost_usd", prev_cost)
        wall = float((run / f"wall-{i}.txt").read_text()) if (run / f"wall-{i}.txt").exists() else 0.0
        prompts.append({"cost": cost - prev_cost, "wall": wall, "turns": d.get("num_turns", 0), "error": d.get("is_error", True)})
        prev_cost = cost

    start, end = int((run / "start-ms").read_text()), int((run / "end-ms").read_text())
    entries = [e for e in log if start <= e.get("at", 0) <= end]
    # Logged decisions that made a Jev request; step-0 take and route share one.
    jev_calls = sum(
        1
        for e in entries
        if (isinstance(e.get("ms"), (int, float)) and e.get("kind") != "take")
        or (e.get("kind") == "compare" and (e.get("data") or {}).get("measured"))
    )
    haiku = 0.0
    for e in entries:
        u = (e.get("data") or {}).get("usage") if e.get("kind") == "bypass" else None
        if u:
            haiku += u.get("input_tokens", 0) * HAIKU_IN + u.get("output_tokens", 0) * HAIKU_OUT
    extra = haiku + jev_calls * JEV_USD_PER_CALL
    return {
        "claude_cost": last.get("total_cost_usd", 0.0),
        "extra_cost": extra,
        "cost": last.get("total_cost_usd", 0.0) + extra,
        "api_s": last.get("duration_api_ms", 0) / 1000,
        "wall_s": sum(p["wall"] for p in prompts),
        "turns": sum(p["turns"] for p in prompts),
        "tests": (run / "tests-status").read_text().strip() if (run / "tests-status").exists() else "?",
        "errors": sum(1 for p in prompts if p["error"]),
        "prompts": prompts,
        "bypassed": sum(1 for e in entries if e.get("kind") == "bypass" and e.get("applied")),
        "lowered": sum(1 for e in entries if e.get("kind") == "route" and e.get("applied")),
        "jev_calls": jev_calls,
    }


def ms(values, fmt):
    if not values:
        return "—"
    if len(values) == 1:
        return fmt(values[0])
    return f"{fmt(statistics.mean(values))} ± {fmt(statistics.stdev(values))}"


def change(a, b):
    return f"{(b - a) / a * 100:+.0f}%" if a and b is not None else "—"


def main():
    if not RESULTS.exists():
        sys.exit("No results yet. Run bench/run.sh first.")
    log = load_log()
    runs = {}
    folders = [*sorted(RESULTS.iterdir()), *(sorted(BASELINE.iterdir()) if BASELINE.exists() else [])]
    for run in folders:
        parts = run.name.rsplit("-", 2)
        if not run.is_dir() or len(parts) != 3:
            continue  # summary.md and anything else that isn't a run folder
        suite, arm, rep = parts
        if (arm == "opus") != (run.parent == BASELINE):
            continue  # opus runs count only from the baseline, jev runs only from results
        s = run_stats(run, log)
        if s:
            runs.setdefault(suite, {}).setdefault(arm, []).append((rep, s))

    usd = lambda v: f"${v:.3f}"
    sec = lambda v: f"{v:.1f}s"
    out = ["## Opus alone vs Opus + Jev", "", f"_Baseline: {BASELINE.relative_to(BENCH)}_", ""]
    out.append("| Suite | Runs (opus/jev) | Cost opus | Cost jev | Δ cost | API time opus | API time jev | Δ API | Wall opus | Wall jev | Tests pass (opus/jev) |")
    out.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for suite, arms in runs.items():
        o, j = [s for _, s in arms.get("opus", [])], [s for _, s in arms.get("jev", [])]
        col = lambda rs, k: [r[k] for r in rs]
        mean = lambda rs, k: statistics.mean(col(rs, k)) if rs else None
        passed = lambda rs: f"{sum(r['tests'] == 'pass' for r in rs)}/{len(rs)}"
        out.append(
            f"| {suite} | {len(o)}/{len(j)} | {ms(col(o, 'cost'), usd)} | {ms(col(j, 'cost'), usd)} | {change(mean(o, 'cost'), mean(j, 'cost'))} "
            f"| {ms(col(o, 'api_s'), sec)} | {ms(col(j, 'api_s'), sec)} | {change(mean(o, 'api_s'), mean(j, 'api_s'))} "
            f"| {ms(col(o, 'wall_s'), sec)} | {ms(col(j, 'wall_s'), sec)} | {passed(o)} / {passed(j)} |"
        )

    out += ["", "### What Jev did (jev arm)", "", "| Suite | Turns answered without Claude | Turns with effort changed | Jev requests | Haiku + Jev cost |", "|---|---|---|---|---|"]
    for suite, arms in runs.items():
        j = [s for _, s in arms.get("jev", [])]
        if j:
            out.append(f"| {suite} | {sum(r['bypassed'] for r in j)} | {sum(r['lowered'] for r in j)} | {sum(r['jev_calls'] for r in j)} | {usd(sum(r['extra_cost'] for r in j))} |")

    out += ["", "### Per prompt (mean cost)", ""]
    for suite, arms in runs.items():
        texts = (BENCH / "prompts" / f"{suite}.txt").read_text().split("\n---\n")
        out += [f"**{suite}**", "", "| # | Prompt | opus | jev |", "|---|---|---|---|"]
        for i, text in enumerate(texts):
            cell = lambda arm: ms([s["prompts"][i]["cost"] for _, s in arms.get(arm, []) if i < len(s["prompts"])], usd)
            first = text.strip().splitlines()[0][:50]
            out.append(f"| {i + 1} | {first} | {cell('opus')} | {cell('jev')} |")
        out.append("")

    flagged = [f"{suite}-{arm}-{rep}" for suite, arms in runs.items() for arm, rs in arms.items() for rep, s in rs if s["errors"] or s["tests"] != "pass"]
    if flagged:
        out += ["**Check these runs** (a prompt errored or the tests fail at the end): " + ", ".join(flagged), ""]
    if not JEV_USD_PER_CALL:
        out.append("_Jev's own requests are counted but not priced. Set JEV_USD_PER_CALL to include them._")
    print("\n".join(out))


if __name__ == "__main__":
    main()
