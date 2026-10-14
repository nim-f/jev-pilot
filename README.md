# jev-demo

This is the repository for the YouTube video **[watch it here](https://youtu.be/exN7r2UJ57A)**.

It holds **jev-pilot**, a Claude Code plugin that lets TypeSafe's Jev model handle the routine parts of a Claude Code session, plus the small todo app and the benchmark used in the video.

## What jev-pilot does

- **Takes simple steps itself.** When a prompt only needs one read-only action (run the tests, `git status`, read a file), Jev runs it and a small model reports the result, so the main Claude model is skipped.
- **Routes effort.** Each turn gets a difficulty score: easy turns run at lower effort, big jobs at high. Effort is only changed on models where that keeps the prompt cache.
- **Gates risky calls.** It asks before, or denies, Bash commands and edits that look dangerous or out of scope.
- **Checks the work is done.** When a reply looks unfinished, Claude is sent back once.
- **Adds hints.** It suggests a skill when one fits, picks subagent types, and tells compaction which tool results to keep.

Everything it decides is logged, and `/jev report` compares Jev's choices with Claude's.

## Install

You need a TypeSafe API key in `TYPESAFE_API_KEY`.

At the prompt of a Claude Code terminal session:

```
/plugin install jev-pilot --marketplace nim-f/jev-pilot
```

Answer `y` to add the marketplace, then pick a scope. From a shell, the same is:

```sh
claude plugin install jev-pilot --marketplace nim-f/jev-pilot
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `nim-f/jev-pilot`, then Add plugin.

Or, from a clone, to try it for one session without installing:

```sh
claude --plugin-dir ./jev-pilot
```

## Use

| Command | What it does |
|---|---|
| `/jev` | Status |
| `/jev report` | Agreement with Claude, steps taken, routing, gate and done-check stats |
| `/jev active` · `/jev shadow` · `/jev off` | Apply decisions, only log them, or turn the plugin off |
| `/jev export` · `/jev clear` | Export or clear the decision log |

Every setting (thresholds, routing, gate, done check…) is under `/plugin configure jev-pilot`.

## What's in the repo

| Path | What it is |
|---|---|
| `jev-pilot/` | The plugin: hooks in `hooks/`, tests in `tests/` (`claude plugin test jev-pilot`) |
| `todo-app/` | The small app the demos and benchmark work on |
| `bench/` | Opus alone vs Opus + Jev on the same prompts. See [`bench/BENCHMARK.md`](bench/BENCHMARK.md) |
| `JEV_PLAN.md` | The design plan |
