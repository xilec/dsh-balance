import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSamples, serializeSamples } from '../src/history.js'
import { appendSample, readSamplesCompacting, writeState } from '../src/store.js'

const HOUR_MS = 60 * 60_000

/** A state directory under a throwaway home, removed afterwards. */
async function withDir(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-store-'))
  const dir = join(home, 'dsh-balance')
  await mkdir(dir, { recursive: true })
  try {
    return await run(dir)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

const sampleLine = (t, total) => `${JSON.stringify({ t, currency: 'CNY', total, granted: 0, toppedUp: total })}\n`

test('two concurrent writes of the state document both land', async () => {
  await withDir(async (dir) => {
    // The routes write this file concurrently by design. One temp name per process
    // meant the first rename moved it away and the second failed ENOENT, so one of
    // every pair of writes was lost while its caller was told it had landed.
    for (let pair = 0; pair < 30; pair += 1) {
      const first = { version: 1, overrides: { [`2026-09-${String(pair).padStart(2, '0')}`]: { amount: pair } } }
      const second = { version: 1, overrides: { [`2026-09-${String(pair).padStart(2, '0')}`]: { amount: pair, marker: 'second' } } }
      const settled = await Promise.allSettled([writeState(dir, first), writeState(dir, second)])
      const rejected = settled.filter((outcome) => outcome.status === 'rejected')
      assert.deepEqual(rejected.map((outcome) => outcome.reason?.code ?? outcome.reason?.message), [],
        `pair ${pair} lost a write`)
    }
    // Whatever the interleaving, the document on disk is one whole write and never a
    // blend of the two.
    const stored = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(stored.version, 1)
    assert.ok(typeof stored.overrides === 'object')
  })
})

test('a concurrent write resolves and leaves no temp file behind', async () => {
  await withDir(async (dir) => {
    // Both writes complete — the old single temp name made the second `rename` fail
    // ENOENT — and each temp file is moved into place by its own write.
    await Promise.all([writeState(dir, { version: 1, overrides: {} }), writeState(dir, { version: 1, overrides: { a: 1 } })])
    const { readdir } = await import('node:fs/promises')
    const names = await readdir(dir)
    assert.deepEqual(names.filter((name) => name.endsWith('.tmp')), [])
  })
})

test('a failed append does not wedge the sample queue', async () => {
  await withDir(async (dir) => {
    const blocked = join(dir, 'samples.ndjson')
    await mkdir(blocked, { recursive: true })
    // The log is a directory here, so every append to it fails.
    await assert.rejects(appendSample(dir, { t: 1, currency: 'CNY', total: 1 }))
    await rm(blocked, { recursive: true, force: true })
    await appendSample(dir, { t: 2, currency: 'CNY', total: 2 })
    assert.deepEqual(parseSamples(await readFile(blocked, 'utf8')).map((s) => s.t), [2])
  })
})

test('an append issued while the log is compacted survives the rewrite', async () => {
  await withDir(async (dir) => {
    const now = Date.now()
    // A log big enough that the compaction rewrite is still in flight when a short
    // append lands: without the queue the rewrite drops the line it never read.
    const old = []
    for (let i = 0; i < 40_000; i += 1) {
      old.push({ t: now - 40 * 24 * HOUR_MS + i * 60_000, currency: 'CNY', total: 100 - i / 1000, granted: 0, toppedUp: 100 })
    }
    await writeFile(join(dir, 'samples.ndjson'), serializeSamples(old), 'utf8')
    // The append is issued while the compaction is still reading, and the two settle in
    // an order: the rewrite reads, thins and renames first, and only then does the append
    // write. Ordering is the invariant — whether an unqueued rewrite happens to swallow
    // the line is a race against the file read, and a test that waits for a race is a
    // test that passes on the code it is meant to catch.
    const order = []
    const compaction = readSamplesCompacting(dir, { keepDays: 7 }).then((kept) => {
      order.push('rewrite')
      return kept
    })
    await appendSample(dir, { t: now, currency: 'CNY', total: 99, granted: 0, toppedUp: 99 }).then(() => {
      order.push('append')
    })
    const kept = await compaction
    assert.deepEqual(order, ['rewrite', 'append'], 'the append ran after the rewrite, never during it')
    assert.ok(kept.length < old.length, 'so the rewrite really did run and thin the log')
    const stored = parseSamples(await readFile(join(dir, 'samples.ndjson'), 'utf8'))
    assert.equal(stored.at(-1).t, now, 'and the appended sample is the newest line of the rewritten log')
  })
})

test('a log with a torn tail line is still read from its newest lines', async () => {
  await withDir(async (dir) => {
    const now = Date.now()
    const lines = [sampleLine(now - 3 * HOUR_MS, 10), sampleLine(now - 2 * HOUR_MS, 9.5)]
    // A crash mid-append leaves a half-written last line, with no newline of its own.
    await writeFile(join(dir, 'samples.ndjson'), `${lines.join('')}{"t":${now},"currency":"CN`, 'utf8')
    const all = await readSamplesCompacting(dir, { keepDays: 7 })
    assert.deepEqual(all.map((s) => s.total), [10, 9.5], 'a torn tail line is simply dropped')
    // The limit counts lines, not parsed samples, so a damaged line inside the window
    // costs a sample rather than being made up for by an older one: the cap is there to
    // bound what is materialised, and reading more to fill the gap would undo that.
    const capped = await readSamplesCompacting(dir, { keepDays: 7, maxSamples: 2 })
    assert.deepEqual(capped.map((s) => s.total), [9.5], 'a damaged line in the window costs a sample from the result')
  })
})

test('a log longer than the cap is read from its tail', async () => {
  await withDir(async (dir) => {
    const now = Date.now()
    const lines = []
    for (let i = 0; i < 50; i += 1) lines.push(sampleLine(now - (50 - i) * 60_000, i))
    await writeFile(join(dir, 'samples.ndjson'), lines.join(''), 'utf8')
    const kept = await readSamplesCompacting(dir, { keepDays: 3650, maxSamples: 10 })
    assert.deepEqual(kept.map((s) => s.total), [40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
  })
})

test('an untouched log is left exactly as it is', async () => {
  await withDir(async (dir) => {
    const now = Date.now()
    const lines = [sampleLine(now - 2 * HOUR_MS, 10), sampleLine(now - HOUR_MS, 9.5)]
    await writeFile(join(dir, 'samples.ndjson'), lines.join(''), 'utf8')
    const before = await stat(join(dir, 'samples.ndjson'))
    const kept = await readSamplesCompacting(dir, { keepDays: 7 })
    assert.deepEqual(kept.map((s) => s.total), [10, 9.5])
    const after = await stat(join(dir, 'samples.ndjson'))
    assert.equal(after.mtimeMs, before.mtimeMs, 'nothing was thinned, so nothing was rewritten')
  })
})
