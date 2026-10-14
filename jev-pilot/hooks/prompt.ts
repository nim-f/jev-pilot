import type { EngineInterface, On, PluginOptions } from 'claude-code'

import { BUILTIN_COMMANDS, SKILL_BLOCKLIST_KEY } from './candidates'
import { clip } from './context'
import { askJev, choice, noul } from './jev'
import type { Question } from './jev'
import { record } from './log'
import { currentMode } from './mode'

// Phase 3: classify each prompt as it is sent and, when Jev is confident, add
// a short hint only Claude reads (a skill that fits, or plan first).
const NONE = 'none'
const KIND_LEVELS: Record<string, string> = {
  question: 'Asks for an explanation, information or an opinion; no change is needed',
  task: 'Asks for a change: writing, editing, fixing or building something',
  command: 'Asks to run, show or check one specific thing (tests, status, a file)',
  conversation: 'Small talk, thanks, or a reply to the assistant with no new request',
}
const SKILL_HINT = 0.6
const PLAN_HINT = 0.85

async function skillOptions($: EngineInterface) {
  const commands = await $.command.list().catch(() => [])
  const blocked = new Set(((await $.store.get(SKILL_BLOCKLIST_KEY).catch(() => undefined)) as string[] | undefined) ?? [])
  const criteria: Record<string, string | null> = { [NONE]: 'No listed skill is meant for this request' }
  for (const c of commands) {
    if ((c.source === 'plugin' || c.source === 'user') && c.name !== 'jev' && !BUILTIN_COMMANDS.has(c.name) && !blocked.has(c.name))
      criteria[c.name] = clip(c.description, 160)
  }
  return Object.keys(criteria).length > 1 ? criteria : undefined
}

export function promptQuestions(skills: Record<string, string | null> | undefined): Record<string, Question> {
  const questions: Record<string, Question> = {
    kind: { type: 'choice', instructions: 'What kind of message is `request`, sent to an AI coding assistant?', criteria: KIND_LEVELS },
    needs_plan: {
      type: 'noul',
      instructions: 'Is `request` a large or ambiguous change (several files, design choices, unclear scope) that the assistant should plan and confirm before editing anything?',
      criteria: { true: 'Large or ambiguous: plan first', false: 'Small, clear, or not a change at all' },
    },
  }
  if (skills) questions.skill = { type: 'choice', instructions: 'Which listed skill is squarely meant for `request`, if any?', criteria: skills }
  return questions
}

export function hints(kind: string | undefined, needsPlan: number | undefined, skill: { name: string; p: number } | undefined, takeThreshold: number): string[] {
  const out: string[] = []
  if (skill && skill.name !== NONE && skill.p >= SKILL_HINT && skill.p < takeThreshold)
    out.push(`Jev routing hint: the skill "${skill.name}" looks like a fit for this request (p=${skill.p.toFixed(2)}). Consider invoking it.`)
  if (kind === 'task' && (needsPlan ?? 0) >= PLAN_HINT)
    out.push(`Jev routing hint: this looks like a large or ambiguous change (p=${(needsPlan ?? 0).toFixed(2)}). Outline a short plan and confirm it with the user before editing.`)
  return out
}

export function registerPromptClassifier(on: On, options: PluginOptions, takeThreshold: number) {
  if (options.classify === false) return
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.text.trim().length < 3) return next(e)
    const m = await currentMode($, options.mode)
    if (m === 'off') return next(e)

    const questions = promptQuestions(await skillOptions($))
    const r = await askJev($, { request: clip(e.text, 3000) }, questions)
    if (!r.ok) return next(e)
    const kind = choice(r.answers, 'kind')
    const needsPlan = noul(r.answers, 'needs_plan')
    const skillAnswer = choice(r.answers, 'skill')
    const skill = skillAnswer ? { name: skillAnswer.choice, p: skillAnswer.probabilities[skillAnswer.choice] ?? 0 } : undefined
    const added = hints(kind?.choice, needsPlan, skill, takeThreshold)

    await record($, {
      kind: 'classify',
      applied: m === 'active' && added.length > 0,
      text: `${kind?.choice ?? '?'}${needsPlan !== undefined ? `, plan ${needsPlan.toFixed(2)}` : ''}${skill && skill.name !== NONE ? `, skill ${skill.name} ${skill.p.toFixed(2)}` : ''}${added.length ? ' → hint' : ''}`,
      ms: r.ms,
      data: { request: clip(e.text, 120), kind: kind?.choice, kindP: kind?.confidence, needsPlan, skill: skill?.name, skillP: skill?.p, hints: added.length },
    })
    if (m !== 'active' || !added.length) return next(e)
    return next({ ...e, context: [...(e.context ?? []), ...added] })
  })
}
