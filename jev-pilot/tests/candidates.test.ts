import { expect, test } from 'claude-code/testing'
import { mentionedPaths, quotedTerms } from '../hooks/candidates'
import { buildReport } from '../hooks/report'

test('quoted terms become searches, file names do not', () => {
  expect(quotedTerms('where is `useAuth` used? and "TODO: fix" in `src/app.ts`')).toEqual(['useAuth', 'TODO: fix'])
  expect(quotedTerms("don't search `it's`")).toEqual([])
})

test('paths with extensions are found in text', () => {
  expect(mentionedPaths(['look at src/app.ts and ./README.md, not v1.2 or https://x.io/a.js'])).toEqual(['src/app.ts', './README.md'])
})

test('an empty log gives a hint, not a crash', () => {
  expect(buildReport([], 0.85)).toContain('the log is empty')
})

import { splitTurn } from '../hooks/context'

test('shell output and slash-command rows are not taken as the request', () => {
  const turn = splitTurn([
    { role: 'user', text: 'delete the folder /tmp/x', toolUses: [] },
    { role: 'user', text: '<bash-input>mkdir -p /tmp/x</bash-input>', toolUses: [] },
    { role: 'user', text: '<bash-stdout>(Bash completed with no output)</bash-stdout>', toolUses: [] },
  ])
  expect(turn?.request).toBe('delete the folder /tmp/x')
})

import { when } from '../hooks/report'

test('times show HH:MM, with the date when not on the latest entry’s day', () => {
  const latest = new Date(2026, 9, 14, 15, 30).getTime()
  expect(when(new Date(2026, 9, 14, 9, 5).getTime(), latest)).toBe('09:05')
  expect(when(new Date(2026, 9, 13, 23, 59).getTime(), latest)).toBe('10-13 23:59')
})

import { isSafeToOffer } from '../hooks/candidates'

test('temp, task-output and Claude config paths are never offered for reading', () => {
  expect(isSafeToOffer('/private/tmp/claude-503/-Users-x/abc/tasks/a889.output')).toBe(false)
  expect(isSafeToOffer('/tmp/jev-gate-test/notes.txt')).toBe(false)
  expect(isSafeToOffer('/Users/nimf/.claude/settings.json')).toBe(false)
  expect(isSafeToOffer('/Users/nimf/Work/jev-demo/todo-app/todo.js')).toBe(true)
})
