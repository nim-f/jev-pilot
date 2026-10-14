import type { On, SessionMessage, TurnStepChunk } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const CWD = '/proj'

type Jev = (questions: Record<string, unknown>) => Record<string, unknown> | number

// Answers every call the mod makes on `$`, with Jev's answers from `jev`
// (a number is an HTTP error status).
function setup(on: On, opts: { messages: SessionMessage[]; jev: Jev; files?: string[]; mode?: string; packageJson?: object }) {
  const sent: Record<string, unknown>[] = []
  mock.env(on, { TYPESAFE_API_KEY: 'test-key' })
  mock.store(on, opts.mode ? { mode: opts.mode } : {})
  mock.clock(on)
  on('session.messages', () => ({ value: opts.messages }))
  on('session.cwd', () => ({ value: CWD }))
  on('fs.exists', ($, e) => ({ value: Boolean(opts.packageJson) && e.path === `${CWD}/package.json` }))
  on('fs.stat', ($, e) =>
    (opts.files ?? []).includes(e.path)
      ? { value: { kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('fs.read', ($, e) =>
    opts.packageJson && e.path === `${CWD}/package.json` ? { value: JSON.stringify(opts.packageJson) } : { deny: 'ENOENT' },
  )
  on('ui.status', () => ({ value: undefined }))
  on('http.fetch', ($, e) => {
    const body = JSON.parse(e.init?.body ?? '{}') as { questions: Record<string, unknown> }
    sent.push(body)
    const answers = opts.jev(body.questions)
    if (typeof answers === 'number') return { value: { status: answers, ok: false, headers: {}, text: '{}' } }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ model: 'jev-1', answers }) } }
  })
  return { sent }
}

const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })

const step = { turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high' as const, messageCount: 1 }

const easy = { type: 'score', score: 0.2, probabilities: { '0': 0.85, '1': 0.1, '2': 0.05, '3': 0 }, confidence: 0.8 }

async function drain(stream: AsyncGenerator<TurnStepChunk> & { result: Promise<unknown> }) {
  const chunks: TurnStepChunk[] = []
  for await (const c of stream) chunks.push(c)
  return { chunks, result: await stream.result }
}

function claudeBeneath(on: On, seen: unknown[]) {
  on('turn.step', async function* ($, e) {
    seen.push(e)
    yield { kind: 'text', index: 0, text: 'from claude' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'from claude', toolUses: [], stopReason: 'end_turn', usage: null }
  })
}

test('Jev takes a confident Read step without asking Claude', async ($, on) => {
  const seen: unknown[] = []
  setup(on, {
    messages: [user('what does src/app.ts export?')],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
      next_action: { type: 'choice', choice: 'read src/app.ts', probabilities: { 'read src/app.ts': 0.95, claude: 0.05 }, confidence: 0.9 },
      difficulty: easy,
    }),
  })
  claudeBeneath(on, seen)

  const { chunks } = await drain($.turn.step(step))
  expect(seen).toHaveLength(0)
  expect(chunks).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'Read' }))
  expect(chunks).toContainEqual({ kind: 'input', index: 0, json: JSON.stringify({ file_path: `${CWD}/src/app.ts` }) })
})

test('An unsure Jev hands the step to Claude, with effort lowered for an easy turn', async ($, on) => {
  const seen: { effort?: string; model: string }[] = []
  setup(on, {
    messages: [user('what does src/app.ts export?')],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
      next_action: { type: 'choice', choice: 'read src/app.ts', probabilities: { 'read src/app.ts': 0.6, claude: 0.4 }, confidence: 0.3 },
      difficulty: easy,
    }),
  })
  claudeBeneath(on, seen as unknown[])

  await drain($.turn.step(step))
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ effort: 'low', model: 'claude-opus-5-5' })
})

test('model routing moves a trivial turn to Haiku', { options: { routing: 'model' } }, async ($, on) => {
  const seen: unknown[] = []
  setup(on, { messages: [user('hi, what time zone is UTC+2?')], jev: () => ({ difficulty: easy }) })
  claudeBeneath(on, seen)

  await drain($.turn.step(step))
  expect(seen[0]).toMatchObject({ effort: 'low', model: 'claude-haiku-5-5' })
})

test('When Jev is unreachable the step goes to Claude unchanged', async ($, on) => {
  const seen: unknown[] = []
  setup(on, { messages: [user('what does src/app.ts export?')], files: [`${CWD}/src/app.ts`], jev: () => 401 })
  claudeBeneath(on, seen)

  const { chunks } = await drain($.turn.step(step))
  expect(seen[0]).toMatchObject({ effort: 'high', model: 'claude-opus-5-5' })
  expect(chunks).toContainEqual({ kind: 'text', index: 0, text: 'from claude' })
})

test('shadow mode logs a take but lets Claude act', async ($, on) => {
  const seen: unknown[] = []
  setup(on, {
    mode: 'shadow',
    messages: [user('open src/app.ts')],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
      next_action: { type: 'choice', choice: 'read src/app.ts', probabilities: { 'read src/app.ts': 0.99, claude: 0.01 }, confidence: 0.95 },
      difficulty: easy,
    }),
  })
  claudeBeneath(on, seen)

  await drain($.turn.step(step))
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatchObject({ effort: 'high' })
})

test('The gate denies a dangerous command nobody asked for', async ($, on) => {
  setup(on, {
    messages: [user('fix the typo in README.md')],
    jev: () => ({
      risk: { type: 'score', score: 1.95, probabilities: { '0': 0, '1': 0.05, '2': 0.95 }, confidence: 0.9 },
      in_scope: { type: 'noul', noul: 0.03 },
    }),
  })
  on('tool.check', () => ({ decision: 'allow' }))

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf ~/' }, tool_use_id: 'toolu_1' })
  expect(verdict.decision).toBe('deny')
})

test('The gate leaves a harmless command alone', async ($, on) => {
  setup(on, {
    messages: [user('what changed?')],
    jev: () => ({
      risk: { type: 'score', score: 0.05, probabilities: { '0': 0.95, '1': 0.05, '2': 0 }, confidence: 0.9 },
      in_scope: { type: 'noul', noul: 0.97 },
    }),
  })
  on('tool.check', () => ({ decision: 'allow' }))

  const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'git status' }, tool_use_id: 'toolu_2' })
  expect(verdict.decision).toBe('allow')
})

test('The done check sends Claude back once when work is unfinished', async ($, on) => {
  setup(on, { messages: [user('rename foo to bar in all files')], jev: () => ({ done: { type: 'noul', noul: 0.04 } }) })
  on('classic.Stop', () => ({}))

  const first = await $.classic.Stop({ stop_hook_active: false, last_assistant_message: 'I renamed it in one file. Want me to do the rest?' })
  expect(first.block).toBeDefined()
  const again = await $.classic.Stop({ stop_hook_active: true, last_assistant_message: 'Done.' })
  expect(again.block).toBeUndefined()
})

// Jev's own calls skip auto mode's classifier: the mod approves them itself,
// but a settings deny rule beneath still wins.
for (const [beneath, expected] of [['ask', 'allow'], ['deny', 'deny']] as const) {
  test(`A call Jev made itself is approved over "${beneath}" → ${expected}`, async ($, on) => {
    setup(on, {
      messages: [user('what does src/app.ts export?')],
      jev: () => ({
        next_action: { type: 'choice', choice: 'read src/app.ts', probabilities: { 'read src/app.ts': 0.97, claude: 0.03 }, confidence: 0.95 },
        difficulty: easy,
      }),
      files: [`${CWD}/src/app.ts`],
    })
    claudeBeneath(on, [])
    on('tool.check', () => ({ decision: beneath }))

    const { chunks } = await drain($.turn.step(step))
    const tool = chunks.find(c => c.kind === 'tool')
    expect(tool).toBeDefined()
    const id = tool && tool.kind === 'tool' ? tool.id : ''

    const own = await $.tool.check({ tool: 'Read', input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: id })
    expect(own.decision).toBe(expected)

    // Claude's own call to the same tool is left to the engine.
    const claudes = await $.tool.check({ tool: 'Read', input: { file_path: `${CWD}/src/app.ts` }, tool_use_id: 'toolu_claude' })
    expect(claudes.decision).toBe(beneath)
  })
}

// Phase 2: every decision is logged, and Claude's own call is compared with Jev's.
const runJev = async ($: Engine, args: string) =>
  String(
    ((await $.command.run({ command: 'jev', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })) as { text?: string })
      .text ?? '',
  )

test('Shadow mode compares Claude’s call with Jev’s top action and reports agreement', async ($, on) => {
  setup(on, {
    mode: 'shadow',
    messages: [user('what does src/app.ts export?')],
    files: [`${CWD}/src/app.ts`],
    jev: () => ({
      next_action: { type: 'choice', choice: 'read src/app.ts', probabilities: { 'read src/app.ts': 0.92, claude: 0.08 }, confidence: 0.9 },
      difficulty: easy,
    }),
  })
  on('turn.step', async function* ($, e) {
    yield { kind: 'tool', index: 0, id: 'toolu_c1', name: 'Read' }
    yield { kind: 'input', index: 0, json: JSON.stringify({ file_path: `${CWD}/src/app.ts` }) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Read', input: { file_path: `${CWD}/src/app.ts` } }], stopReason: 'tool_use', usage: null }
  })

  await drain($.turn.step(step))
  const report = await runJev($, 'report')
  expect(report).toContain('| Steps Jev would have taken (shadow) | **1** |')
  expect(report).toContain('| Agreement with Claude | **1 / 1** (100%) |')
  expect(report).toMatch(/\| \d\d:\d\d \| what does src\/app\.ts export\? \| read src\/app\.ts \| 0\.92 \| Read app\.ts \| ✓ same \|/)
  expect(report).toContain('| **0.85 ← current** | 1 | 100% |')
})

test('Passes are logged too: a "claude" pick, an unchanged route, an allowed command', async ($, on) => {
  setup(on, {
    messages: [user('refactor the auth module to use JWT')],
    files: [],
    jev: q =>
      'risk' in q
        ? { risk: { type: 'score', score: 0.1, probabilities: { '0': 0.9, '1': 0.1, '2': 0 }, confidence: 0.9 }, in_scope: { type: 'noul', noul: 0.9 } }
        : { difficulty: { type: 'score', score: 2.6, probabilities: { '0': 0, '1': 0.05, '2': 0.3, '3': 0.65 }, confidence: 0.6 } },
  })
  claudeBeneath(on, [])
  on('tool.check', () => ({ decision: 'allow' }))

  await drain($.turn.step(step))
  await $.tool.check({ tool: 'Bash', input: { command: 'ls src' }, tool_use_id: 'toolu_3' })
  const report = await runJev($, 'report')
  expect(report).toContain('| Effort routing | 1 turns | avg difficulty 2.60')
  expect(report).toContain('| Gate | 1 calls | 1 allow · 0 ask · 0 deny |')
})

test('Jev can pick a skill on the first step of a turn', async ($, on) => {
  setup(on, {
    messages: [user('write the release notes for this version')],
    jev: () => ({
      next_action: { type: 'choice', choice: 'skill write-release-notes', probabilities: { 'skill write-release-notes': 0.93, claude: 0.07 }, confidence: 0.9 },
      difficulty: easy,
    }),
  })
  on('command.list', () => ({
    value: [
      { name: 'write-release-notes', description: 'Write release notes from the git log', source: 'user' as const },
      { name: 'help', description: 'Show help', source: 'builtin' as const },
    ],
  }))
  on('tool.list', () => ({ value: [] }))
  claudeBeneath(on, [])

  const { chunks } = await drain($.turn.step(step))
  expect(chunks).toContainEqual(expect.objectContaining({ kind: 'tool', name: 'Skill' }))
  expect(chunks).toContainEqual({ kind: 'input', index: 0, json: JSON.stringify({ skill: 'write-release-notes' }) })
})

test('In auto mode the gate also checks calls Claude Code would ask about, and only tightens them', async ($, on) => {
  setup(on, {
    messages: [user('fix the typo in README.md')],
    jev: () => ({
      risk: { type: 'score', score: 1.95, probabilities: { '0': 0, '1': 0.05, '2': 0.95 }, confidence: 0.9 },
      in_scope: { type: 'noul', noul: 0.03 },
    }),
  })
  on('tool.check', () => ({ decision: 'ask' }))

  const risky = await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf ~/' }, tool_use_id: 'toolu_4' })
  expect(risky.decision).toBe('deny')
})

// Phase 3: a simple request is answered by Jev's action plus a small-model summary.
for (const [single, expectBypass] of [[0.95, true], [0.3, false]] as const) {
  test(`Whole-turn bypass ${expectBypass ? 'answers' : 'does not answer'} when single_action=${single}`, async ($, on) => {
    const messages: SessionMessage[] = [user('run the tests')]
    const seen: unknown[] = []
    setup(on, {
      messages,
      packageJson: { scripts: { test: 'node --test' } },
      jev: () => ({
        next_action: { type: 'choice', choice: 'run npm test', probabilities: { 'run npm test': 0.95, claude: 0.05 }, confidence: 0.9 },
        difficulty: easy,
        single_action: { type: 'noul', noul: single },
      }),
    })
    const asked: string[] = []
    on('model.complete', ($, e) => {
      asked.push(e.prompt)
      return {
        value: {
          isAnswered: true as const,
          text: 'All 3 tests passed.',
          usage: { input_tokens: 120, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      }
    })
    claudeBeneath(on, seen)

    // Step 0: Jev runs the tests itself.
    const first = await drain($.turn.step(step))
    const tool = first.chunks.find(c => c.kind === 'tool')
    expect(tool).toBeDefined()
    const id = tool && tool.kind === 'tool' ? tool.id : ''

    // The tool ran; step 1 sees its result.
    messages.push({ role: 'assistant', text: '', toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: 'npm test' }, text: '# tests 3\n# pass 3\n# fail 0' }] })
    messages.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: '# pass 3', isError: false }] })
    const second = await drain($.turn.step({ ...step, index: 1, messageCount: 3 }))

    if (expectBypass) {
      expect(seen).toHaveLength(0)
      expect(second.chunks).toContainEqual({ kind: 'text', index: 0, text: 'All 3 tests passed.' })
      expect(asked[0]).toContain('# pass 3')
      const report = await runJev($, 'report')
      expect(report).toContain('| Turns answered without Claude | **1**')
    } else {
      expect(seen).toHaveLength(1)
      expect(asked).toHaveLength(0)
    }
  })
}

test('Built-in commands are never offered as skills, and a skill that fails is blocklisted', async ($, on) => {
  const offered: string[][] = []
  setup(on, {
    messages: [user('what changed?')],
    jev: q => {
      const options = Object.keys(((q.next_action as { criteria?: object } | undefined)?.criteria ?? {}))
      offered.push(options)
      return {
        next_action: { type: 'choice', choice: 'skill changelog', probabilities: { 'skill changelog': 0.95, claude: 0.05 }, confidence: 0.9 },
        difficulty: easy,
      }
    },
  })
  on('command.list', () => ({
    value: [
      { name: 'diff', description: 'View uncommitted changes', source: 'user' as const },
      { name: 'changelog', description: 'Summarize recent changes', source: 'plugin' as const },
    ],
  }))
  on('tool.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: undefined, isError: true as const, text: 'changelog is not a skill' }))
  claudeBeneath(on, [])

  const { chunks } = await drain($.turn.step(step))
  expect(offered[0]).not.toContain('skill diff')
  expect(offered[0]).toContain('skill changelog')
  const tool = chunks.find(c => c.kind === 'tool')
  const id = tool && tool.kind === 'tool' ? tool.id : ''
  await $.tool.call({ tool: 'Skill', skill: 'changelog', tool_use_id: id } as never)

  await drain($.turn.step({ ...step, turnId: 't2' }))
  expect(offered[1] ?? []).not.toContain('skill changelog')
})
