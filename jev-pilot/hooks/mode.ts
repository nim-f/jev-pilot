import type { EngineInterface } from 'claude-code'

export type Mode = 'active' | 'shadow' | 'off'
export const MODES: readonly Mode[] = ['active', 'shadow', 'off']

/** `/jev <mode>` stored in $.store wins over the configured mode. */
export async function currentMode($: EngineInterface, configured: unknown): Promise<Mode> {
  const m = (await $.store.get('mode')) ?? configured
  return MODES.includes(m as Mode) ? (m as Mode) : 'active'
}
