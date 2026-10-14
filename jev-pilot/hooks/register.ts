import type { EngineInterface, Register } from "claude-code";

import { buildCandidates, sameCall, SKILL_BLOCKLIST_KEY } from "./candidates";
import type { Candidate } from "./candidates";
import { clip, readTurn, summarize, toolCalls } from "./context";
import { askJev, choice, noul, score } from "./jev";
import type { Question } from "./jev";
import { clearLog, readLog, record, recentDecisions, stats } from "./log";
import { buildReport } from "./report";
import { registerView } from "./view";
import { currentMode, MODES } from "./mode";
import { registerPromptClassifier } from "./prompt";
import { registerAgentTypes } from "./agents";
import { registerCompaction } from "./compact";
import { summarizeResult, SUMMARY_MODEL } from "./summarize";
import {
    bestAction,
    bashRiskQuestion,
    difficultyQuestion,
    singleActionQuestion,
    doneQuestion,
    gateBash,
    gateEdit,
    inScopeQuestion,
    lowerEffort,
    lowerModel,
    nextActionQuestion,
    pickCandidate,
    route,
    shouldContinue,
} from "./policy";
import type { GateThresholds, Route } from "./policy";

const MAX_TAKES_PER_TURN = 3;
const GATED = new Set(["Bash", "Edit", "Write", "NotebookEdit"]);

/** Short form of a step's tool calls: `Edit app.js ×3, Bash npm test`. */
function summarizeCalls(
    calls: readonly { tool: string; input: Record<string, unknown> }[],
): string {
    if (!calls.length) return "replied";
    const parts = new Map<string, number>();
    for (const c of calls) {
        const target =
            typeof c.input.file_path === "string"
                ? c.input.file_path.split("/").pop()
                : typeof c.input.command === "string"
                  ? c.input.command.replace(/\s+/g, " ").slice(0, 30)
                  : typeof c.input.skill === "string"
                    ? c.input.skill
                    : "";
        const key = target ? `${c.tool} ${target}` : c.tool;
        parts.set(key, (parts.get(key) ?? 0) + 1);
    }
    return [...parts]
        .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
        .join(", ");
}

async function blockSkill($: EngineInterface, name: string) {
    const list = ((await $.store.get(SKILL_BLOCKLIST_KEY)) as string[] | undefined) ?? [];
    if (!list.includes(name))
        await $.store.set(SKILL_BLOCKLIST_KEY, [...list, name]);
}


export const register: Register = (on, options) => {
    const routing =
        options.routing === "model" || options.routing === "off"
            ? options.routing
            : "effort";
    const takeSteps = options.takeSteps !== false;
    const gate = options.gate !== false;
    const doneCheck = options.doneCheck !== false;
    const takeThreshold =
        typeof options.takeThreshold === "number"
            ? options.takeThreshold
            : 0.85;
    const subagents = options.subagents !== false;
    const bypass = options.bypass !== false;
    const SINGLE_ACTION = 0.8;
    const threshold = (key: string, fallback: number) =>
        typeof options[key] === "number" ? (options[key] as number) : fallback;
    const gateThresholds: GateThresholds = {
        dangerAsk: threshold("dangerAsk", 0.5),
        dangerDeny: threshold("dangerDeny", 0.8),
        scopeDeny: threshold("scopeDeny", 0.2),
        editScope: threshold("editScope", 0.15),
    };
    const doneThreshold = threshold("doneThreshold", 0.15);

    registerView(on);
    registerPromptClassifier(on, options, takeThreshold);
    registerAgentTypes(on, options);
    registerCompaction(on, options);

    const turns = new Map<
        string,
        { route?: Route; taken: number; bypassId?: string; bypassAction?: string }
    >();
    // Calls Jev made itself skip the gate: their commands come from a vetted list.
    const ownCalls = new Set<string>();

    on("session.start", async ($, e, next) => {
        await $.command.register({
            name: "jev",
            description:
                "Jev pilot: status, /jev report, /jev export, /jev clear, or switch mode with /jev active|shadow|off",
        });
        return next(e);
    });

    on("command.run", { command: "jev" }, async ($, e) => {
        const arg = e.args.trim();
        if ((MODES as readonly string[]).includes(arg)) {
            await $.store.set("mode", arg);
            return { text: `Jev pilot mode: ${arg}` };
        }
        if (arg === "report") {
            return {
                text: buildReport(
                    await readLog($),
                    takeThreshold,
                    await currentMode($, options.mode),
                ),
            };
        }
        if (arg === "clear") {
            await clearLog($);
            return { text: "Jev pilot: log cleared." };
        }
        if (arg === "export") {
            const log = await readLog($);
            const path = `${await $.session.cwd()}/.jev/decisions.jsonl`;
            try {
                await $.fs.write(
                    path,
                    log.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
                );
                return { text: `Jev pilot: wrote ${log.length} entries to ${path}` };
            } catch (err) {
                return {
                    text: `Jev pilot: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`,
                };
            }
        }
        const counts =
            Object.entries(await stats($))
                .map(([k, v]) => `${k}=${v}`)
                .join(", ") || "none yet";
        const lines = recentDecisions()
            .slice(-10)
            .map(
                (d) =>
                    `- ${d.kind}${d.applied ? "" : " (shadow)"}: ${d.text}${d.ms !== undefined ? ` [${Math.round(d.ms)}ms]` : ""}`,
            );
        return {
            text: [
                `Jev pilot: mode ${await currentMode($, options.mode)}, routing ${routing}, take steps ${takeSteps} (p ≥ ${takeThreshold}), gate ${gate}, done check ${doneCheck}, subagents ${subagents}`,
                `Decisions (all sessions): ${counts}`,
                lines.length
                    ? `Recent:\n${lines.join("\n")}`
                    : "No decisions this session yet.",
                "Full analysis: /jev report",
            ].join("\n"),
        };
    });

    on("turn.complete", async ($, e, next) => {
        turns.delete(e.turnId);
        if (e.reason === "aborted" || e.reason === "error")
            await record($, {
                kind: "turn",
                applied: false,
                text: `turn ${e.reason}`,
                turnId: e.turnId,
                data: { reason: e.reason },
            });
        return next(e);
    });

    // Outcome of each call Jev made itself, for the report.
    on("tool.call", async ($, e, next) => {
        const result = await next(e);
        if (e.tool_use_id && ownCalls.has(e.tool_use_id)) {
            const isError = result.deny !== undefined || result.isError === true;
            await record($, {
                kind: "outcome",
                applied: true,
                text: `${e.tool} ${isError ? "failed" : "ok"}`,
                data: { id: e.tool_use_id, isError },
            });
            // A skill the Skill tool refused is never offered to Jev again.
            const skill = (e as { skill?: unknown }).skill;
            if (isError && e.tool === "Skill" && typeof skill === "string")
                await blockSkill($, skill);
        }
        return result;
    });

    // Each model request: Jev may take the step itself, and at step 0 rates the
    // turn's difficulty to lower effort or model. One Jev request carries both.
    // Every answer is logged; when Claude takes the step, its call is compared
    // with Jev's top action so shadow runs can calibrate the threshold.
    on("turn.step", async function* ($, e, next) {
        const m = await currentMode($, options.mode);
        if (m === "off" || (e.agentId && !subagents)) return yield* next(e);

        const turn = turns.get(e.turnId) ?? { taken: 0 };
        turns.set(e.turnId, turn);

        const ctx = await readTurn($, e.agentId);
        if (!ctx) return yield* next(e);
        const calls = toolCalls(ctx.steps);
        const last = calls.at(-1);

        // Whole-turn bypass: Jev took the one action this simple request needs;
        // a small model reports its result and Claude is not asked at all.
        if (turn.bypassId && e.index > 0) {
            const id = turn.bypassId;
            turn.bypassId = undefined;
            const done = calls.find((c) => c.tool_use_id === id);
            if (m === "active" && done?.text !== undefined) {
                const s = await summarizeResult(
                    $,
                    ctx.request,
                    turn.bypassAction ?? done.tool,
                    done.text,
                );
                await record($, {
                    kind: "bypass",
                    applied: s.ok,
                    text: s.ok
                        ? `answered with ${SUMMARY_MODEL} after ${turn.bypassAction}`
                        : `summary failed (${s.reason}), Claude answers`,
                    turnId: e.turnId,
                    data: {
                        action: turn.bypassAction,
                        model: SUMMARY_MODEL,
                        ...(s.ok ? { usage: s.usage } : { reason: s.reason }),
                    },
                });
                if (s.ok) {
                    const usage = { ...s.usage, model: SUMMARY_MODEL };
                    yield { kind: "text", index: 0, text: s.text };
                    yield { kind: "stop", stopReason: "end_turn", usage };
                    return {
                        turnId: e.turnId,
                        index: e.index,
                        answer: s.text,
                        toolUses: [],
                        stopReason: "end_turn",
                        usage,
                    };
                }
            }
        }

        const questions: Record<string, Question> = {};
        let candidates: Candidate[] = [];
        if (takeSteps && turn.taken < MAX_TAKES_PER_TURN) {
            candidates = (
                await buildCandidates($, ctx.request, ctx.steps, calls, e.index)
            ).filter(
                (c) =>
                    !(last && sameCall(last, { tool: c.tool, input: c.input })),
            );
            if (candidates.length)
                questions.next_action = nextActionQuestion(candidates);
        }
        if (routing !== "off" && e.index === 0)
            questions.difficulty = difficultyQuestion;
        if (bypass && e.index === 0 && questions.next_action && !e.agentId)
            questions.single_action = singleActionQuestion;
        if (!Object.keys(questions).length) return yield* next(e);

        const state = {
            request: clip(ctx.request, 4000),
            recent: summarize(ctx.steps),
            cwd: await $.session.cwd(),
        };
        const r = await askJev($, state, questions);
        if (!r.ok) {
            await record($, {
                kind: "error",
                applied: false,
                text: `unavailable: ${r.error}`,
                ms: r.ms,
                turnId: e.turnId,
            });
            return yield* next(e);
        }

        if (questions.difficulty) {
            const difficulty = score(r.answers, "difficulty");
            turn.route = route(
                difficulty,
                routing === "model" ? "model" : "effort",
            );
            const effort = lowerEffort(e.effort, turn.route?.effort);
            const model = lowerModel(e.model, turn.route?.model);
            const lowered = Boolean(effort || model);
            await record($, {
                kind: "route",
                applied: m === "active" && lowered,
                text: `difficulty ${(difficulty?.score ?? 0).toFixed(2)} → ${lowered ? `${model ?? e.model}, effort ${effort ?? e.effort}` : "no change"}`,
                ms: r.ms,
                turnId: e.turnId,
                data: {
                    score: difficulty?.score,
                    confidence: difficulty?.confidence,
                    effort,
                    model,
                    lowered,
                },
            });
        }

        const answer = choice(r.answers, "next_action");
        const best = bestAction(answer);
        const pick = pickCandidate(answer, candidates, takeThreshold);
        if (answer) {
            const p = answer.probabilities[answer.choice] ?? 0;
            await record($, {
                kind: "take",
                applied: m === "active" && pick !== undefined,
                text: `${answer.choice} (p=${p.toFixed(2)})${pick ? "" : best ? `; best action ${best.key} p=${best.p.toFixed(2)}` : ""}`,
                ms: r.ms,
                turnId: e.turnId,
                data: {
                    pick: answer.choice,
                    p,
                    best: best?.key,
                    bestP: best?.p,
                    candidates: candidates.length,
                    threshold: takeThreshold,
                    wouldTake: pick !== undefined,
                    singleAction: noul(r.answers, "single_action"),
                    agentId: e.agentId,
                },
            });
        }

        if (pick && m === "active") {
            turn.taken += 1;
            const id = `toolu_jev_${crypto.randomUUID().replace(/-/g, "")}`;
            ownCalls.add(id);
            if ((noul(r.answers, "single_action") ?? 0) >= SINGLE_ACTION) {
                turn.bypassId = id;
                turn.bypassAction = pick.key;
            }
            yield { kind: "tool", index: 0, id, name: pick.tool };
            yield { kind: "input", index: 0, json: JSON.stringify(pick.input) };
            yield { kind: "stop", stopReason: "tool_use", usage: null };
            return {
                turnId: e.turnId,
                index: e.index,
                answer: "",
                toolUses: [{ name: pick.tool, input: pick.input }],
                stopReason: "tool_use",
                usage: null,
            };
        }

        let request = e;
        if (m === "active" && turn.route) {
            const effort = lowerEffort(e.effort, turn.route.effort);
            const model = lowerModel(e.model, turn.route.model);
            if (effort || model)
                request = {
                    ...e,
                    ...(effort ? { effort } : {}),
                    ...(model ? { model } : {}),
                };
        }
        const result = yield* next(request);

        // Compare Claude's own next call with Jev's top action.
        if (answer) {
            const claudeCalls = result.toolUses.map((u) => ({
                tool: u.name,
                input: (u.input ?? {}) as Record<string, unknown>,
            }));
            const bestCandidate = candidates.find((c) => c.key === best?.key);
            const first = claudeCalls[0];
            const agree = Boolean(
                bestCandidate &&
                    first &&
                    sameCall(first, {
                        tool: bestCandidate.tool,
                        input: bestCandidate.input,
                    }),
            );
            const claudeUsedCandidate = claudeCalls.some((c) =>
                candidates.some((k) =>
                    sameCall(c, { tool: k.tool, input: k.input }),
                ),
            );
            const claudeSummary = summarizeCalls(claudeCalls);
            await record($, {
                kind: "compare",
                applied: false,
                text: `Claude: ${claudeSummary} · Jev best ${best?.key ?? "none"}${agree ? " ✓" : ""}`,
                turnId: e.turnId,
                data: {
                    request: clip(ctx.request, 120),
                    claudeSummary,
                    pick: answer.choice,
                    best: best?.key,
                    bestP: best?.p,
                    claude: claudeCalls.map((c) => c.tool),
                    agree,
                    claudeUsedCandidate,
                },
            });
        }
        return result;
    });

    // Permission gate: only ever tightens what Claude Code already allows.
    on("tool.check", async ($, e, next) => {
        const base = await next(e);
        // Jev's own calls come from the vetted candidate list: approve them so auto
        // mode's classifier doesn't refuse them. A settings deny rule still wins.
        if (e.tool_use_id && ownCalls.has(e.tool_use_id)) {
            if (base.decision === "deny") return base;
            return {
                ...base,
                decision: "allow",
                reason: "Jev pilot: vetted action from its read-only/project-script list",
            };
        }
        if (
            !gate ||
            !GATED.has(e.tool) ||
            (base.decision !== "allow" && base.decision !== "ask") ||
            !e.tool_use_id
        )
            return base;
        const m = await currentMode($, options.mode); // ← add
        if (m === "off") return base;
        const ctx = await readTurn($, e.agentId);
        const input = (e.input ?? {}) as Record<string, unknown>;
        const request = clip(ctx?.request ?? "", 3000);
        const cwd = await $.session.cwd();

        let verdict;
        if (e.tool === "Bash") {
            const r = await askJev(
                $,
                { request, command: String(input.command ?? ""), cwd },
                {
                    risk: bashRiskQuestion,
                    in_scope: inScopeQuestion(
                        "running the command in `command`",
                    ),
                },
            );
            if (!r.ok) return base;
            const risk = score(r.answers, "risk");
            const inScope = noul(r.answers, "in_scope");
            verdict = gateBash(risk, inScope, gateThresholds);
            await record($, {
                kind: "gate",
                applied: m === "active" && verdict !== undefined,
                text: `${verdict?.decision ?? "allow"} Bash: ${clip(String(input.command), 50)}`,
                ms: r.ms,
                data: {
                    tool: "Bash",
                    target: clip(String(input.command), 200),
                    decision: verdict?.decision ?? "allow",
                    danger: risk?.probabilities["2"],
                    inScope,
                },
            });
        } else {
            const change = clip(
                String(
                    input.new_string ?? input.content ?? input.new_source ?? "",
                ),
                1200,
            );
            const file = String(input.file_path ?? input.notebook_path ?? "");
            const r = await askJev(
                $,
                { request, tool: e.tool, file, change, cwd },
                {
                    in_scope: inScopeQuestion(
                        "this change to the file in `file`",
                    ),
                },
            );
            if (!r.ok) return base;
            const inScope = noul(r.answers, "in_scope");
            verdict = gateEdit(inScope, gateThresholds);
            await record($, {
                kind: "gate",
                applied: m === "active" && verdict !== undefined,
                text: `${verdict?.decision ?? "allow"} ${e.tool}: ${file}`,
                ms: r.ms,
                data: {
                    tool: e.tool,
                    target: file,
                    decision: verdict?.decision ?? "allow",
                    inScope,
                },
            });
        }
        // Only ever tighter: allow → ask/deny, ask → deny.
        if (!verdict || m !== "active") return base;
        const tighter =
            verdict.decision === "deny" || base.decision === "allow";
        return tighter
            ? { ...base, decision: verdict.decision, reason: verdict.reason }
            : base;
    });

    // Done check: when Claude stops, send it back once if the request looks unfinished.
    on("classic.Stop", async ($, e, next) => {
        if (!doneCheck || e.stop_hook_active) return next(e);
        const m = await currentMode($, options.mode);
        if (m === "off") return next(e);
        // Waiting on background work (a subagent, a background command) is not
        // stopping early: that work will wake the session when it finishes.
        const waitingOn = e.background_tasks?.length ?? 0;
        if (waitingOn > 0) {
            await record($, {
                kind: "done",
                applied: false,
                text: `skipped: waiting on ${waitingOn} background task(s)`,
                data: { skipped: "background", continued: false },
            });
            return next(e);
        }

        const ctx = await readTurn($);
        if (!ctx) return next(e);
        const r = await askJev(
            $,
            {
                request: clip(ctx.request, 3000),
                final_message: clip(e.last_assistant_message ?? "", 2000),
                recent: summarize(ctx.steps),
            },
            { done: doneQuestion },
        );
        if (!r.ok) return next(e);
        const done = noul(r.answers, "done");
        const unfinished = shouldContinue(done, doneThreshold);
        await record($, {
            kind: "done",
            applied: m === "active" && unfinished,
            text: unfinished
                ? `not finished (p=${(done ?? 0).toFixed(2)}), continuing`
                : `finished (p=${(done ?? 0).toFixed(2)})`,
            ms: r.ms,
            data: { p: done, continued: unfinished },
        });
        if (!unfinished) return next(e);
        const below = await next(e);
        if (m !== "active" || below.block) return below;
        return {
            ...below,
            block: "Jev: the user's request doesn't look finished yet. Continue with what remains. If it is actually complete, say so in one line.",
        };
    });
};
