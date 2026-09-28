import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { exportInput, SESSION_ID } from './fixtures/session-cost-history.input.js'

/**
 * The export is assembled in the browser from what the routes returned, so the whole
 * stream is a pure function — and this is the golden test that pins it (D39, D45).
 * Pixels are still verified by hand in the running shell.
 */

const here = dirname(fileURLToPath(import.meta.url))

async function loadClient() {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  await import(`../client/client.js?export=${Math.random()}`)
  assert.equal(registrations.length, 1)
  // The module asks for React at load time; the builder never renders, so a stub is
  // enough to reach it.
  const react = { createElement: () => null, memo: (component) => component, useState: (value) => [value, () => {}] }
  return registrations[0].factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require(${specifier})`)
  })
}

const exported = await loadClient()
const { costHistory, exportFileName, truncateText } = exported.__internals

const lines = (stream) => stream.trimEnd().split('\n').map((line) => JSON.parse(line))

test('the costs export matches its fixture and never carries a word of text', async () => {
  const stream = costHistory({ ...exportInput(), detail: 'costs' })
  const fixture = await readFile(join(here, 'fixtures', 'session-cost-history-costs.ndjson'), 'utf8')
  assert.equal(stream, fixture)
  const records = lines(stream)
  assert.deepEqual(records.map((record) => record.i), records.map((_, index) => index), 'i is the position in the file')
  assert.deepEqual(records.map((record) => record.type), [
    'meta', 'retry', 'usage', 'tool_call', 'subagent_spawn', 'usage', 'subagent_settle', 'usage',
  ])
  assert.equal(records.some((record) => record.field !== undefined), false, 'no text fields at the costs level')
  const types = new Set(records.map((record) => record.type))
  for (const text of ['user_message', 'assistant_message', 'assistant_thinking', 'tool_result']) {
    assert.equal(types.has(text), false, `${text} belongs to the full level`)
  }
  for (const record of records.slice(1)) {
    for (const key of ['i', 'type', 'session', 'depth', 'seq', 't']) {
      assert.ok(key in record, `every record carries ${key}`)
    }
  }
})

test('the full export matches its fixture, truncates long text and marks it', async () => {
  const stream = costHistory({ ...exportInput(), detail: 'full' })
  const fixture = await readFile(join(here, 'fixtures', 'session-cost-history-full.ndjson'), 'utf8')
  assert.equal(stream, fixture)
  const records = lines(stream)
  const long = records.find((record) => record.type === 'assistant_message' && record.session === SESSION_ID)
  assert.equal(long.text.length, 2000)
  assert.equal(long.truncated, true)
  const call = records.find((record) => record.type === 'tool_call')
  assert.equal(call.truncated, true, 'tool arguments are cut by the same rule')
  assert.equal(call.arguments.length, 2000)
  const result = records.find((record) => record.type === 'tool_result')
  assert.equal(result.truncated, false)
  assert.equal(result.callId, 'call-1', 'a result points back at its call')
  assert.equal(result.isError, false)
  const thinking = records.find((record) => record.type === 'assistant_thinking')
  assert.equal(thinking.truncated, false, 'short text is passed through and not flagged')
  assert.equal(thinking.text, 'count the calls first')
})

test('the stream mixes a child session into the parent’s timeline', () => {
  const records = lines(costHistory({ ...exportInput(), detail: 'costs' }))
  const spawn = records.find((record) => record.type === 'subagent_spawn')
  const settle = records.find((record) => record.type === 'subagent_settle')
  const childUsage = records.find((record) => record.type === 'usage' && record.session !== SESSION_ID)
  assert.equal(spawn.child, childUsage.session)
  assert.equal(spawn.t, 2600, 'the spawn sits at the child’s creation instant')
  assert.equal(settle.child, childUsage.session)
  assert.equal(settle.cost, 0.5, 'the settle records what the child cost, at the money precision')
  assert.equal(childUsage.depth, 1, 'a child is one level below the exported session')
  assert.ok(spawn.t <= childUsage.t && childUsage.t <= settle.t, 'the child’s records sit between spawn and settle')
  assert.ok(records.findIndex((record) => record.type === 'subagent_spawn') < records.findIndex((record) => record.type === 'usage' && record.session !== SESSION_ID))
  assert.equal(records.findIndex((record) => record.type === 'subagent_settle') > records.findIndex((record) => record.type === 'usage' && record.session !== SESSION_ID), true)
})

test('the retry record carries what the lost attempt would have cost, marked unbilled', () => {
  const records = lines(costHistory({ ...exportInput(), detail: 'costs' }))
  const retry = records.find((record) => record.type === 'retry')
  assert.equal(retry.billed, false)
  assert.equal(retry.cost.fact, 1)
  assert.equal(retry.cost.offPeak, 0.5)
  assert.deepEqual(retry.tokens, { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 })
})

test('the export name is the documented one and the clock is local', () => {
  const at = new Date(2026, 8, 24, 15, 17)
  assert.equal(exportFileName(SESSION_ID, at), 'dsh-balance-17d677cb-20260924-1517.cost-history.ndjson')
  assert.equal(exportFileName('392960ac-1111-2222-3333-444455556666', at), 'dsh-balance-392960ac-20260924-1517.cost-history.ndjson')
  assert.equal(exportFileName('', at), 'dsh-balance-unknown-20260924-1517.cost-history.ndjson')
  assert.equal(exportFileName(SESSION_ID, new Date(2026, 0, 2, 3, 4)), 'dsh-balance-17d677cb-20260102-0304.cost-history.ndjson')
  assert.equal(exportFileName('session-abc', at), 'dsh-balance-abc-20260924-1517.cost-history.ndjson', 'a short id is not padded')
})

test('the truncation rule is a plain 2000 characters', () => {
  assert.deepEqual(truncateText('short'), { text: 'short', truncated: false })
  assert.deepEqual(truncateText('x'.repeat(2000)), { text: 'x'.repeat(2000), truncated: false })
  assert.deepEqual(truncateText('x'.repeat(2001)), { text: 'x'.repeat(2000), truncated: true })
  assert.deepEqual(truncateText(undefined), { text: '', truncated: false })
})
