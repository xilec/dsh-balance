import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { exportInput, SESSION_ID, CHILD_ID, GRANDCHILD_ID } from './fixtures/session-cost-history.input.js'

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
const { costHistory, exportFileName, truncateText, EXPORT_DETAILS } = exported.__internals

const lines = (stream) => stream.trimEnd().split('\n').map((line) => JSON.parse(line))

test('the costs export matches its fixture and never carries a word of text', async () => {
  const stream = costHistory({ ...exportInput(), detail: 'costs' })
  const fixture = await readFile(join(here, 'fixtures', 'session-cost-history-costs.ndjson'), 'utf8')
  assert.equal(stream, fixture)
  const records = lines(stream)
  assert.deepEqual(records.map((record) => record.i), records.map((_, index) => index), 'i is the position in the file')
  assert.deepEqual(records.map((record) => record.type), [
    'meta', 'indicator', 'indicator', 'retry', 'usage', 'tool_call', 'compaction', 'usage',
    'indicator', 'subagent_spawn', 'usage', 'subagent_settle', 'subagent_spawn', 'usage', 'subagent_settle',
    'compaction', 'usage', 'usage',
  ], 'the Findings and the Compaction steps take their place in the timeline')
  assert.equal(
    records.some((record) => record.text !== undefined || record.arguments !== undefined || record.truncated !== undefined),
    false,
    'no text field and no truncation flag at the costs level',
  )
  const types = new Set(records.map((record) => record.type))
  for (const text of ['user_message', 'assistant_message', 'assistant_thinking', 'tool_result']) {
    assert.equal(types.has(text), false, `${text} belongs to the full level`)
  }
  for (const record of records) {
    for (const key of ['i', 'type', 'session', 'depth', 'seq', 't']) {
      assert.ok(key in record, `every record carries ${key}`)
    }
  }
  assert.equal(records.slice(1).every((record, index) => record.t >= records[index].t), true, 'the stream is ordered by time')
  const meta = records[0]
  assert.equal(meta.session, SESSION_ID)
  assert.equal(meta.title, 'Make the cost view tell the truth')
  assert.equal(meta.currency, 'CNY')
  assert.equal(meta.detail, 'costs')
  assert.deepEqual(meta.models, ['deepseek-flash', 'deepseek-reasoner'])
  assert.deepEqual(meta.projections, ['fact', 'offPeak', 'peak'])
  assert.equal(meta.rule.sourceUrl, 'https://api-docs.deepseek.com/quick_start/pricing')
  assert.deepEqual(meta.rule.rates.at(-1).rates.flash, { cacheHit: 0.014, cacheMiss: 0.3, output: 1.2 }, 'the rule snapshot travels as the route serves it')
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

test('a grandchild’s markers name the session that spawned it, not the exported root', () => {
  const records = lines(costHistory({ ...exportInput(), detail: 'costs' }))
  const markers = records.filter((record) => record.type === 'subagent_spawn' || record.type === 'subagent_settle')
  const grand = markers.filter((record) => record.child === GRANDCHILD_ID)
  assert.equal(grand.length, 2, 'the grandchild gets both markers')
  for (const marker of grand) {
    assert.equal(marker.session, CHILD_ID, 'its catalog fact belongs to its own parent session')
    assert.equal(marker.depth, 1, 'and sits one level below the exported session')
  }
  assert.equal(markers.filter((record) => record.child === CHILD_ID).every((record) => record.session === SESSION_ID), true)
  const own = records.find((record) => record.type === 'usage' && record.session === GRANDCHILD_ID)
  assert.equal(own.depth, 2, 'while the grandchild’s own records stay two levels down')
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

test('a Finding becomes one indicator record at the Step it starts at', () => {
  const records = lines(costHistory({ ...exportInput(), detail: 'costs' }))
  const rootFindings = exportInput().payload.findings
  const indicators = records.filter((record) => record.type === 'indicator' && record.session === SESSION_ID)
  assert.equal(indicators.length, rootFindings.length, 'one record per Finding, and no more')
  assert.deepEqual(indicators.map((record) => record.kind), ['spike', 'context-growth'])
  const spike = indicators[0]
  assert.equal(spike.t, 1000, 'the instant the first referenced Step starts')
  assert.equal(spike.seq, 5, 'and the sequence of that Step’s own report')
  assert.equal(spike.turn, 1)
  assert.equal(spike.step, 1)
  assert.equal(spike.depth, 0)
  assert.deepEqual(spike.refs, { from: 0, to: 0, turnFrom: 1, stepFrom: 1, turnTo: 1, stepTo: 1 })
  assert.equal(spike.severity, 'alert')
  assert.equal(spike.confidence, 74)
  assert.deepEqual(spike.evidence, {
    metric: 'cost', value: 1.9, threshold: 0.95, via: 'p95', median: 0.9, mad: 0.05, z: 20, p95: 1.9, share: 0.22, sample: 2,
  }, 'the structured evidence travels as the Host reported it')
  const growth = indicators[1]
  assert.deepEqual(growth.refs, { from: 0, to: 1, turnFrom: 1, stepFrom: 1, turnTo: 2, stepTo: 3 }, 'a range Finding keeps its whole range')
  assert.equal(growth.severity, 'warn')

  const child = records.find((record) => record.type === 'indicator' && record.session === CHILD_ID)
  assert.ok(child, 'a child’s Finding is in the same stream')
  assert.equal(child.depth, 1)
  assert.equal(child.kind, 'cache-miss')
  assert.equal(child.t, 2600)
})

test('a compaction becomes its own record, anchored or turn-less', () => {
  const records = lines(costHistory({ ...exportInput(), detail: 'costs' }))
  const compactions = records.filter((record) => record.type === 'compaction')
  assert.deepEqual(compactions.map((record) => record.id), ['cmp-1', 'cmp-2'])
  const anchored = compactions[0]
  assert.equal(anchored.t, 2300, 'its own instant')
  assert.equal(anchored.model, 'deepseek-flash')
  assert.deepEqual(anchored.tokens, { uncachedInput: 3e5, cacheRead: 0, cacheWrite: 0, output: 0 }, 'the summary call’s usage')
  assert.deepEqual(anchored.cost, { fact: 0.3, offPeak: 0.15, peak: 0.3 }, 'priced under all three projections')
  assert.equal(anchored.shadowedTokenCount, 4e5)
  assert.deepEqual(anchored.anchor, { turn: 1, step: null })
  const loose = compactions[1]
  assert.equal(loose.t, 3600)
  assert.equal(loose.turn, null, 'a compaction before the first Turn has no Turn')
  assert.equal(loose.anchor, null, 'and no anchor rather than a made-up one')
  assert.deepEqual(loose.cost, { fact: 0.1, offPeak: 0.05, peak: 0.1 })
  assert.equal(
    records.filter((record) => record.type === 'usage' && record.model === 'deepseek-flash' && record.t === 2400).length, 1,
    'the call it paid for is a usage record of its own, not a Step',
  )
})

test('the new record types keep the merged stream ordered by time and sequence', () => {
  const records = lines(costHistory({ ...exportInput(), detail: 'full' }))
  assert.equal(records[0].type, 'meta', 'meta is first')
  assert.deepEqual(records.map((record) => record.i), records.map((_, index) => index), 'i is the position in the file')
  for (let index = 2; index < records.length; index += 1) {
    const before = records[index - 1]
    const now = records[index]
    assert.ok(before.t <= now.t, `${before.type} at ${before.t} precedes ${now.type} at ${now.t}`)
    if (before.t === now.t) assert.ok((before.seq ?? 0) <= (now.seq ?? 0), 'and the sequence breaks the tie')
  }
  const atSameInstant = records.filter((record) => record.t === 1000 && record.type !== 'meta').map((record) => record.type)
  assert.deepEqual(atSameInstant, ['indicator', 'indicator'], 'the two Findings of the first Step are ordered by their kind’s stable order')
  const markers = records.filter((record) => record.type === 'subagent_spawn' || record.type === 'subagent_settle')
  for (const marker of markers) {
    assert.equal(marker.session, marker.depth === 0 ? SESSION_ID : marker.depth === 1 ? CHILD_ID : GRANDCHILD_ID, 'a marker names the session that owns it')
  }
  const child = records.filter((record) => record.session === CHILD_ID)
  assert.ok(child.every((record) => record.depth === 1), 'and every child record carries its depth')
})

test('the stream leaves through the browser download and never through the file system', async () => {
  const { saveTextFile } = exported.__internals
  const clicks = []
  const removed = []
  const documentStub = {
    body: { appendChild: () => {} },
    createElement: () => {
      const link = {
        href: '',
        download: '',
        click: () => clicks.push(link.download),
        remove: () => removed.push(link.download),
      }
      return link
    },
  }
  const realDocument = globalThis.document
  const realBlob = globalThis.Blob
  const realUrl = globalThis.URL
  globalThis.document = documentStub
  globalThis.Blob = class {
    constructor(parts, options) {
      this.parts = parts
      this.type = options?.type
    }
  }
  const revoked = []
  globalThis.URL = { createObjectURL: (blob) => { assert.equal(blob.type, 'application/x-ndjson'); return 'blob:fixture' }, revokeObjectURL: (url) => revoked.push(url) }
  try {
    assert.equal(saveTextFile('dsh-balance-17d677cb-20260929-1100.cost-history.ndjson', 'stream\n'), true)
    assert.deepEqual(clicks, ['dsh-balance-17d677cb-20260929-1100.cost-history.ndjson'], 'the file is handed to a download, not to a path')
    assert.deepEqual(removed, clicks, 'and the anchor is taken back out of the document')
    // The URL is released on the next task: let it run here, so this test leaves no
    // timer behind for the next one to trip over.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(revoked, ['blob:fixture'], 'and the object URL is released')
  } finally {
    if (realDocument === undefined) delete globalThis.document
    else globalThis.document = realDocument
    globalThis.Blob = realBlob
    globalThis.URL = realUrl
  }
  // The module graph above is the other half of the guarantee: this file's loader throws
  // on any specifier but React, so the export has no way to ask for a file system at all.
})

// --- The writing side, exercised on its own -------------------------------------------------
//
// The goldens above pin the stream byte for byte. These cases pin the properties that make
// the file trustworthy whatever the session holds: it is always valid NDJSON, always finite,
// always deterministic, and it never leaves a broken character or a half-written line.

/** One Step of a synthetic series, with the fields the export reads and nothing else. */
function exportNode(overrides = {}) {
  const { reports = [], ...rest } = overrides
  return {
    kind: 'step',
    turn: 1,
    step: 1,
    tStart: 1000,
    tEnd: 2000,
    ended: true,
    hasUsage: true,
    reports: reports.map((report) => ({
      seq: 1,
      time: 1000,
      model: 'deepseek-flash',
      buckets: { uncachedInput: 1000, cacheRead: 0, cacheWrite: 0, output: 10 },
      cost: 0.25,
      offPeak: { cost: 0.125 },
      peak: { cost: 0.25 },
      ...report,
    })),
    ...rest,
  }
}

/** The stream of one synthetic session, with the export's own defaults for the rest. */
const streamOf = (payload, extra = {}) => costHistory({
  sessionId: 'session-test-0001',
  title: 'test',
  version: '0.1.0',
  detail: 'costs',
  payload: { ok: true, currency: 'CNY', nodes: [], ...payload },
  ...extra,
})

test('every line of the stream is one JSON record, and the file ends with one newline', () => {
  for (const detail of EXPORT_DETAILS) {
    const stream = costHistory({ ...exportInput(), detail })
    assert.equal(stream.endsWith('\n'), true, `${detail}: the file is newline-terminated`)
    assert.equal(stream.endsWith('\n\n'), false, `${detail}: and carries no trailing blank line`)
    assert.equal(stream.includes('\r'), false, `${detail}: no carriage returns`)
    const raw = stream.slice(0, -1).split('\n')
    assert.equal(raw.every((line) => line.trim() !== ''), true, `${detail}: no empty line`)
    for (const [index, line] of raw.entries()) {
      const record = JSON.parse(line)
      assert.equal(record.i, index, `${detail}: record ${index} is stamped with its position`)
      assert.equal(typeof record.type, 'string', `${detail}: and names its type`)
    }
    // A newline inside a text field would break the framing; JSON escapes it instead.
    assert.equal(raw.length, stream.slice(0, -1).split('\n').length, `${detail}: one record per line`)
  }
})

test('a session with a null first instant still writes a frame per record', () => {
  // The projection reports `tEnd: null` while a Step is still running, and the meta of an
  // empty session has no instant at all: neither may turn into an unparsable line.
  const running = streamOf({ nodes: [exportNode({ tEnd: null, ended: false, reports: [{ time: 1000 }] })] }, { detail: 'full' })
  const records = lines(running)
  assert.equal(records[0].t, 1000, 'the meta leads with the first Step instant')
  assert.equal(running.includes('null\n'), false, 'a null instant is a value, not a broken line')
  const empty = lines(streamOf({ nodes: [] }))
  assert.deepEqual(empty.map((record) => record.type), ['meta'], 'an empty session is a meta record alone')
  assert.equal(empty[0].t, null)
  assert.deepEqual(empty[0].models, [])
  assert.equal(empty[0].subagents, false)
})

test('no money or token figure in the stream is null, NaN or a float tail', () => {
  const stream = streamOf({
    nodes: [
      exportNode({ reports: [{ cost: 0.1 + 0.2, buckets: { uncachedInput: 1 / 3, cacheRead: 0, cacheWrite: 0, output: 1e21 } }] }),
      exportNode({ turn: 2, step: 1, tStart: 3000, reports: [{ seq: 4, time: 3000, cost: 0 }] }),
      exportNode({ turn: 2, step: 2, tStart: 4000, reports: [] }),
    ],
  }, { detail: 'full' })
  for (const record of lines(stream)) {
    for (const [key, value] of Object.entries(record.cost ?? {})) {
      assert.equal(Number.isFinite(value), true, `${record.type}.cost.${key} is finite, got ${value}`)
    }
    for (const [key, value] of Object.entries(record.tokens ?? {})) {
      assert.equal(Number.isFinite(value), true, `${record.type}.tokens.${key} is finite, got ${value}`)
    }
  }
  assert.equal(stream.includes('null,"tokens"'), false, 'a missing bucket is not written as null')
  const usage = lines(stream).find((record) => record.type === 'usage')
  assert.deepEqual(usage.cost, { fact: 0.30000000000000004, offPeak: 0.125, peak: 0.25 },
    'the builder copies what the Host priced: rounding happens where the money is computed')
})

test('the detail level is one of the two documented ones, and anything else means costs', () => {
  assert.deepEqual(EXPORT_DETAILS, ['costs', 'full'])
  const base = lines(costHistory({ ...exportInput(), detail: 'costs' }))
  for (const detail of [undefined, 'nonsense', '', null]) {
    const records = lines(costHistory({ ...exportInput(), detail }))
    assert.deepEqual(records, base, `detail ${JSON.stringify(detail)} falls back to costs`)
    assert.equal(records[0].detail, 'costs', 'and the meta says which level the file is')
  }
})

test('the same input always writes the same bytes', () => {
  for (const detail of EXPORT_DETAILS) {
    const first = costHistory({ ...exportInput(), detail })
    const second = costHistory({ ...exportInput(), detail })
    assert.equal(first, second, `${detail}: the export is a pure function of its input`)
  }
})

test('a Finding whose anchor is missing still lands on an instant of the series', () => {
  const payload = {
    currency: 'CNY',
    nodes: [exportNode({ turn: 1, step: 1 }), exportNode({ turn: 1, step: 2, tStart: 5000, reports: [{ seq: 9, time: 5000 }] })],
    findings: [
      { kind: 'spike', refs: { from: 99, to: 99 }, severity: 'alert', confidence: 60, evidence: { share: 0.1 } },
      { kind: 'pricing-gap', severity: 'info', confidence: 20, evidence: { share: 0.2 } },
    ],
  }
  const indicators = lines(streamOf(payload)).filter((record) => record.type === 'indicator')
  assert.equal(indicators.length, 2, 'both Findings are exported')
  for (const record of indicators) {
    assert.equal(record.t, 1000, 'an out-of-range anchor falls back to the first Step, not to null')
    assert.equal(record.turn, 1)
  }
  assert.equal(indicators[1].refs, undefined, 'a Finding without refs is written without them rather than crashing')
})

test('a child with no payload still gets both markers and a settle of zero', () => {
  const records = lines(streamOf({ nodes: [exportNode()] }, { children: [{ id: 'child-orphan', depth: 1 }] }))
  const spawn = records.find((record) => record.type === 'subagent_spawn')
  const settle = records.find((record) => record.type === 'subagent_settle')
  assert.equal(spawn.child, 'child-orphan')
  assert.equal(spawn.mode, 'unknown', 'an unread child is not dressed up as a known mode')
  assert.equal(spawn.t, null, 'and has no instant to claim')
  assert.equal(settle.cost, 0, 'an unread child settles at zero rather than at a guess')
  assert.equal(records.at(-1).type, 'subagent_settle', 'records with no instant sort last')
})

test('the settle of a child is rounded to the money precision, not left as a float tail', () => {
  const records = lines(streamOf({ nodes: [exportNode()] }, {
    children: [{ id: 'child-1', depth: 1, payload: { currency: 'CNY', nodes: [
      exportNode({ reports: [{ cost: 0.1 }] }),
      exportNode({ turn: 1, step: 2, tStart: 3000, reports: [{ seq: 3, time: 3000, cost: 0.2 }] }),
    ] } }],
  }))
  assert.equal(records.find((record) => record.type === 'subagent_settle').cost, 0.3, '0.1 + 0.2 is written as 0.3')
})

test('a call read in full replaces the projection’s short record instead of doubling it', () => {
  const calls = [{ name: 'bash', callId: 'call-1', seq: 3, time: 1500, preview: '{"command":"ls"}' }]
  const text = [{ type: 'tool_call', callId: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}', seq: 3, t: 1500, turn: 1, step: 1 }]
  const full = lines(streamOf({ nodes: [exportNode({ calls })] }, { detail: 'full', text }))
  const fullCalls = full.filter((record) => record.type === 'tool_call')
  assert.equal(fullCalls.length, 1, 'one record per call')
  assert.equal(fullCalls[0].arguments, '{"command":"ls -la"}', 'and the full level keeps the arguments')
  assert.equal(fullCalls[0].preview, undefined, 'never the preview beside them')
  const costs = lines(streamOf({ nodes: [exportNode({ calls })] }))
  const shortCalls = costs.filter((record) => record.type === 'tool_call')
  assert.equal(shortCalls.length, 1, 'the costs level still says a call happened')
  assert.equal(shortCalls[0].arguments, undefined, 'without the text')
  assert.equal(shortCalls[0].name, 'bash')
  assert.equal(shortCalls[0].callId, 'call-1')
})

test('a long text is cut at 2000 characters and the cut never splits a character', () => {
  const emoji = '🙂'
  const text = [{ type: 'assistant_message', text: `${'a'.repeat(1999)}${emoji}${emoji}tail`, seq: 2, t: 1200, turn: 1, step: 1 }]
  const record = lines(streamOf({ nodes: [exportNode()] }, { detail: 'full', text })).find((entry) => entry.type === 'assistant_message')
  assert.equal(record.truncated, true)
  assert.equal(record.text.endsWith('\ud83d'), false, 'the cut does not leave half of a surrogate pair')
  assert.equal([...record.text].every((character) => character !== '\ufffd'), true)
  assert.equal(record.text.length <= 2000, true)
  // A cut that lands exactly on the boundary keeps the character whole.
  const exact = truncateText(`${'b'.repeat(1998)}${emoji}${'c'.repeat(10)}`)
  assert.equal(exact.text.endsWith(emoji), true, '1998 characters plus one two-unit character fits in 2000')
  assert.equal(exact.text.length, 2000)
})

test('text keeps every character it was given: quotes, backslashes, newlines and control codes', () => {
  const raw = 'line one\nline "two"\tback\\slash \u0001 end 🙂'
  const text = [{ type: 'assistant_message', text: raw, seq: 2, t: 1200, turn: 1, step: 1 }]
  const stream = streamOf({ nodes: [exportNode()] }, { detail: 'full', text })
  assert.equal(stream.split('\n').length, lines(stream).length + 1, 'the embedded newline does not break the framing')
  const record = lines(stream).find((entry) => entry.type === 'assistant_message')
  assert.equal(record.text, raw, 'the text round-trips exactly')
  assert.equal(record.truncated, false)
})

test('the stream stays linear: forty thousand Steps are written in one pass', (t) => {
  const series = (size) => Array.from({ length: size }, (_, index) => exportNode({
    turn: Math.floor(index / 50) + 1,
    step: (index % 50) + 1,
    tStart: 1000 + index * 10,
    reports: [{ seq: index + 1, time: 1000 + index * 10 }],
  }))
  const streamOnce = (size) => {
    const started = process.hrtime.bigint()
    const text = streamOf({ nodes: series(size), findings: [] })
    return { text, elapsed: Number(process.hrtime.bigint() - started) / 1e6 }
  }
  // The two sizes are measured alternately rather than one after the other, and each is
  // scored on its quickest run. Both halves of that matter under load: alternating means
  // the machine the small series was timed on is the machine the large one was, and a
  // minimum is the only summary of a noisy measurement that a slower neighbour cannot
  // inflate. The sizes are large enough that one run is milliseconds long, because a
  // series measured in a fraction of a millisecond is a measurement of the scheduler.
  const SMALL = 10_000
  const LARGE = 40_000
  const RUNS = 12
  let small = { text: '', elapsed: Number.POSITIVE_INFINITY }
  let large = { text: '', elapsed: Number.POSITIVE_INFINITY }
  for (let run = 0; run < RUNS; run += 1) {
    const smallRun = streamOnce(SMALL)
    small = smallRun.elapsed < small.elapsed ? smallRun : small
    const largeRun = streamOnce(LARGE)
    large = largeRun.elapsed < large.elapsed ? largeRun : large
  }
  const records = lines(large.text)
  assert.equal(records.length, LARGE + 1, 'a meta record plus one usage record per Step')
  assert.equal(records.at(-1).i, LARGE, 'the last record is stamped with the last position')
  assert.equal(lines(small.text).length, SMALL + 1, 'and the tenth of it wrote one record per Step too')
  const ratio = large.elapsed / small.elapsed
  // The budget this case was written for is a *complexity* one, and that is what it now
  // asserts: four times the Steps must not cost anything like sixteen times the work.
  // Linear work measures a ratio near 4 and tops out around 6 under a dozen concurrent
  // copies of the suite, and the deliberate O(n²) this was checked against measures 16,
  // so the threshold sits between the two with room for each. A ratio is taken between
  // two measurements interleaved into one loop, so load moves both ends of it together,
  // which a fixed millisecond ceiling cannot do: this assertion read 2.7 s under six
  // concurrent copies of the suite on a change that was not a regression. The absolute
  // figures are still reported, so a change that made the export uniformly slower is
  // visible without being able to turn a colleague's machine red.
  t.diagnostic(`costHistory: ${SMALL} Steps ${small.elapsed.toFixed(1)} ms, ${LARGE} Steps ${large.elapsed.toFixed(1)} ms, ratio ${ratio.toFixed(1)}`)
  assert.ok(ratio < 12,
    `writing ${LARGE} Steps cost ${ratio.toFixed(1)}× what ${SMALL} Steps cost, so the export is no longer linear in the series length`)
})

test('the export name survives odd session ids and a bad clock', () => {
  const at = new Date(2026, 8, 24, 15, 17)
  assert.equal(exportFileName('session-', at), 'dsh-balance-unknown-20260924-1517.cost-history.ndjson', 'a prefix with no id is unknown, not empty')
  assert.equal(exportFileName('session-1234567890', at), 'dsh-balance-12345678-20260924-1517.cost-history.ndjson', 'eight characters at most')
  assert.equal(exportFileName(42, at), 'dsh-balance-unknown-20260924-1517.cost-history.ndjson', 'a non-string id is unknown')
  assert.equal(
    exportFileName('SESSION-ABC', at).includes('/'), false,
    'the name stays a file name whatever the id holds',
  )
  const broken = exportFileName('session-abc', new Date(Number.NaN))
  assert.equal(broken.includes('NaN'), false, `a clock the browser cannot read does not leak NaN: ${broken}`)
})

test('the download needs a document, releases its object URL and cleans up even when the click throws', async () => {
  const { saveTextFile } = exported.__internals
  const realDocument = globalThis.document
  const realBlob = globalThis.Blob
  const realUrl = globalThis.URL
  try {
    // No document and no Blob: a Node process, or a shell that never mounted a DOM.
    delete globalThis.document
    const realBlobValue = globalThis.Blob
    delete globalThis.Blob
    assert.equal(saveTextFile('file.ndjson', 'stream\n'), false, 'without a document there is no download')
    globalThis.Blob = realBlobValue

    globalThis.Blob = class {
      constructor(parts, options) {
        this.parts = parts
        this.type = options?.type
      }
    }
    const revoked = []
    const appends = []
    const removed = []
    let thrown = null
    globalThis.URL = {
      createObjectURL: (blob) => {
        // The text must reach the blob as it was written, framing newline included.
        assert.deepEqual(blob.parts, ['a\nb\n'])
        return 'blob:one'
      },
      revokeObjectURL: (url) => revoked.push(url),
    }
    globalThis.document = {
      body: { appendChild: (link) => appends.push(link.download) },
      createElement: () => ({
        href: '',
        download: '',
        click() { throw new Error('a browser refused the click') },
        remove() { removed.push('removed') },
      }),
    }
    assert.throws(() => saveTextFile('file.ndjson', 'a\nb\n'), /refused the click/, 'the failure is not swallowed')
    assert.deepEqual(appends, ['file.ndjson'], 'the anchor was added')
    assert.equal(removed.length, 1, 'and taken back out even though the click threw')
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(revoked, ['blob:one'], 'the object URL is released on the next task')
  } finally {
    if (realDocument === undefined) delete globalThis.document
    else globalThis.document = realDocument
    globalThis.Blob = realBlob
    globalThis.URL = realUrl
  }
})
