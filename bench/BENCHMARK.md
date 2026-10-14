# Benchmark: Opus alone vs Opus + Jev

The question: on the same tasks, does Claude Code with jev-pilot cost less and finish faster than Claude Code alone, without doing worse work?

## Setup

- **Two arms, same everything else.** `opus` is Claude Code alone. `jev` is Claude Code started with `--plugin-dir jev-pilot`. Both use `--model claude-opus-5-5 --effort high`, the same allowed tools and the same prompts.
- **A fresh copy for every run.** Each run copies `todo-app/` into `bench/results/<suite>-<arm>-<rep>/app`, commits it as a git baseline, then adds one small uncommitted change so "what changed?" has an answer.
- **One session per suite.** The first prompt starts a session and the rest are sent with `--resume`, the way a person keeps typing in one session.
- **One run at a time.** Runs go one after another because Jev's log is matched to each run by time. `run-all.sh` alternates which arm goes first in each round, so a slow API hour doesn't hit only one arm.
- **Mode.** jev-pilot must be in `active` mode, set with `/jev active` in Claude Code. `run.sh` checks the mode and stops if it isn't active.

## Suites (`bench/prompts/`)

| Suite | Prompts | What it tests | Expected |
|---|---|---|---|
| `routine` | run the tests · what changed? · what does todo.js export? · show me the last few commits | Whole-turn bypass: Jev runs one action and Haiku reports it | Large saving on the prompts Jev answers. "what changed?" stays with Claude (0.80 bar) |
| `followup` | a question · a follow-up question · "ok do it" · "yes run the tests" | Effort routing with context on short follow-ups | Effort lowered on the questions, kept on "ok do it" |
| `small-edit` | rename a button · "thanks" | Effort lowered on an easy edit | Small saving |
| `feature` | multi-step feature with tests | Real coding work | About the same; Claude's own variation dominates |

You can add a suite by adding `bench/prompts/<name>.txt`, with prompts separated by a line containing only `---`.

## Run it

From `/Users/nimf/Work/jev-demo`, with `/jev active` set in Claude Code:

```sh
bench/run-all.sh                            # quick: routine + followup, 2 rounds (~10 min, ~$1-2)
SUITES="routine" REPS=1 bench/run-all.sh    # smallest check (~1 min, ~$0.15)
FULL=1 bench/run-all.sh                     # every suite, 3 rounds (~30 min, ~$6)
python3 bench/summary.py                    # results, at any time
```

**What keeps it cheap**
- **The opus baseline is reused.** Claude Code alone doesn't use the mod, so its runs are kept in `bench/baseline/<model>-<effort>/` and only run again when that suite's prompts change, or with `FRESH_BASELINE=1`. After a change to the mod, only the jev arm runs.
- **The default is the two suites where Jev makes a difference.** `small-edit` showed no change, and `feature` is the most expensive and shows Claude's own variation. Both run with `FULL=1`.
- **When a baseline is missing, it runs side by side with the jev arm.** The baseline doesn't touch Jev's log, so this halves the time. Wall times in those rounds can be a little noisier.
- **Each prompt is capped at $1** (`BUDGET`).

Finished jev runs are skipped, so an interrupted benchmark can just be started again. Delete `bench/results/` to measure a new version of the mod from scratch.

Settings, as environment variables:
- `MODEL`, `EFFORT`: the baseline is kept per pair
- `SUITES`, `REPS`, `BUDGET`
- `JEV_USD_PER_CALL`: your TypeSafe price per request, to add Jev's own cost

## What gets measured

| Metric | Source | Note |
|---|---|---|
| Cost | `total_cost_usd` of the session's last prompt | Cumulative across `--resume`, so the last value is the session total. Per-prompt cost is the difference |
| + Haiku cost | jev-pilot log, `bypass` entries | Not in Claude Code's total. Priced at $0.10 / $0.50 per million tokens |
| + Jev cost | Count of Jev requests × `JEV_USD_PER_CALL` | Not priced unless you set the variable |
| API time | `duration_api_ms` of the last prompt | Cumulative, like cost |
| Wall time | Measured by `run.sh` around each prompt | Includes Jev's latency (about 250 ms per request) |
| Quality | `npm test` after the session, plus `changes.diff` | Compare the diffs of both arms by eye for `feature` and `small-edit` |
| What Jev did | jev-pilot log between the run's start and end | Turns answered without Claude, turns with effort lowered, Jev requests |

## Reading the result

- **Treat any difference smaller than the ± spread as noise.** Two rounds are enough to spot a large change. Before a claim you'll repeat, such as in the video, run `FULL=1` or `REPS=5`.
- **A saving only counts if quality held.** Tests must pass in both arms, and the diffs should do the same thing. `summary.py` lists any run where a prompt errored or the tests fail.
- **Check the per-prompt table to see where a saving came from.** A bypassed prompt shows about $0.000 for Claude.
- **Session size matters.** The first prompt of a session pays for writing the cache (about $0.14), so short suites look worse in percentage terms than a long real session. Your own long sessions are the best test of effort routing: run `/jev report` after a day of normal use.

## Limits

- **Headless runs differ a little from interactive use.** There are no permission prompts, and `--effort` is fixed at the start.
- **The jev arm's log is shared with any other Claude Code session using jev-pilot at the same time.** Don't work with the mod in another window while the benchmark runs, or the Jev counts mix.
- **Prices move.** The cost Claude Code reports uses its own price table.
