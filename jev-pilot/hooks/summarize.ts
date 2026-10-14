import type { EngineInterface, ModelUsage } from 'claude-code'

import { clip } from './context'

// Whole-turn bypass: once Jev has taken the one action a simple request needs,
// a small model reports the result instead of the main Claude model.
export const SUMMARY_MODEL = 'claude-haiku-5-5'

const SYSTEM = [
  'You report the result of one action (a command run or a file read) to a developer, inside Claude Code.',
  "Answer the developer's request using only the action's output. Lead with the outcome (for tests: how many passed or failed, and which failed).",
  'Be brief: one to four sentences or a short list, in Markdown. Do not suggest next steps unless something failed. Never invent details that are not in the output.',
].join(' ')

export type Summary = { ok: true; text: string; usage: ModelUsage } | { ok: false; reason: string }

export async function summarizeResult($: EngineInterface, request: string, action: string, output: string): Promise<Summary> {
  const r = await $.model.complete({
    model: SUMMARY_MODEL,
    system: SYSTEM,
    prompt: `Request: ${clip(request, 2000)}\nAction: ${action}\nOutput:\n${clip(output, 12000)}`,
    maxTokens: 600,
    timeoutMs: 20000,
  })
  if (!r.isAnswered) return { ok: false, reason: r.reason }
  const text = r.text.trim()
  return text ? { ok: true, text, usage: r.usage } : { ok: false, reason: 'empty-reply' }
}
