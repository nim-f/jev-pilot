import type { On, PluginOptions, SessionMessage } from 'claude-code'

import { clip, splitTurn } from './context'
import { askJev, score } from './jev'
import type { Question } from './jev'
import { record } from './log'
import { currentMode } from './mode'

// Phase 3: before a compaction, Jev scores how relevant each recent tool
// result is to the current work. No message is dropped (that could break tool
// call/result pairs); the summarizer is told what to keep in detail.
const MAX_ITEMS = 30
const RELEVANCE = [
  'Irrelevant now: superseded, exploratory, or about finished work',
  'Background: useful context but details can be summarized',
  'Relevant: needed to continue the current work',
  'Essential: exact details (paths, errors, decisions, values) must be kept',
]

export type Item = { id: string; label: string; result: string }

export function compactItems(messages: readonly SessionMessage[]): Item[] {
  const items: Item[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const u of m.toolUses) {
      const target = typeof u.input.file_path === 'string' ? u.input.file_path : typeof u.input.command === 'string' ? clip(u.input.command, 80) : clip(JSON.stringify(u.input), 80)
      items.push({ id: u.tool_use_id, label: `${u.tool} ${target}`, result: clip(u.text ?? '', 500) })
    }
  }
  return items.slice(-MAX_ITEMS)
}

export function compactInstructions(items: readonly Item[], scores: readonly (number | undefined)[]): string | undefined {
  const keep = items.filter((_, i) => (scores[i] ?? 0) >= 2.2).map(i => i.label)
  const drop = items.filter((_, i) => scores[i] !== undefined && scores[i]! < 0.8).map(i => i.label)
  if (!keep.length && !drop.length) return undefined
  const lines = ['Relevance ranking from Jev:']
  if (keep.length) lines.push(`Keep exact details (paths, errors, decisions, values) from: ${keep.join('; ')}.`)
  if (drop.length) lines.push(`These are no longer relevant and can be reduced to a word or dropped: ${drop.join('; ')}.`)
  return lines.join('\n')
}

export function registerCompaction(on: On, options: PluginOptions) {
  if (options.compaction === false) return
  on('session.compact', async ($, e, next) => {
    if (e.agentId || (e.trigger !== 'manual' && e.trigger !== 'auto')) return next(e)
    const m = await currentMode($, options.mode)
    if (m === 'off') return next(e)
    const items = compactItems(e.messages)
    if (items.length < 3) return next(e)

    const request = splitTurn(e.messages)?.request ?? ''
    const questions: Record<string, Question> = {}
    items.forEach((it, i) => {
      questions[`item_${i}`] = {
        type: 'score',
        instructions: `How relevant is this earlier tool call and its result to continuing the work on \`request\`? Call: ${it.label}. Result: ${it.result || '(no output)'}`,
        criteria: RELEVANCE,
      }
    })
    const r = await askJev($, { request: clip(request, 2000), item_count: items.length }, questions)
    if (!r.ok) return next(e)
    const scores = items.map((_, i) => score(r.answers, `item_${i}`)?.score)
    const added = compactInstructions(items, scores)
    const keep = scores.filter(s => (s ?? 0) >= 2.2).length
    const drop = scores.filter(s => s !== undefined && s < 0.8).length
    await record($, {
      kind: 'compact',
      applied: m === 'active' && added !== undefined,
      text: `${e.trigger} compaction: ${items.length} results scored, keep ${keep}, drop ${drop}`,
      ms: r.ms,
      data: { trigger: e.trigger, items: items.length, keep, drop },
    })
    if (m !== 'active' || !added) return next(e)
    return next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${added}` : added })
  })
}
