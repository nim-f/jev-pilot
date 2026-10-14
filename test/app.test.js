import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, greet } from '../src/app.js'

test('add', () => assert.equal(add(2, 3), 5))
test('greet', () => assert.equal(greet('Jev'), 'Hello, Jev!'))
