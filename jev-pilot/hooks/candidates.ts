import type { EngineInterface, SessionMessage, ToolUseSummary } from 'claude-code'

// Actions Jev may take itself. Code builds the list; Jev only picks from it, so
// every argument is a known value and never generated text.
export type Candidate = {
  /** Option key shown to Jev, e.g. `read src/app.ts` or `run npm test`. */
  key: string
  description: string
  tool: 'Read' | 'Bash' | 'Skill' | 'ToolSearch'
  input: Record<string, unknown>
}

const MAX_READS = 8
const MAX_SEARCHES = 3
const SAFE_SCRIPT = /^(test|tests|lint|build|typecheck|type-check|check|test:[\w:-]+|lint:[\w:-]+)$/
// Built-in CLI commands the command list can report as user commands but the
// Skill tool refuses (`/diff` did). Failed skills are also blocklisted at run time.
export const BUILTIN_COMMANDS = new Set(
  ('add-dir agents bug clear compact config context cost diff doctor exit export help hooks ide init ' +
    'install-github-app login logout mcp memory model permissions plugin pr-comments release-notes resume ' +
    'review rewind status statusline terminal-setup theme upgrade usage vim').split(' '),
)

export const SKILL_BLOCKLIST_KEY = 'skillBlocklist'

const SAFE_MAKE = /^(test|tests|check|lint|build|typecheck)$/
// Paths like src/app.ts, ./README.md, /abs/x.json: something with a file extension.
const PATH = /(?:^|[\s`'"(\[])((?:~|\.{1,2})?\/?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`'"),:;\]])/g
// Terms the user quoted: `useAuth`, "TODO: fix".
const QUOTED = /`([^`\n]{3,60})`|"([^"\n]{3,60})"/g

export function mentionedPaths(texts: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(PATH)) {
      const p = m[1]!
      if (/^\d/.test(p) || /^https?:/.test(p) || p.includes('..')) continue
      seen.add(p)
    }
  }
  return [...seen]
}

export function quotedTerms(text: string): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(QUOTED)) {
    const term = (m[1] ?? m[2] ?? '').trim()
    if (term.length >= 3 && !term.includes("'") && !/^[\w./@~-]+\.[A-Za-z]{1,8}$/.test(term)) seen.add(term)
  }
  return [...seen].slice(0, MAX_SEARCHES)
}

// Never offered for reading: Claude Code's temp and task folders (a subagent's
// `.output` file is its whole transcript and floods the context), system temp
// dirs, and Claude's own config tree.
const UNSAFE_PATH = /(^|\/)(tmp|private\/tmp|private\/var\/folders|var\/folders)\/|\/\.claude\/|\/tasks\/[^/]+\.output$|\.output$|\.jsonl$/
// Inside the project only transcripts are refused, so a project that lives in
// a temp dir (a scratch copy, a benchmark) can still be read.
const TRANSCRIPT = /\/tasks\/[^/]+\.output$|\.output$|\.jsonl$/
export const isSafeToOffer = (file: string, cwd?: string) =>
  cwd && file.startsWith(`${cwd}/`) ? !TRANSCRIPT.test(file) : !UNSAFE_PATH.test(file)

const absolute = (cwd: string, p: string) => (p.startsWith('/') ? p : `${cwd}/${p.replace(/^\.\//, '')}`)

export function sameCall(a: { tool: string; input: Record<string, unknown> }, b: { tool: string; input: Record<string, unknown> }) {
  if (a.tool !== b.tool) return false
  if (a.tool === 'Read') return a.input.file_path === b.input.file_path
  if (a.tool === 'Bash') return String(a.input.command).trim() === String(b.input.command).trim()
  if (a.tool === 'Skill') return a.input.skill === b.input.skill
  if (a.tool === 'ToolSearch') return a.input.query === b.input.query
  return false
}

/**
 * What a shell command does, for comparison: each `&&`/`;`/newline part, cut
 * at its first pipe (`| tail`, `| grep` only filter the output), without
 * redirections, `cd` and `echo`, reduced to its command words (flags, paths
 * and numbers dropped). `git status; git diff --stat 2>&1 | head` and
 * `git status --short && git diff --stat` both give `git diff|git status`.
 */
export function commandKey(command: string): string {
  const parts = new Set<string>()
  for (const raw of command.split(/&&|\|\||;|\n/)) {
    const seg = raw.split(/(?<!\|)\|(?!\|)/)[0]!.replace(/\d?>&\d|\d?>\s*\/dev\/null/g, '').trim()
    if (!seg || /^(cd|echo|printf|set|export)\b/.test(seg)) continue
    const tokens = seg.split(/\s+/)
    const words = [tokens[0]!, ...tokens.slice(1).filter(t => /^[a-z][\w:-]*$/.test(t))]
    parts.add(words.slice(0, words[1] === 'run' || words[1] === 'exec' ? 3 : 2).join(' '))
  }
  return [...parts].sort().join('|')
}

/** Same action: identical, or for shell commands the same `commandKey`. */
export function equivalentCall(a: { tool: string; input: Record<string, unknown> }, b: { tool: string; input: Record<string, unknown> }) {
  if (sameCall(a, b)) return true
  if (a.tool !== 'Bash' || b.tool !== 'Bash') return false
  const ka = commandKey(String(a.input.command ?? ''))
  return ka !== '' && ka === commandKey(String(b.input.command ?? ''))
}

/** Jev's action would have replaced Claude's whole step: one call, equivalent. */
export function coversStep(claude: readonly { tool: string; input: Record<string, unknown> }[], jev: { tool: string; input: Record<string, unknown> }) {
  return claude.length === 1 && equivalentCall(claude[0]!, jev)
}

const bash = (command: string, description: string): Candidate => ({
  key: `run ${command}`,
  description,
  tool: 'Bash',
  input: { command, description },
})

export async function buildCandidates(
  $: EngineInterface,
  request: string,
  steps: readonly SessionMessage[],
  calls: readonly ToolUseSummary[],
  stepIndex: number,
): Promise<Candidate[]> {
  const cwd = await $.session.cwd()
  const out: Candidate[] = []
  const has = (file: string) => $.fs.exists(`${cwd}/${file}`).catch(() => false)

  // Files named in the request or the turn's text/tool output, not yet read this turn.
  const texts = [request, ...steps.map(m => m.text), ...calls.map(c => c.text ?? '')]
  const alreadyRead = new Set(calls.filter(c => c.tool === 'Read').map(c => String(c.input.file_path)))
  let reads = 0
  for (const p of mentionedPaths(texts)) {
    if (reads >= MAX_READS) break
    if (p.startsWith('~')) continue
    const file = absolute(cwd, p)
    if (alreadyRead.has(file) || !isSafeToOffer(file, cwd)) continue
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat?.kind !== 'file' || stat.size > 2_000_000) continue
    out.push({ key: `read ${p}`, description: `Read the file ${p}`, tool: 'Read', input: { file_path: file } })
    reads += 1
  }

  // Searches for terms the user quoted.
  for (const term of quotedTerms(request)) {
    out.push(bash(`grep -rnF --exclude-dir=node_modules --exclude-dir=.git -- '${term}' .`, `Search the project for the text "${term}"`))
  }

  // Read-only git commands.
  if (await has('.git')) {
    // One "what changed" option: status and diff --stat as two options split
    // Jev's probability (0.75/0.24 live); merged it reaches 0.93.
    out.push(bash('git status --short && git diff --stat', 'Show what changed: which files are modified, staged or untracked, with a per-file count of changed lines'))
    out.push(bash('git diff', 'Show the full line-by-line diff of unstaged changes'))
    out.push(bash('git log --oneline -n 15', 'Show the 15 most recent commits'))
  }

  // The project's own safe scripts and test runners.
  const pkg = await $.fs.read(`${cwd}/package.json`).catch(() => undefined)
  if (typeof pkg === 'string') {
    let scripts: Record<string, string> = {}
    try {
      scripts = (JSON.parse(pkg) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch {}
    const runner = await packageRunner($, cwd)
    for (const name of Object.keys(scripts).filter(n => SAFE_SCRIPT.test(n))) {
      const command = name === 'test' ? `${runner} test` : `${runner} run ${name}`
      out.push(bash(command, `Run the project's "${name}" script (${clipScript(scripts[name]!)})`))
    }
  }
  const makefile = await $.fs.read(`${cwd}/Makefile`).catch(() => undefined)
  if (typeof makefile === 'string') {
    const targets = new Set([...makefile.matchAll(/^([A-Za-z][\w-]*):(?!=)/gm)].map(m => m[1]!))
    for (const t of [...targets].filter(t => SAFE_MAKE.test(t))) out.push(bash(`make ${t}`, `Run the Makefile's "${t}" target`))
  }
  if (await has('Cargo.toml')) {
    out.push(bash('cargo test', 'Run the Rust tests'))
    out.push(bash('cargo check', 'Type-check the Rust project'))
    out.push(bash('cargo clippy', 'Lint the Rust project'))
  }
  if (await has('go.mod')) {
    out.push(bash('go test ./...', 'Run the Go tests'))
    out.push(bash('go vet ./...', 'Vet the Go code'))
    out.push(bash('go build ./...', 'Build the Go packages'))
  }
  if ((await has('pytest.ini')) || (await has('conftest.py')) || /\[tool\.pytest/.test(String(await $.fs.read(`${cwd}/pyproject.toml`).catch(() => '')))) {
    out.push(bash('python -m pytest -q', 'Run the Python tests'))
  }

  // First move of a turn only: a skill to invoke, or a deferred tool to load.
  if (stepIndex === 0) {
    const commands = await $.command.list().catch(() => [])
    const blocked = new Set(((await $.store.get(SKILL_BLOCKLIST_KEY).catch(() => undefined)) as string[] | undefined) ?? [])
    const allSkills = dedupeSkills(
      commands.filter(c => (c.source === 'plugin' || c.source === 'user') && c.name !== 'jev' && !BUILTIN_COMMANDS.has(c.name) && !blocked.has(c.name)),
    )
    // Every skill when the prompt is about skills; otherwise only related ones.
    const skills = /\bskills?\b/i.test(request) ? allSkills : relevant(request, allSkills)
    for (const c of skills) {
      out.push({ key: `skill ${c.name}`, description: `Use the skill or command "${c.name}": ${clipScript(c.description)}`, tool: 'Skill', input: { skill: c.name } })
    }
    const loaded = new Set(calls.filter(c => c.tool === 'ToolSearch').map(c => String(c.input.query)))
    const tools = (await $.tool.list().catch(() => [])).filter(t => t.mcp && !AUTH_TOOL.test(t.name) && !loaded.has(`select:${t.name}`))
    for (const t of relevant(request, tools)) {
      out.push({ key: `load ${t.name}`, description: `Load the tool ${t.name}: ${clipScript(t.description)}`, tool: 'ToolSearch', input: { query: `select:${t.name}`, max_results: 1 } })
    }
  }

  // Jev's choice API takes at most 255 options, one of them "claude".
  return out.slice(0, 254)
}

// MCP sign-in tools are never the next step of a coding turn.
const AUTH_TOOL = /__(authenticate|complete_authentication)$/
const MAX_RELATED = 8
// Words too common in prompts and skill descriptions to show a relation.
const STOPWORDS = new Set(
  ('the and for with this that these those when what which where how why who any all can could would should will ' +
    'you your use used using user users from into onto about over than then them they its it\'s are was were has have ' +
    'had not but also only just some more most very like want need make made create new get set show see one two ' +
    'file files read run runs tool tools skill skills command commands claude code project before after first step ' +
    'please let lets now ok okay yes here there out other each every such via per our we me my is be to of in on at ' +
    'an a or do does did done if so as by up no').split(' '),
)

/** Lowercase content words, light-stemmed so changes/changed/change match. */
export function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue
    const stem = w.replace(/(ing|ed|es|e|s)$/, '')
    out.add(stem.length >= 3 && !w.endsWith('ss') ? stem : w)
  }
  return out
}

/**
 * Skills and tools whose name or description shares words with the prompt,
 * best first. A name word counts double; one description word alone is not
 * enough, so generic overlaps ("document", "video") need a second word.
 */
export function relevant<T extends { name: string; description: string }>(prompt: string, items: readonly T[]): T[] {
  const want = words(prompt)
  if (!want.size) return []
  const scored = items.map(item => {
    const name = words(item.name.replace(/^mcp__/, '').replace(/[_:]+/g, ' '))
    const desc = words(item.description)
    let score = 0
    for (const w of want) score += name.has(w) ? 2 : desc.has(w) ? 1 : 0
    return { item, score }
  })
  return scored
    .filter(s => s.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELATED)
    .map(s => s.item)
}

/**
 * One entry per skill: `anthropic-skills:pdf` and `pdf`, or `youtube-metadata`
 * and `youtube-plugin:youtube-metadata`, are the same skill listed twice. The
 * unprefixed name wins.
 */
export function dedupeSkills<T extends { name: string }>(skills: readonly T[]): T[] {
  const base = (n: string) => n.slice(n.lastIndexOf(':') + 1)
  const byBase = new Map<string, T>()
  for (const s of skills) {
    const kept = byBase.get(base(s.name))
    if (!kept || (kept.name.includes(':') && !s.name.includes(':'))) byBase.set(base(s.name), s)
  }
  return skills.filter(s => byBase.get(base(s.name)) === s)
}

const clipScript = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s)

async function packageRunner($: EngineInterface, cwd: string) {
  for (const [file, runner] of [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']] as const) {
    if (await $.fs.exists(`${cwd}/${file}`).catch(() => false)) return runner
  }
  return 'npm'
}
