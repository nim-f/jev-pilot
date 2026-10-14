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

test('a project inside a temp dir can still be read; its transcripts cannot', () => {
  const cwd = '/private/tmp/claude-503/x/scratchpad/ab2/routine-with-1'
  expect(isSafeToOffer(`${cwd}/todo.js`, cwd)).toBe(true)
  expect(isSafeToOffer(`${cwd}/tasks/a1.output`, cwd)).toBe(false)
  expect(isSafeToOffer('/private/tmp/other/notes.txt', cwd)).toBe(false)
})

test('task notifications and reminders are not taken as the request', () => {
  const turn = splitTurn([
    { role: 'user', text: 'run the tests', toolUses: [] },
    { role: 'user', text: '<task-notification>\n<summary>Background command "Run the benchmark" completed</summary>', toolUses: [] },
  ])
  expect(turn?.request).toBe('run the tests')
})

import { dedupeSkills, relevant } from '../hooks/candidates'

const SKILLS = [
  { name: 'youtube-metadata', description: 'Generate optimized YouTube video metadata including titles, tags, and descriptions' },
  { name: 'youtube-plugin:youtube-metadata', description: 'Generate optimized YouTube video metadata including titles, tags, and descriptions' },
  { name: 'anthropic-skills:pdf', description: 'Use this skill whenever the user wants to do anything with PDF files' },
  { name: 'pdf', description: 'Use this skill whenever the user wants to do anything with PDF files' },
  { name: 'i-have-adhd:i-have-adhd', description: 'Shape output for a reader with ADHD' },
  { name: 'chrome-browser', description: 'Read this skill before the first step that uses Claude in Chrome, the browser extension' },
]

test('a skill listed under two names is offered once, unprefixed', () => {
  expect(dedupeSkills(SKILLS).map(s => s.name)).toEqual(['youtube-metadata', 'pdf', 'i-have-adhd:i-have-adhd', 'chrome-browser'])
})

test('only skills related to the prompt are offered', () => {
  const skills = dedupeSkills(SKILLS)
  expect(relevant('can you show me the full list', skills)).toEqual([])
  expect(relevant('run the tests', skills)).toEqual([])
  expect(relevant('write youtube titles for my video', skills).map(s => s.name)).toEqual(['youtube-metadata'])
  expect(relevant('merge these two pdfs', skills).map(s => s.name)).toEqual(['pdf'])
  expect(relevant('open the page in chrome', skills).map(s => s.name)).toEqual(['chrome-browser'])
})

import { commandKey, coversStep } from '../hooks/candidates'

test('commands compare by what they run, not how the output is filtered', () => {
  expect(commandKey("npm test 2>&1 | grep -E '^(ok|not ok)'")).toBe(commandKey('npm test'))
  expect(commandKey('cd /x/todo-app && npm test')).toBe('npm test')
  expect(commandKey('git status; git diff --stat | head -40')).toBe(commandKey('git status --short && git diff --stat'))
  expect(commandKey('git log --oneline -5')).toBe(commandKey('git log --oneline -n 15'))
  expect(commandKey('npm run lint')).not.toBe(commandKey('npm run build'))
  expect(commandKey('git diff')).not.toBe(commandKey('git status --short && git diff --stat'))
})

test('a step matches only when Jev’s one action would replace all of it', () => {
  const jev = { tool: 'Bash', input: { command: 'npm test' } }
  expect(coversStep([{ tool: 'Bash', input: { command: 'npm test 2>&1 | tail -20' } }], jev)).toBe(true)
  expect(coversStep([{ tool: 'Bash', input: { command: 'ls && cat package.json && npm test' } }], jev)).toBe(false)
  expect(coversStep([{ tool: 'Bash', input: { command: 'npm test' } }, { tool: 'Read', input: { file_path: '/a' } }], jev)).toBe(false)
})
