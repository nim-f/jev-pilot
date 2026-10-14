# Jev pilot: build plan

A Claude Code mod that hands Jev (TypeSafe's System One model) every decision in Claude Code it can make well, and leaves Claude the rest.

- **Jev answers:** which of a known set of actions to take, yes/no, how risky, how hard.
- **Claude still does:** writing code, writing new commands, planning, and replying to the user.

Every Jev decision falls back to the normal Claude Code behaviour when Jev is unsure, slow, or unreachable.

Mod source: `~/.claude/dev-mods/<session>/jev-pilot/` (loaded by hot reload in the session that built it). Run it in another session with `claude --plugin-dir <that folder>`.

## Where it plugs in

| Mod event | Decision | What it changes |
|---|---|---|
| `turn.step` (a stream hook) | Can Jev take this step itself? How hard is this turn? | Answers with a tool call without asking Claude, or changes `model` / `effort` before the request is sent |
| `tool.check` | Is this call risky or outside what was asked? | Makes the permission stricter (`allow` → `ask` or `deny`) |
| `classic.Stop` | Is the request actually finished? | Tells Claude to keep going once, with a reason |
| `prompt.submit` | Which workflow or skill does the prompt need? | Adds context, or answers the prompt without Claude (phase 3) |

Every phase keeps these rules:
- **One Jev request per step.** Every question for that step goes in one request.
- **Fail open.** Errors, timeouts and low confidence fall back to the normal behaviour.
- **Never run the same action twice in a row.**
- **A per-turn cap** on how many steps Jev takes.
- **Modes:** `active` applies decisions; `shadow` only records them; `off` disables the mod.

---

## Phase 1: first version (built)

**Foundation**
- A Jev client: `POST https://api.typesafe.ai/v1/systemone` with `jev-latest`.
  - The key comes from `TYPESAFE_API_KEY` (settings `env`).
  - A 4s timeout. Errors, timeouts and HTTP errors all count as "no answer".
- Context building: the user's request, the last N steps (text, tool calls and results, trimmed) and the working directory.
- Decision log and stats:
  - the status line (`jev: …`);
  - a `/jev` command showing the mode, counters and the last decisions;
  - `/jev active|shadow|off` to switch modes.
- Settings (`userConfig`):
  - `mode`;
  - `routing` (`off` / `effort` / `model`);
  - `takeSteps`, `gate` and `doneCheck` toggles;
  - thresholds.

**1. Jev takes the step itself** (`turn.step`)
- Candidate actions are built in code each step:
  - `Read <file>` for existing files mentioned in the request or recent output, if not already read this turn;
  - `Bash`: `git status`, `git diff`, `git log`, and safe `package.json` scripts (`test`, `lint`, `build`, `typecheck`, `check`, `test:*`) using the right package manager.
- One Choice question over the candidates plus `claude` ("anything else"). Jev's call is used only when the chosen option's probability is at least `takeThreshold` (0.85).
- The result is a real tool call. It still goes through the permission checks and hooks.
- Main loop only. At most 3 Jev steps per turn. Never the same action twice in a row.

**2. Effort or model routing** (`turn.step`, once per turn, at step 0)
- One Score question: how hard is the request, on four levels from trivial to hard.
- `effort` mode (default):
  - trivial → `low`;
  - routine → `medium`;
  - otherwise the session's effort is left as is.
- `model` mode also moves trivial turns to Haiku and routine turns to Sonnet.
- It only lowers effort or switches to a cheaper model, never raises them. It is decided once per turn, so the prompt cache is invalidated at most once per turn.

**3. Risk and scope gate** (`tool.check`, for Bash, Edit, Write and NotebookEdit)
- It runs only when Claude Code would already allow the call, so it can only make the decision stricter.
- Bash:
  - a three-level risk Score plus an in-scope yes/no question;
  - high risk that the user asked for → `ask`;
  - high risk that the user didn't ask for → `deny`, with the reason.
- File edits: an in-scope yes/no question; clearly out of scope → `ask`.

**4. Done check** (`classic.Stop`, main loop)
- A yes/no question: "Did the assistant fully finish what was asked?" (a needed question to the user or a real blocker counts as finished).
- A clear no (`< 0.15`) tells Claude to continue once.

**Exit criteria**
- [x] Unit tests pass (`claude plugin test`, 8 tests), with the Jev API mocked.
- [x] `claude plugin validate` passes and `tsc` is clean.
- [x] Live API check (2026-10-14): the mod's real questions on 8 sample cases all produced the intended action (take Read and `npm test`, hand off to Claude after a read and for hard tasks, deny `rm -rf ~/`, ask on `git push --force`, allow `git status` and `npm install`). About 300–400ms per call.
- [ ] One real session in `shadow` mode with sensible logged decisions.

## Phase 2: calibrate and widen what Jev can pick

- **Calibration log:** each decision is written as one line to `.jev/decisions.jsonl` with Jev's answer, what Claude did instead (in shadow mode), and the outcome (tool error or not, whether the user interrupted).
  - Add a `/jev report` that shows agreement rate, money saved, and false denies or asks.
- **Tune the thresholds** per decision type from that log, not from guesses.
- **More candidate actions:**
  - `Skill`: pick from the installed skills list (a Choice with up to 255 options);
  - `ToolSearch select:`: pick deferred tools by name;
  - `Glob` / `Grep`: exact strings quoted in the request;
  - Makefile targets, `cargo test`, `pytest`, `go test`, detected from the project files;
  - `TaskStop`, `CronList` and other tools whose arguments come from a fixed set;
  - MCP tools whose arguments are fixed choices (read from their input schemas).
- **Gate allow side:** after calibration, let Jev auto-allow read-only Bash that Claude Code would `ask` about, which reduces permission prompts (opt-in).
- **Subagents:** take steps and route effort inside `agentId` loops too.

## Phase 3: prompt-level routing and skipping Claude entirely

- **`prompt.submit` classifier:**
  - question vs. task vs. command-like request;
  - which skill or workflow applies (add context);
  - whether it needs plan mode first.
- **Whole-turn bypass:** prompts that are just a known action ("run the tests", "show the diff", "what changed?") are answered by Jev picking the action. The result goes back through a small summarizer (Haiku via `$.model.complete`) or verbatim, and the main Claude model isn't used at all.
- **Subagent type choice:** Jev picks `subagentType` for Agent calls; Claude still writes the prompt.
- **Context selection:** rerank which earlier tool results to keep when compacting (a `session.compact` hook, with Jev scoring relevance).

## Phase 4: the full version

- **Argument selection beyond fixed lists:** code extracts candidate values (paths, symbols, test names, line ranges) from the repo and transcript, and Jev picks the values and fills the call. For example, `Read` with `offset`/`limit` around a symbol, or `npm test -- <file>` for the test file nearest to the change.
- **Edit verification:** after an `Edit` or `Write`, Jev checks the change against the request and the test output. A clear failure sends Claude back with a short reason.
- **Learned policy:** use the Phase 2 log as labelled data, so Jev scores become features of a small classical model that decides take/route/gate (TypeSafe's feature-discovery pattern).
- **Per-project profiles:** thresholds and candidate generators per repo, stored in `.jev/config.json`.
- **Dashboard pane:** a live side pane with decisions, savings and override buttons ("this was wrong").
- **Package and share:** a marketplace repo, so others install it with `/plugin install jev-pilot --marketplace <owner>/<repo>`.

## Known limits (all phases)

- **Jev can't write.** Code, new commands and replies to the user always come from Claude.
- **Switching models invalidates the prompt cache.** That's why `model` routing is opt-in and decided once per turn.
- **A Jev step adds one network round trip** (typically a few hundred ms). It replaces a full Claude request only when Jev is confident.
- **Thresholds are starting points.** Phase 2 calibrates them on your real sessions.
