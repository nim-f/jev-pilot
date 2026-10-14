import type { EngineInterface, SessionMessage } from 'claude-code'

export type TurnContext = {
  /** The user's request this turn answers. */
  request: string
  /** Messages after the request: the turn's steps so far. */
  steps: SessionMessage[]
}

export type StepSummary = { assistant?: string; tool?: string; input?: string; result?: string; isError?: true }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text)

export async function readTurn($: EngineInterface, agentId?: string): Promise<TurnContext | undefined> {
  const messages = await $.session.messages(agentId ? { agentId } : {})
  if (!Array.isArray(messages)) return undefined
  return splitTurn(messages)
}

// Rows the person didn't type as a request: `!` shell runs, slash-command output,
// and the engine's notices (background task results, reminders).
const TRANSCRIPT_ONLY = /^\s*<(bash-input|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat|command-name|command-message|system-reminder|task-notification)>/

/** The last user message that carries text and no tool results is the request. */
export function splitTurn(messages: readonly SessionMessage[]): TurnContext | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user' && m.text.trim() !== '' && !(m.toolResults?.length) && !TRANSCRIPT_ONLY.test(m.text)) {
      return { request: m.text, steps: messages.slice(i + 1) }
    }
  }
  return undefined
}

/** The turn's tool calls in order, with their outcomes. */
export function toolCalls(steps: readonly SessionMessage[]) {
  return steps.flatMap(m => (m.role === 'assistant' ? m.toolUses : []))
}

/** A compact view of the last `limit` steps for Jev's state. */
export function summarize(steps: readonly SessionMessage[], limit = 8): StepSummary[] {
  const out: StepSummary[] = []
  for (const m of steps) {
    if (m.role !== 'assistant') continue
    if (m.text.trim()) out.push({ assistant: clip(m.text, 400) })
    for (const use of m.toolUses) {
      out.push({
        tool: use.tool,
        input: clip(JSON.stringify(use.input), 300),
        ...(use.text !== undefined ? { result: clip(use.text, 400) } : {}),
        ...(use.isError ? { isError: true as const } : {}),
      })
    }
  }
  return out.slice(-limit)
}

export { clip }
