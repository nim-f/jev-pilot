import type { EngineInterface } from 'claude-code'

// TypeSafe System One API: one request carries every question about one state.
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'
const TIMEOUT_MS = 4000

export type Question =
  | { type: 'noul'; instructions: unknown; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: unknown; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: unknown; criteria: string[] }

export type NoulAnswer = { type: 'noul'; noul: number }
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type ScoreAnswer = { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number }
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

export type JevResult =
  | { ok: true; answers: Record<string, Answer>; ms: number }
  | { ok: false; error: string; ms: number }

/** Asks Jev; never throws. Any failure is `{ ok: false }` so callers fall back to Claude Code's own behaviour. */
export async function askJev($: EngineInterface, state: unknown, questions: Record<string, Question>): Promise<JevResult> {
  const startedAt = await $.clock.now()
  const done = async (r: { ok: true; answers: Record<string, Answer> } | { ok: false; error: string }): Promise<JevResult> =>
    ({ ...r, ms: (await $.clock.now()) - startedAt }) as JevResult

  const key = await $.env.get('TYPESAFE_API_KEY')
  if (!key) return done({ ok: false, error: 'TYPESAFE_API_KEY is not set' })

  const request = $.http.fetch(JEV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions }),
  })
  request.catch(() => {})
  const timeout = $.clock.sleep(TIMEOUT_MS).then(() => undefined)

  try {
    const res = await Promise.race([request, timeout])
    if (!res) return done({ ok: false, error: `timeout after ${TIMEOUT_MS}ms` })
    if (!res.ok) return done({ ok: false, error: `HTTP ${res.status}` })
    const body = JSON.parse(res.text) as { answers?: Record<string, Answer> }
    if (!body.answers) return done({ ok: false, error: 'response had no answers' })
    return done({ ok: true, answers: body.answers })
  } catch (err) {
    return done({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

export function noul(answers: Record<string, Answer>, id: string): number | undefined {
  const a = answers[id]
  return a?.type === 'noul' ? a.noul : undefined
}

export function choice(answers: Record<string, Answer>, id: string): ChoiceAnswer | undefined {
  const a = answers[id]
  return a?.type === 'choice' ? a : undefined
}

export function score(answers: Record<string, Answer>, id: string): ScoreAnswer | undefined {
  const a = answers[id]
  return a?.type === 'score' ? a : undefined
}
