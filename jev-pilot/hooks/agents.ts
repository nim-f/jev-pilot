import type { On, PluginOptions } from 'claude-code'

import { clip } from './context'
import { askJev, choice } from './jev'
import { record } from './log'
import { currentMode } from './mode'

// Phase 3: when Claude starts a general-purpose subagent, Jev may pick a more
// specialised agent type. An explicit choice by Claude is only compared, never changed.
const GENERAL = new Set(['', 'general-purpose', 'claude'])
const SWITCH_AT = 0.85

export function registerAgentTypes(on: On, options: PluginOptions) {
  if (options.agentTypes === false) return
  // Agent types as the engine offers them to the model, with their descriptions.
  const offered = new Map<string, string>()

  on('agent.offer', async ($, e, next) => {
    offered.set(e.agent, e.description)
    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const m = await currentMode($, options.mode)
    const claudeType = e.subagent_type ?? ''
    if (m === 'off' || offered.size < 2 || claudeType === 'fork') return next(e)

    const criteria: Record<string, string | null> = {}
    for (const [name, description] of offered) criteria[name] = clip(description, 200)
    const r = await askJev(
      $,
      { task: clip(e.prompt, 3000), description: e.description },
      { agent_type: { type: 'choice', instructions: 'Which agent type is best suited to carry out `task`?', criteria } },
    )
    if (!r.ok) return next(e)
    const answer = choice(r.answers, 'agent_type')
    if (!answer) return next(e)
    const p = answer.probabilities[answer.choice] ?? 0
    const canSwitch = GENERAL.has(claudeType) && !GENERAL.has(answer.choice) && p >= SWITCH_AT
    await record($, {
      kind: 'agent',
      applied: m === 'active' && canSwitch,
      text: `Claude ${claudeType || '(default)'} · Jev ${answer.choice} p=${p.toFixed(2)}${canSwitch ? ' → switched' : ''}`,
      ms: r.ms,
      data: { claude: claudeType || 'general-purpose', jev: answer.choice, p, switched: canSwitch, agree: answer.choice === (claudeType || 'general-purpose') },
    })
    return m === 'active' && canSwitch ? next({ ...e, subagent_type: answer.choice }) : next(e)
  })
}
