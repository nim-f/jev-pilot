import type { Entry } from './log'

// `/jev report` as Markdown tables: a summary, Jev vs Claude step by step, the
// take threshold, then routing, gate and done check. Pure, so tests can feed it
// entries directly.

const THRESHOLDS = [0.6, 0.7, 0.8, 0.85, 0.9, 0.95]
const STEP_ROWS = 15

const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—')
const num = (v: unknown) => (typeof v === 'number' ? v : undefined)
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const p2 = (v: number | undefined) => (v === undefined ? '—' : v.toFixed(2))
const cell = (s: string, max = 48) => {
  const one = s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
const bar = (n: number, of: number, width = 10) => {
  const filled = of ? Math.round((n / of) * width) : 0
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const pad = (n: number) => String(n).padStart(2, '0')
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Local `HH:MM`, with `MM-DD` in front when not on the same day as `latest`. */
export function when(at: number, latest: number): string {
  const d = new Date(at)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return day(d) === day(new Date(latest)) ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

export type Verdict = 'match' | 'differ' | 'missed' | 'both-claude'

/**
 * How one compared step went, at a given take threshold:
 * - Jev would take its action → `match` when Claude made the same call, else `differ`.
 * - Jev leaves it to Claude → `both-claude` when Claude used none of the listed
 *   actions (agreement), `missed` when Claude did use one.
 */
export function verdict(e: Entry, threshold: number): Verdict {
  const bestP = num(e.data?.bestP) ?? 0
  const wouldTake = str(e.data?.best) !== undefined && bestP >= threshold
  if (wouldTake) return e.data?.agree === true ? 'match' : 'differ'
  return e.data?.claudeUsedCandidate === true ? 'missed' : 'both-claude'
}

const MARK: Record<Verdict, string> = { match: '✓ same', 'both-claude': '✓ Claude', differ: '✗ differ', missed: '⚠ missed' }

/** What Claude did, from the compare entry (short form for older entries). */
function claudeDid(e: Entry): string {
  const summary = str(e.data?.claudeSummary)
  if (summary) return summary
  const tools = (e.data?.claude as string[] | undefined) ?? []
  if (!tools.length) return 'replied'
  const counts = new Map<string, number>()
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ')
}

export function buildReport(log: readonly Entry[], threshold: number, mode = ''): string {
  if (!log.length) return '**Jev pilot report:** the log is empty. Use Claude for a while (try `/jev shadow`) and run `/jev report` again.'
  const of = (kind: Entry['kind']) => log.filter(e => e.kind === kind)
  const out: string[] = []
  const since = new Date(log[0]!.at).toISOString().slice(0, 16).replace('T', ' ')

  const takes = of('take')
  const taken = takes.filter(e => e.applied)
  const wouldTake = takes.filter(e => !e.applied && e.data?.wouldTake === true)
  const compares = of('compare')
  const verdicts = compares.map(e => verdict(e, threshold))
  const agreed = verdicts.filter(v => v === 'match' || v === 'both-claude').length
  const errored = of('outcome').filter(e => e.data?.isError === true)
  const timed = log.map(e => e.ms).filter((m): m is number => typeof m === 'number')
  const avgMs = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : undefined

  out.push('## Jev pilot report')
  out.push(`_${log.length} log entries since ${since}${mode ? ` · mode **${mode}**` : ''} · take threshold **${threshold}**_`)
  out.push('')
  out.push('| | |')
  out.push('|---|---|')
  out.push(`| Steps Jev took itself | **${taken.length}** (≈ ${taken.length} Claude requests saved${errored.length ? `, ${errored.length} failed` : ''}) |`)
  const bypassed = of('bypass').filter(e => e.applied)
  out.push(`| Steps Jev would have taken (shadow) | **${wouldTake.length}** |`)
  out.push(`| Turns answered without Claude | **${bypassed.length}** (Jev's action + ${bypassed.length ? 'Haiku' : 'a small model'} summary) |`)
  out.push(`| Agreement with Claude | **${agreed} / ${compares.length}** (${pct(agreed, compares.length)}) |`)
  out.push(`| Jev latency | ${avgMs === undefined ? '—' : `${avgMs} ms average`} over ${timed.length} calls · ${of('error').length} errors |`)

  // Jev vs Claude, step by step.
  if (compares.length) {
    out.push('', `### Jev vs Claude, step by step${compares.length > STEP_ROWS ? ` (last ${STEP_ROWS})` : ''}`)
    const latest = log[log.length - 1]!.at
    out.push('| Time | Request | Jev would | p | Claude did | |')
    out.push('|---|---|---|---|---|---|')
    compares.slice(-STEP_ROWS).forEach(e => {
      const v = verdict(e, threshold)
      const best = str(e.data?.best)
      const jev = v === 'match' || v === 'differ' ? best! : `leave to Claude${best ? ` _(best: ${best})_` : ''}`
      const p = v === 'match' || v === 'differ' ? num(e.data?.bestP) : num(e.data?.bestP)
      out.push(`| ${when(e.at, latest)} | ${cell(str(e.data?.request) ?? '—', 40)} | ${cell(jev, 56)} | ${p2(p)} | ${cell(claudeDid(e), 40)} | ${MARK[v]} |`)
    })
    out.push('', '_✓ same: Jev would make the same call · ✓ Claude: both leave it to Claude · ✗ differ: Jev would act differently · ⚠ missed: Claude used an action Jev had listed_')
  }

  // Take threshold.
  const scored = compares.filter(e => num(e.data?.bestP) !== undefined)
  if (scored.length) {
    out.push('', '### Take threshold')
    out.push('| Threshold | Would take | Same call as Claude | |')
    out.push('|---|---|---|---|')
    for (const t of THRESHOLDS) {
      const hit = scored.filter(e => num(e.data?.bestP)! >= t)
      const ok = hit.filter(e => e.data?.agree === true).length
      const current = Math.abs(t - threshold) < 1e-9
      out.push(`| ${current ? `**${t.toFixed(2)} ← current**` : t.toFixed(2)} | ${hit.length} | ${pct(ok, hit.length)} | \`${bar(ok, hit.length)}\` |`)
    }
  }

  // Routing, gate, done check.
  const routes = of('route')
  const scores = routes.map(e => num(e.data?.score)).filter((s): s is number => s !== undefined)
  const lowered = routes.filter(e => e.data?.lowered === true)
  const gates = of('gate')
  const by = (d: string) => gates.filter(e => e.data?.decision === d)
  const dones = of('done')
  const continued = dones.filter(e => e.data?.continued === true)
  out.push('', '### Routing, gate and done check')
  out.push('| Decision | Checked | Result |')
  out.push('|---|---|---|')
  out.push(`| Effort routing | ${routes.length} turns | avg difficulty ${scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2) : '—'} (0 trivial … 3 hard) · ${lowered.length} lowered, ${lowered.filter(e => e.applied).length} applied |`)
  out.push(`| Gate | ${gates.length} calls | ${by('allow').length} allow · ${by('ask').length} ask · ${by('deny').length} deny |`)
  out.push(`| Done check | ${dones.length} stops | ${continued.length} unfinished, ${continued.filter(e => e.applied).length} sent back |`)
  const classified = of('classify')
  if (classified.length) {
    const kinds = new Map<string, number>()
    for (const e of classified) kinds.set(str(e.data?.kind) ?? '?', (kinds.get(str(e.data?.kind) ?? '?') ?? 0) + 1)
    const hinted = classified.filter(e => (num(e.data?.hints) ?? 0) > 0)
    out.push(`| Prompt classifier | ${classified.length} prompts | ${[...kinds].map(([k, n]) => `${n} ${k}`).join(' · ')} · ${hinted.length} hinted, ${hinted.filter(e => e.applied).length} applied |`)
  }
  const agents = of('agent')
  if (agents.length) {
    const switched = agents.filter(e => e.data?.switched === true)
    out.push(`| Subagent type | ${agents.length} spawns | ${agents.filter(e => e.data?.agree === true).length} agreed with Claude · ${switched.length} switched, ${switched.filter(e => e.applied).length} applied |`)
  }
  const compacts = of('compact')
  if (compacts.length) {
    const sum = (k: string) => compacts.reduce((a, e) => a + (num(e.data?.[k]) ?? 0), 0)
    out.push(`| Compaction | ${compacts.length} runs | ${sum('items')} results scored · ${sum('keep')} kept in detail · ${sum('drop')} marked droppable |`)
  }

  const flagged = [...by('ask'), ...by('deny')].slice(-5)
  if (flagged.length) {
    out.push('', '**Recent asks and denies**')
    const latest = log[log.length - 1]!.at
    for (const e of flagged) out.push(`- ${when(e.at, latest)} ${e.applied ? '' : '_(shadow)_ '}\`${cell(e.text, 80)}\``)
  }

  const aborted = of('turn').filter(e => e.data?.reason === 'aborted').length
  if (aborted) out.push('', `_${aborted} interrupted turn(s)._`)
  return out.join('\n')
}
