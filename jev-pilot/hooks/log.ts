import type { EngineInterface } from 'claude-code'

// Every Jev decision, agreeing or not, goes to a capped log in $.store so
// shadow runs can be compared with what Claude did and thresholds tuned.
export type Kind = 'take' | 'compare' | 'route' | 'gate' | 'done' | 'outcome' | 'turn' | 'bypass' | 'error'

export type Entry = {
  at: number
  kind: Kind
  /** Whether the decision changed what happened (false in shadow mode or for a pass). */
  applied: boolean
  text: string
  ms?: number
  turnId?: string
  data?: Record<string, unknown>
}

const LOG_KEY = 'log'
const MAX_ENTRIES = 1000

// This session's entries, for the short `/jev` view; a hot reload starts it over.
const recent: Entry[] = []

export async function record($: EngineInterface, d: Omit<Entry, 'at'>) {
  const entry: Entry = { ...d, at: await $.clock.now() }
  recent.push(entry)
  if (recent.length > 50) recent.shift()

  const log = ((await $.store.get(LOG_KEY)) as Entry[] | undefined) ?? []
  await $.store.set(LOG_KEY, [...log, entry].slice(-MAX_ENTRIES))

  const stats = ((await $.store.get('stats')) as Record<string, number> | undefined) ?? {}
  const key = d.applied ? d.kind : `${d.kind}:pass`
  await $.store.set('stats', { ...stats, [key]: (stats[key] ?? 0) + 1 })

  if (d.kind !== 'outcome' && d.kind !== 'turn') $.ui.status(`jev: ${d.text}`.slice(0, 80))
}

export function recentDecisions() {
  return recent.slice()
}

export async function readLog($: EngineInterface): Promise<Entry[]> {
  return ((await $.store.get(LOG_KEY)) as Entry[] | undefined) ?? []
}

export async function clearLog($: EngineInterface) {
  await $.store.set(LOG_KEY, [])
  await $.store.set('stats', {})
}

export async function stats($: EngineInterface) {
  return ((await $.store.get('stats')) as Record<string, number> | undefined) ?? {}
}
