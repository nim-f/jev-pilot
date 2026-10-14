import type { On, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { compactInstructions, compactItems } from '../hooks/compact'
import { hints } from '../hooks/prompt'

const CWD = '/proj'

function base(on: On, jev: (q: Record<string, unknown>) => Record<string, unknown>, messages: SessionMessage[] = []) {
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  mock.store(on, {})
  mock.clock(on)
  on('session.cwd', () => ({ value: CWD }))
  on('session.messages', () => ({ value: messages }))
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as { questions: Record<string, unknown> }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: jev(body.questions) }) } }
  })
}

test('hints: a mid-confidence skill and a large task get hints; a confident skill is left to step 0', () => {
  expect(hints('task', 0.9, { name: 'aws-diagrams', p: 0.7 }, 0.85)).toHaveLength(2)
  expect(hints('question', 0.9, { name: 'aws-diagrams', p: 0.95 }, 0.85)).toHaveLength(0)
  expect(hints('task', 0.2, { name: 'none', p: 0.9 }, 0.85)).toHaveLength(0)
})

test('The prompt classifier adds a hint only Claude reads', async ($, on) => {
  base(on, () => ({
    kind: { type: 'choice', choice: 'task', probabilities: { task: 0.9, question: 0.1 }, confidence: 0.8 },
    needs_plan: { type: 'noul', noul: 0.93 },
    skill: { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 },
  }))
  on('command.list', () => ({ value: [{ name: 'aws-diagrams', description: 'Draw AWS diagrams', source: 'plugin' as const }] }))
  let seen: readonly string[] | undefined
  on('prompt.submit', ($, e) => {
    seen = e.context
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'rewrite the storage layer to use IndexedDB and sync across tabs', wait: false, origin: { kind: 'composer' } } as never)
  expect(seen?.join('\n') ?? '').toContain('plan')
})

test('A general-purpose subagent is switched only when Jev is confident; an explicit type is kept', async ($, on) => {
  base(on, () => ({ agent_type: { type: 'choice', choice: 'Explore', probabilities: { Explore: 0.92, 'general-purpose': 0.08 }, confidence: 0.85 } }))
  on('agent.offer', () => ({ isOffered: true }))
  const spawned: (string | undefined)[] = []
  on('tool.call', ($, e) => {
    spawned.push((e as { subagent_type?: string }).subagent_type)
    return { result: undefined } as never
  })
  await $.agent.offer({ agent: 'general-purpose', description: 'General tasks', source: 'built-in' } as never)
  await $.agent.offer({ agent: 'Explore', description: 'Read-only codebase search', source: 'built-in' } as never)

  await $.tool.call({ tool: 'Agent', description: 'find usages', prompt: 'Find every caller of addTodo', tool_use_id: 'a1' } as never)
  await $.tool.call({ tool: 'Agent', description: 'plan', prompt: 'Find every caller of addTodo', subagent_type: 'Plan', tool_use_id: 'a2' } as never)
  expect(spawned).toEqual(['Explore', 'Plan'])
})

test('Compaction instructions keep relevant results and mark stale ones', () => {
  const messages: SessionMessage[] = [
    { role: 'user', text: 'fix the failing date test', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 't1', tool: 'Read', input: { file_path: '/proj/todo.js' }, text: 'export function isOverdue…' },
        { tool_use_id: 't2', tool: 'Bash', input: { command: 'ls' }, text: 'a b c' },
        { tool_use_id: 't3', tool: 'Bash', input: { command: 'npm test' }, text: 'not ok 5 - isOverdue' },
      ],
    },
  ]
  const items = compactItems(messages)
  expect(items.map(i => i.label)).toEqual(['Read /proj/todo.js', 'Bash ls', 'Bash npm test'])
  const text = compactInstructions(items, [2.5, 0.2, 2.9]) ?? ''
  expect(text).toContain('Keep exact details (paths, errors, decisions, values) from: Read /proj/todo.js; Bash npm test.')
  expect(text).toContain('dropped: Bash ls.')
})

test('session.compact passes the ranking to the summarizer', async ($, on) => {
  const messages: SessionMessage[] = [
    { role: 'user', text: 'fix the failing date test', toolUses: [] },
    {
      role: 'assistant',
      text: '',
      toolUses: ['a', 'b', 'c'].map((x, i) => ({ tool_use_id: `t${i}`, tool: 'Bash', input: { command: `step ${x}` }, text: x })),
    },
  ]
  base(on, q => Object.fromEntries(Object.keys(q).map((k, i) => [k, { type: 'score', score: i === 0 ? 2.8 : 0.3, probabilities: {}, confidence: 0.8 }])))
  let instructions: string | undefined
  on('session.compact', ($, e) => {
    instructions = e.instructions
    return { skip: 'test' }
  })
  await $.session.compact({ trigger: 'manual', messages } as never)
  expect(instructions ?? '').toContain('Keep exact details (paths, errors, decisions, values) from: Bash step a.')
})
