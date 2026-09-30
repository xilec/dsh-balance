import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { dayKeyOf, parseSamples } from '../src/history.js'
import { BJT_OFFSET_MS, OFF_PEAK_RATIO } from '../src/pricing.js'

/** One instant, as a Beijing-time calendar field, in epoch milliseconds. */
const bjt = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min) - BJT_OFFSET_MS

/**
 * The home the plugin writes under when a test does not name one itself.
 *
 * A test that reached the store without setting `$DSH_HOME` resolved the harness
 * home to the developer's real `~/.dsh` and wrote there, and a helper's own
 * save/restore of the variable is a convention rather than a guarantee. This is
 * the guarantee: a missing override becomes a throwaway directory instead. The
 * directory is left in place on purpose — nothing deletes a home here, least of
 * all a real one, and a deleted suite home would leave every later test pointing
 * at a path that is not there.
 */
const SUITE_HOME = mkdtempSync(join(tmpdir(), 'dsh-balance-suite-home-'))

/** Whether `path` lies inside `dir`, without the prefix-match traps. */
function inside(dir, path) {
  const step = relative(dir, path)
  return step !== '' && !step.startsWith('..') && !isAbsolute(step)
}

/**
 * Point a missing `$DSH_HOME` at the throwaway suite home, leaving a chosen one alone.
 *
 * A blank value counts as missing: the harness reads one as unset, so the net
 * cannot treat it as a decision.
 *
 * @param env - the environment mapping to read and write.
 * @returns the home in effect afterwards.
 */
function ensureSuiteHome(env = process.env) {
  if (env.DSH_HOME === undefined || env.DSH_HOME.trim() === '') env.DSH_HOME = SUITE_HOME
  return env.DSH_HOME
}

/** The home the process brought with it, and the one the plugin therefore sees. */
const inheritedHome = process.env.DSH_HOME
const suiteHome = ensureSuiteHome()

/** A request stub that emits an optional JSON body. */
function request(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', JSON.stringify(body))
    req.emit('end')
  })
  return req
}

/**
 * A response stub capturing status and body.
 *
 * It also carries what a real `ServerResponse` carries for the one thing the subtree
 * route reads: `writableEnded`, and the `close` event a lost connection emits. A stub
 * without them cannot tell a reader that went away from a request that was answered.
 */
function response() {
  const res = new EventEmitter()
  Object.assign(res, {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) {
      res.status = status
    },
    end(text) {
      res.body = text ?? ''
      res.writableEnded = true
    },
  })
  return res
}

/** A minimal Host context: effect, inject, get, and a route table. */
function hostContext(options = {}) {
  const routes = new Map()
  const projections = []
  const services = new Map([
    ['webServer', {
      register(route) {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    }],
    ['sessionProjections', {
      register(definition) {
        projections.push(definition)
        return () => {}
      },
      snapshot() {
        return { values: {} }
      },
      stateOf(session, key) {
        return options.projectionState?.(session, key)
      },
    }],
    ['sessions', { get: (id) => options.sessionOf?.(id) }],
  ])
  if (options.readSession !== undefined) {
    services.set('sessionQuery', {
      readSession: (id) => options.readSession(id),
      // A title is optional in the payload, so the stub offers only what a test asked for.
      ...(options.readTitle === undefined ? {} : { readTitle: (id) => options.readTitle(id) }),
    })
  }
  if (options.subagents !== undefined) services.set('subagents', options.subagents)
  const effects = []
  const warns = []
  return {
    routes,
    projections,
    effects,
    warns,
    logger: { info() {}, warn(message) { warns.push(message) } },
    get: (key) => services.get(key),
    effect(fn, label) {
      const disposer = fn()
      effects.push({ disposer, label })
    },
    inject(keys, callback) {
      if (!keys.every((key) => services.has(key))) return
      // Cordis hands the callback a context scoped to the injected keys.
      const scoped = Object.create(this)
      for (const key of keys) scoped[key] = services.get(key)
      callback(scoped)
    },
    dispose() {
      for (const { disposer } of effects) if (typeof disposer === 'function') disposer()
    },
  }
}

/**
 * Yield to the real event loop until `reached` holds, or fail naming what never came.
 *
 * A wait written as a fixed number of `setImmediate` hops is a timeout wearing a loop's
 * clothes: it passes on a fast machine and expires on a loaded one, and the suite goes
 * red on a colleague's box for a reason that has nothing to do with the code. This waits
 * on the event instead, and `turns` is a backstop against hanging forever rather than the
 * thing being asserted.
 *
 * @param reached - the condition to wait for; awaited, so it may be async.
 * @param what - what the wait was for, named in the failure.
 * @param turns - how many event-loop hops to allow before giving up.
 * @returns nothing; it resolves once `reached` holds.
 */
async function eventually(reached, what, turns = 20_000) {
  for (let turn = 0; turn < turns; turn += 1) {
    if (await reached()) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(`gave up after ${turns} event-loop turns waiting for ${what}`)
}

/**
 * Advance a mocked clock in steps, yielding after each, until `reached` holds.
 *
 * The mocked clock says *when* a timer may fire; the real event loop says how long the
 * work that timer starts takes to get through its own awaits and its file writes. A test
 * that ticks N times and counts what it got therefore measures the machine, not the loop.
 * This advances until the loop has actually done the thing.
 *
 * @param t - the test context whose `mock.timers` are enabled.
 * @param reached - the condition to wait for.
 * @param what - what the wait was for, named in the failure.
 * @param stepMs - how far to advance the clock per step.
 * @returns nothing; it resolves once `reached` holds.
 */
async function ticking(t, reached, what, stepMs = 1000) {
  await eventually(() => {
    t.mock.timers.tick(stepMs)
    return reached()
  }, what)
}

/** A balance endpoint response. */
const balanceBody = (total, extra = {}) => ({
  is_available: true,
  balance_infos: [{
    currency: 'CNY',
    total_balance: String(total),
    granted_balance: '0',
    topped_up_balance: String(total),
    ...extra,
  }],
})

async function withPlugin(run, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  let body = balanceBody(12.34)
  globalThis.fetch = async () => ({ ok: true, json: async () => body })
  const ctx = hostContext(options)
  try {
    const module = await import(`../src/index.js?home=${encodeURIComponent(home)}`)
    const config = module.Config({ apiKey: 'test-key', ...(options.config ?? {}) })
    module.apply(ctx, config)
    await run({ ctx, module, config, home, setBalance: (value, extra) => { body = balanceBody(value, extra) } })
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
}

/**
 * The payload the read route answers with.
 *
 * A test that needs a day of the ledger takes its key from here rather than writing a
 * date down: the ledger is a rolling window measured from today, so a date written into a
 * test leaves the window as the calendar moves on and the row under test stops existing.
 */
async function readPayload(ctx) {
  const res = response()
  await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), res)
  return JSON.parse(res.body)
}

/**
 * Read `state.json` until it says what the caller is waiting for.
 *
 * The heartbeat route persists without awaiting, so a test that wants to see its write
 * has to go on looking. How long to keep looking is the caller's business, not a
 * duration the test guesses: `reached` is the condition, and this returns as soon as the
 * document satisfies it. The read itself yields, so the write in flight gets its turns.
 *
 * @param home - the harness home the plugin was given.
 * @param reached - the condition on the parsed document to wait for.
 * @param what - what the wait was for, named if it never comes.
 * @returns the document that satisfied `reached`.
 */
async function readStateWhen(home, reached, what = 'the state document to be written') {
  const { readFile } = await import('node:fs/promises')
  const path = join(home, 'dsh-balance', 'state.json')
  let stored = {}
  // One read per event-loop turn, with no sleep between them: a sleep is a guess about
  // how long a write takes, and this way the loop costs exactly as many turns as the
  // write needs. A document that is not there yet is simply not the one being waited
  // for — the first write of a fresh home creates the file.
  await eventually(async () => {
    try {
      stored = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      return false
    }
    return reached(stored)
  }, what)
  return stored
}

test('a missing DSH_HOME becomes a throwaway home, a chosen one is left alone', () => {
  assert.equal(ensureSuiteHome({}), SUITE_HOME, 'a test that sets no home gets the suite one')
  assert.equal(ensureSuiteHome({ DSH_HOME: '' }), SUITE_HOME, 'so does a blank one, which the harness reads as unset')
  assert.equal(ensureSuiteHome({ DSH_HOME: '   ' }), SUITE_HOME, 'and one holding nothing but whitespace')
  assert.equal(ensureSuiteHome({ DSH_HOME: '/tmp/a-home-of-my-own' }), '/tmp/a-home-of-my-own', 'a home the caller named is not overruled')
  assert.ok(inside(tmpdir(), SUITE_HOME), 'the suite home is under the system temp directory')
  assert.equal(inside(join(homedir(), '.dsh'), SUITE_HOME), false, 'and never inside the real harness home')
  // The net is wired into the module, not merely defined next to it: this process is
  // the evidence, and the value is the inherited one when the environment had it.
  assert.equal(suiteHome, inheritedHome ?? SUITE_HOME)
})

test('a run that names no DSH_HOME writes under the suite home', {
  skip: inheritedHome !== undefined && 'the environment supplies a DSH_HOME, so the suite home is not ours to write to',
}, async () => {
  // The shape of the mistake this file once made: no home of its own, so the net
  // decides. Every per-test helper above and below sets one and restores it, which
  // is the convention; this is what happens to the test that does not.
  const previousFetch = globalThis.fetch
  const ctx = hostContext()
  globalThis.fetch = async () => ({ ok: true, json: async () => balanceBody(12.34) })
  try {
    const module = await import(`../src/index.js?suite-home=${encodeURIComponent(SUITE_HOME)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key' }))
    // Both of the store's paths, so the assertion covers the sample log and the
    // state document rather than whichever one this run happened to touch.
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const saved = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { costMetric: 'output' }), saved)
    assert.equal(saved.status, 200, saved.body)
    // The whole of what the run wrote, read from the home the net named. A path is
    // what is asserted, not a real directory: the developer's own home is never
    // opened here, and the suite home stays on disk so nothing is left pointing at
    // a home that is gone.
    const dir = join(suiteHome, 'dsh-balance')
    const written = (await readdir(dir)).sort()
    assert.deepEqual(written, ['samples.ndjson', 'state.json'], 'the run wrote its two files and nothing else')
    assert.equal(inside(join(homedir(), '.dsh'), dir), false, 'the store it wrote to is not the developer home')
  } finally {
    ctx.dispose()
    globalThis.fetch = previousFetch
  }
})

test('the plugin registers its routes and its projection unit', async () => {
  await withPlugin(async ({ ctx, module }) => {
    assert.deepEqual(
      [...ctx.routes.keys()].sort(),
      ['/dsh-balance', '/dsh-balance/hello', '/dsh-balance/overrides', '/dsh-balance/refresh', '/dsh-balance/session-cost', '/dsh-balance/session-cost/children', '/dsh-balance/session-cost/text', '/dsh-balance/settings'],
    )
    assert.equal(ctx.projections.length, 1)
    assert.equal(ctx.projections[0].key, 'dshBalanceCost')
    // The defaults have to satisfy the module's own schema.
    assert.equal(module.Config({}).currency, 'USD')
    assert.equal(module.Config({}).refreshIntervalMs, 300000)
  })
})

test('a refresh samples the balance and the read route reports the ledger', async () => {
  await withPlugin(async ({ ctx, setBalance }) => {
    const res = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), res)
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.balance.primary.total, 12.34)
    assert.equal(payload.balance.ok, true)
    assert.equal(payload.ledger.sampleCount, 1)
    assert.equal(payload.peak.rule.holidays.length, 33)
    assert.equal(payload.prices.current['deepseek-flash'].currency, 'CNY')
    assert.equal(payload.session, null)

    setBalance(10.34)
    const second = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), second)
    const after = JSON.parse(second.body)
    assert.equal(after.ledger.sampleCount, 2)
    assert.equal(after.ledger.totals.d1.amount, 2)
    assert.equal(after.ledger.rows.at(-1).spend, 2)
  })
})

test('an override replaces one day and survives a reload', async () => {
  await withPlugin(async ({ ctx, home }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const ledger = JSON.parse(response().body || '{}')
    void ledger
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    const day = JSON.parse(read.body).ledger.todayKey

    const written = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: day, amount: 4.5 }), written)
    assert.equal(written.status, 200)
    assert.equal(JSON.parse(written.body).ledger.rows.at(-1).spend, 4.5)

    // A fresh plugin instance reads the override back from disk.
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.overrides[day].amount, 4.5)
    assert.ok(state.overrides[day].at > 0, 'the correction instant is stored')
    assert.equal(state.overrides[day].balance, 12.34, 'and the balance it was anchored to')
    assert.equal(JSON.parse(written.body).ledger.rows.at(-1).override, 4.5)
  })
})

test('the overrides route rejects a malformed day and a negative amount', async () => {
  await withPlugin(async ({ ctx }) => {
    const bad = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: 'yesterday', amount: 1 }), bad)
    assert.equal(bad.status, 400)
    const negative = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: '2026-09-24', amount: -1 }), negative)
    assert.equal(negative.status, 400)
    const cleared = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: '2026-09-24', amount: null }), cleared)
    assert.equal(cleared.status, 200)
    assert.deepEqual(JSON.parse(cleared.body).overrides, {})
  })
})

test('the overrides route rejects a day the history cannot hold', async () => {
  const day = Date.now()
  const DAY = 86_400_000
  // The window is the sample retention (`keepDays`, 120 by default) plus a day of slack for
  // a reader whose ledger zone is ahead of the Host's clock. Both bounds are the ledger's own
  // day keys, which is what the panel sends.
  const oldest = dayKeyOf(day - 119 * DAY, 'local')
  const tomorrow = dayKeyOf(day + DAY, 'local')
  const today = dayKeyOf(day, 'local')
  await withPlugin(async ({ ctx, home }) => {
    const post = (body) => {
      const res = response()
      return ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', body), res).then(() => res)
    }
    // Every one of these is a well-formed `YYYY-MM-DD` and every one of them was a permanent
    // key in the state document, re-read on every start, for a day no row can ever carry.
    for (const date of ['9999-99-99', '0001-01-01', dayKeyOf(day + 14 * DAY, 'local')]) {
      const res = await post({ date, amount: 1 })
      assert.equal(res.status, 400, `${date} is not a day the history can hold`)
      assert.equal(JSON.parse(res.body).ok, false)
      assert.match(JSON.parse(res.body).error, /^date /, 'the error names the offending field')
    }
    const { readFile } = await import('node:fs/promises')
    // Nothing is written until a write lands, and a rejected write lands nothing.
    const stored = async () => {
      try {
        return JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8')).overrides
      } catch {
        return {}
      }
    }
    assert.deepEqual(await stored(), {}, 'and nothing was stored for any of them')

    // The ends of the window are accepted, so a reader correcting the oldest ledger day is not
    // turned away by the bound.
    assert.equal((await post({ date: oldest, amount: 1 })).status, 200)
    assert.equal((await post({ date: tomorrow, amount: 1 })).status, 200)
    assert.equal((await post({ date: today, amount: 1 })).status, 200)
    assert.deepEqual(Object.keys(await stored()).sort(), [oldest, today, tomorrow].sort())

    // A removal is not a storage decision: it can only shrink the document, so a reader
    // clearing a correction they once made for a day the retention has since passed is served.
    const removed = await post({ date: '2019-05-05', amount: null })
    assert.equal(removed.status, 200)
    assert.deepEqual(Object.keys(await stored()).sort(), [oldest, today, tomorrow].sort())
  })
})

test('the stored corrections are bounded, oldest first', async () => {
  const day = Date.now()
  const DAY = 86_400_000
  // `keepDays` at its schema maximum, so the window is wide enough to write past the cap:
  // the bound has to be its own rule, not a side effect of the window.
  await withPlugin(async ({ ctx, home }) => {
    const { readFile } = await import('node:fs/promises')
    const post = async (date, amount) => {
      const res = response()
      await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date, amount }), res)
      return res
    }
    // Oldest day first, so the write that fills the document past its bound is the newest day.
    for (let i = 400; i >= 0; i -= 1) {
      const res = await post(dayKeyOf(day - i * DAY, 'local'), 400 - i)
      assert.equal(res.status, 200, res.body)
    }
    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(Object.keys(state.overrides).length, 400, 'the document holds as many corrections as the longest ledger can show')
    const oldest = dayKeyOf(day - 400 * DAY, 'local')
    const newest = dayKeyOf(day, 'local')
    assert.equal(state.overrides[oldest], undefined, 'the correction furthest back is the one that went')
    assert.equal(state.overrides[newest].amount, 400, 'and the one just written is among those kept')
  }, { config: { keepDays: 3650 } })
})

test('a correction written for the oldest day still survives a full document', async () => {
  const day = Date.now()
  const DAY = 86_400_000
  await withPlugin(async ({ ctx, home }) => {
    const { readFile } = await import('node:fs/promises')
    const post = async (date, amount) => {
      const res = response()
      await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date, amount }), res)
      return res
    }
    for (let i = 400; i >= 1; i -= 1) assert.equal((await post(dayKeyOf(day - i * DAY, 'local'), i)).status, 200)
    // The document is full and the reader reaches for the oldest day it still has samples for:
    // the write is answered `ok: true`, so it cannot be the one the bound drops.
    const oldest = dayKeyOf(day - 401 * DAY, 'local')
    const answered = await post(oldest, 401)
    assert.equal(answered.status, 200, answered.body)
    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.overrides[oldest].amount, 401, 'the correction just written is in the document')
    assert.equal(Object.keys(state.overrides).length, 400)
    assert.equal(state.overrides[dayKeyOf(day - 400 * DAY, 'local')], undefined, 'and the oldest of the rest went in its place')
  }, { config: { keepDays: 3650 } })
})

test('a day zone the runtime cannot use is refused, and one it can is applied', async () => {
  await withPlugin(async ({ ctx }) => {
    const read = () => {
      const res = response()
      return ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), res).then(() => JSON.parse(res.body))
    }
    const before = await read()
    const unusable = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { dayZone: 'Mars/Olympus' }), unusable)
    assert.equal(unusable.status, 400)
    assert.match(JSON.parse(unusable.body).error, /dayZone/, 'the error names the offending key')
    assert.equal((await read()).ledger.zone, before.ledger.zone, 'and the zone the ledger reads in is unchanged')

    const usable = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { dayZone: 'Asia/Kolkata' }), usable)
    assert.equal(usable.status, 200)
    assert.deepEqual(JSON.parse(usable.body).changed, ['dayZone'])
    assert.equal((await read()).ledger.zone, 'Asia/Kolkata', 'a zone the runtime can use is the one the payload reports')
  })
})

test('a day zone from the composition row the runtime cannot use falls back honestly', async () => {
  await withPlugin(async ({ ctx }) => {
    const res = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), res)
    const payload = JSON.parse(res.body)
    // The ledger falls back to the Host's own zone for a name no formatter accepts, so the
    // payload has to report that zone rather than the one that failed.
    assert.equal(payload.ledger.zone, 'local')
  }, { config: { dayZone: 'Mars/Olympus' } })
})

test('a correction is anchored to the instant its balance was read', async () => {
  await withPlugin(async ({ ctx, home, setBalance }) => {
    const { readFile } = await import('node:fs/promises')
    const pause = () => new Promise((resolve) => setTimeout(resolve, 10))
    const refresh = () => ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    await refresh()
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    const payload = JSON.parse(read.body)
    const today = payload.ledger.todayKey
    // The instant stored with the balance is the one that balance was read at, not the one the
    // write arrived at: only the first of the two is a measurement, and the reader's figure was
    // made against the reading rather than against the moment they pressed the button.
    const readAt = payload.balance.fetchedAt
    assert.ok(readAt > 0)
    // The reading and the write have to be a moment apart for the two instants to be told
    // apart at all, and they are: a poll, a read and a write all land inside a millisecond.
    await pause()
    const written = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: today, amount: 2 }), written)
    assert.equal(written.status, 200, written.body)
    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.overrides[today].balance, 12.34)
    assert.equal(state.overrides[today].at, readAt, 'the anchor carries the instant of the reading, not of the write')

    // Which is what makes the day fill: spend after the reading is added to the reader's figure,
    // with no second write involved — the correction keeps tracking the balance on its own.
    setBalance(11.34)
    await refresh()
    const moved = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), moved)
    const row = JSON.parse(moved.body).ledger.rows.at(-1)
    assert.equal(row.override, 2, 'the reader\'s own figure is untouched')
    assert.equal(row.measuredAfter, 1, '12.34 − 11.34, one subtraction')
    assert.equal(row.spend, 3, 'the base plus what the balance dropped')
  })
})

test('a correction written while the balance is stale names the instant that reading was taken', async () => {
  await withPlugin(async ({ ctx, home }) => {
    const { readFile } = await import('node:fs/promises')
    const pause = () => new Promise((resolve) => setTimeout(resolve, 10))
    const refresh = () => ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    await refresh()
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    const today = JSON.parse(read.body).ledger.todayKey

    // Polling breaks. The cache keeps the last good balance *and* the instant it was read, and
    // the entry has to name that instant rather than the moment this write arrives: a reading
    // from before the break is a reading from before the break, and the ledger then adds the
    // spend it can actually measure from there rather than pretending it is a balance of now.
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) })
    await refresh()
    const staleRead = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), staleRead)
    const stale = JSON.parse(staleRead.body)
    assert.equal(stale.balance.stale, true, 'the reading the Host holds really is a stale one')
    const readAt = stale.balance.fetchedAt
    await pause()
    const written = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: today, amount: 2 }), written)
    assert.equal(written.status, 200, written.body)
    const payload = JSON.parse(written.body)
    assert.equal(payload.overrides[today].amount, 2)
    assert.equal(payload.overrides[today].balance, 12.34, 'the last balance the Host did read')
    assert.equal(payload.overrides[today].at, readAt, 'and the instant it was read at, not the one the write arrived at')
    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.overrides[today].at, readAt, 'which is what the document holds')
    assert.equal(payload.ledger.rows.at(-1).measuredAfter, 0, 'while nothing new is sampled the day is the reader\'s own word')
  })
})

test('a correction written before any balance was read has no anchor at all', async () => {
  await withPlugin(async ({ ctx }) => {
    // No poll has succeeded, so there is no balance and no instant: the entry must not claim
    // one. An instant with no balance is a measurement moment for a measurement that was never
    // taken, and the ledger has nothing to add to it.
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    const today = JSON.parse(read.body).ledger.todayKey
    const written = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: today, amount: 2 }), written)
    assert.equal(written.status, 200, written.body)
    const payload = JSON.parse(written.body)
    assert.deepEqual(payload.overrides[today], { amount: 2 }, 'the amount and nothing else')
    assert.equal(payload.ledger.rows.at(-1).spend, 2)
    assert.equal(payload.ledger.rows.at(-1).measuredAfter, 0)
  })
})

test('settings accept a known key and reject an unknown value', async () => {
  await withPlugin(async ({ ctx }) => {
    const ok = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { currency: 'usd', refreshIntervalMs: 60000 }), ok)
    assert.equal(ok.status, 200)
    const payload = JSON.parse(ok.body)
    assert.deepEqual(payload.changed, ['currency', 'refreshIntervalMs'])
    assert.equal(payload.sampling.refreshIntervalMs, 60000)
    const bad = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { currency: 'us' }), bad)
    assert.equal(bad.status, 400)
  })
})

test('the client hello route records the browser half on disk', async () => {
  await withPlugin(async ({ ctx, home }) => {
    const hello = response()
    await ctx.routes.get('/dsh-balance/hello')(request('POST', '/dsh-balance/hello', { version: '0.1.0', phase: 'read' }), hello)
    assert.equal(JSON.parse(hello.body).ok, true)
    await ctx.routes.get('/dsh-balance/hello')(request('POST', '/dsh-balance/hello', { version: '0.1.0', phase: 'mount' }), response())
    // `persist()` is fire-and-forget from the heartbeat route, so the file is where the
    // outcome shows up and the test reads it until it says what it is waiting for. The
    // wait this replaces was a 20 ms sleep: a duration, so a machine under load read the
    // document before the write landed.
    const state = await readStateWhen(home, (stored) => stored.client?.count === 2)
    assert.equal(state.client.version, '0.1.0')
    assert.ok(state.client.at > 0)
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    const payload = JSON.parse(read.body)
    assert.equal(payload.client.version, '0.1.0')
    assert.equal(payload.client.count, 2)
    assert.equal(payload.client.reads, 1)
    assert.equal(payload.client.mounts, 1)
  })
})

test('a matching preference is honoured', async () => {
  await withPlugin(async ({ ctx }) => {
    // The stub answers in CNY; the default preference (USD) is therefore missing
    // and the ledger must fall back to what the account actually reports.
    const res = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.balance.currencyPreference, 'USD')
    assert.equal(payload.balance.currency, 'CNY')
    assert.equal(payload.balance.currencyMissing, true)
    assert.equal(payload.ledger.currency, 'CNY')
    assert.equal(payload.ledger.sampleCount, 1)
    assert.equal(payload.prices.currency, 'CNY')
  })
})

test('the account currency replaces a preference the account does not have', async (t) => {
  // Both columns of the price table are priced at *now*, and the table behind them is
  // effective-dated — the 2026-09-10 Flash cut is a second entry, not a second constant.
  // The USD numbers this asserts are therefore the numbers of one tariff era, so the
  // instant that reads them is pinned rather than inherited: the literals are the point
  // of the case (they are how "the USD table, not the CNY one" is proved) and a pinned
  // clock keeps them exact. An inherited clock made them exact by luck, until the next
  // cut moved them.
  t.mock.timers.enable({ apis: ['Date'], now: bjt(2026, 9, 24, 10, 0) })
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.2', granted_balance: '0', topped_up_balance: '4.2' }] }),
  })
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?usd=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY' }))
    const res = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.balance.currency, 'USD')
    assert.equal(payload.balance.currencyPreference, 'CNY')
    assert.equal(payload.ledger.currency, 'USD')
    assert.equal(payload.prices.currency, 'USD')
    const peakFlash = payload.prices.peak['deepseek-flash']
    assert.equal(peakFlash.cacheMiss, 0.3, 'USD peak rate for Flash')
    // Read off the peak column rather than off the literal above: the two columns are
    // built in one payload and are user-visible side by side, so the honest invariant is
    // that `current` is that same rate, halved when the clock is outside a window. Stating
    // it against a literal instead would only re-derive the ratio the payload was built by,
    // and would hold for any rate table at all.
    const current = payload.prices.current['deepseek-flash']
    assert.equal(current.currency, 'USD')
    assert.equal(current.cacheMiss, peakFlash.cacheMiss * (current.peak ? 1 : OFF_PEAK_RATIO),
      'the current column is the peak column beside it, halved off-peak')
  } finally {
    ctx.dispose()
    t.mock.timers.reset()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('the price table is priced at the instant the payload was built', async (t) => {
  // The panel shows `current` beside `peak`, so the pair is user-visible data and wants a
  // case of its own. Both are read through `Date.now()`, so the clock is pinned instead of
  // inherited: a Thursday morning inside the 09:00-12:00 Beijing window, then the hour
  // after the window closes.
  t.mock.timers.enable({ apis: ['Date'], now: bjt(2026, 9, 24, 10, 0) })
  await withPlugin(async ({ ctx }) => {
    const atPeak = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), atPeak)
    const peak = JSON.parse(atPeak.body).prices
    assert.equal(peak.current['deepseek-flash'].peak, true, '10:00 Beijing time on a Thursday is peak')
    assert.equal(peak.current['deepseek-flash'].cacheMiss, 2, 'so the current column is the peak rate')
    assert.equal(peak.peak['deepseek-flash'].cacheMiss, 2, 'which is what the peak column shows too')

    t.mock.timers.tick(3 * 3_600_000)
    const offPeak = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), offPeak)
    const off = JSON.parse(offPeak.body).prices
    assert.equal(off.current['deepseek-flash'].peak, false, '13:00 is not')
    assert.equal(off.current['deepseek-flash'].cacheMiss, 2 * OFF_PEAK_RATIO, 'so the current column is half of it')
    assert.equal(off.peak['deepseek-flash'].cacheMiss, 2, 'while the peak column still answers with the peak rate')
  })
  t.mock.timers.reset()
})

test('the composition row wins at startup, and a panel setting overrides it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?prefs=${encodeURIComponent(home)}`)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-balance'), { recursive: true })
    await writeFile(
      join(home, 'dsh-balance', 'state.json'),
      JSON.stringify({ version: 1, overrides: {}, prefs: { refreshIntervalMs: 60000, currency: 'eur' } }),
      'utf8',
    )
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.5', granted_balance: '0', topped_up_balance: '9.5' }] }),
    })
    module.apply(ctx, module.Config({ apiKey: 'test-key', refreshIntervalMs: 300000, currency: 'USD' }))
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const res = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.sampling.refreshIntervalMs, 60000, 'the panel value wins for the key it set')
    assert.equal(payload.balance.currencyPreference, 'EUR', 'and is normalized to upper case')
    assert.equal(payload.balance.currency, 'USD', 'the account currency still replaces a preference it lacks')
    assert.equal(payload.ledger.currency, 'USD')
  } finally {
    globalThis.fetch = previousFetch
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('a fresh start reads the composition row', async () => {
  await withPlugin(async ({ ctx }) => {
    const res = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.sampling.refreshIntervalMs, 300000)
    assert.equal(payload.balance.currencyPreference, 'USD')
  })
})

test('the log is thinned in the zone the reader stored, not in UTC', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?zone=${encodeURIComponent(home)}`)
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-balance'), { recursive: true })
    // Two days at the default cadence, far enough back to be past the retention
    // window, so the read thins them and writes the survivors back to the log.
    const zone = 'Asia/Kolkata'
    const start = Date.now() - 200 * 24 * 3600_000
    const samples = []
    for (let i = 0; i < 288 * 2; i += 1) {
      samples.push({ t: start + i * 5 * 60_000, currency: 'CNY', total: 100 - i * 0.01 })
    }
    await writeFile(join(home, 'dsh-balance', 'samples.ndjson'),
      samples.map((one) => JSON.stringify(one)).join('\n') + '\n', 'utf8')
    await writeFile(join(home, 'dsh-balance', 'state.json'), JSON.stringify({
      version: 1,
      prefs: { dayZone: zone },
    }), 'utf8')

    // The composed config says UTC and only the stored preference says Kolkata, so
    // thinning in Kolkata is possible only when the state document is read before the
    // log is compacted. A host whose own zone happens to be Kolkata would pass either
    // way, which is why the config, not the host clock, carries the difference.
    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY', dayZone: 'UTC' }))
    // The load is what thins the log, and every route waits for it, so asking one is
    // the event that says the rewrite is done. A 60 ms sleep was the wait before, and
    // on a loaded machine it expired first: the assertion then read the untouched log
    // and reported `the log was thinned: 576 of 576` for a pass.
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), response())

    const kept = parseSamples(await readFile(join(home, 'dsh-balance', 'samples.ndjson'), 'utf8'))
    assert.ok(kept.length < samples.length / 5, `the log was thinned: ${kept.length} of ${samples.length}`)
    // Kolkata is +05:30, so a UTC hour keeps the sample at 18:55Z — half a local
    // hour into the *next* day — and the day before it loses the last half hour it
    // had. One sample per clock hour of the stored zone is what keeps it.
    const newestOfDay = new Map()
    for (const one of kept) newestOfDay.set(dayKeyOf(one.t, zone), one)
    const lastOfDay = new Map()
    for (const one of samples) lastOfDay.set(dayKeyOf(one.t, zone), one)
    assert.deepEqual([...newestOfDay.keys()], [...lastOfDay.keys()], 'every logged day is still there')
    for (const [key, newest] of newestOfDay) {
      assert.equal(newest.t, lastOfDay.get(key).t, `${key} keeps the last sample of its own day`)
    }
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('an override from the previous release gets its balance anchor back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?anchor=${encodeURIComponent(home)}`)
    const { mkdir, readFile, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-balance'), { recursive: true })
    // Realistic instants: the log is thinned to one sample per hour beyond the
    // retention window, so samples from the epoch would not survive the read.
    const now = Date.now()
    const hour = 3600_000
    const dayKey = new Date(now).toLocaleDateString('sv-SE')
    // The shape the first anchored release wrote: an instant, no balance — which
    // would leave today's cell frozen.
    await writeFile(join(home, 'dsh-balance', 'samples.ndjson'), [
      JSON.stringify({ t: now - 3 * hour, currency: 'CNY', total: 10, granted: 0, toppedUp: 10 }),
      JSON.stringify({ t: now - 2 * hour, currency: 'CNY', total: 9.5, granted: 0, toppedUp: 9.5 }),
      JSON.stringify({ t: now - hour, currency: 'CNY', total: 9.2, granted: 0, toppedUp: 9.2 }),
    ].join('\n') + '\n', 'utf8')
    await writeFile(join(home, 'dsh-balance', 'state.json'), JSON.stringify({
      version: 1,
      // Corrected exactly at the second sample, so that sample's balance is the anchor.
      overrides: { [dayKey]: { amount: 1.25, at: now - 2 * hour } },
    }), 'utf8')

    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY' }))
    // The anchor is written by the load and every route waits for the load, so a route
    // call is the event that says the write is on disk — the same reasoning as the
    // thinning case above, and the same 60 ms sleep it replaces.
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), response())

    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.overrides[dayKey].balance, 9.5, 'the balance of the correction moment is restored')
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('the session-cost route serves one session series with the rule it priced by', async () => {
  const states = new Map()
  const asked = []
  const sessions = new Map([['session-1', { id: 'session-1' }]])
  await withPlugin(async ({ ctx }) => {
    // A balance first, so the account currency (CNY) is the one the series is priced in.
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    // 10:00 Beijing on a Thursday: inside a peak window.
    const time = Date.UTC(2026, 8, 24, 2, 0)
    const events = [
      { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time, data: { header: { config: { model: 'deepseek-flash' } } } },
      { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 1e6 } } },
    ]
    states.set('session-1', events.reduce((state, event) => unit.apply(state, event), unit.init()))

    const missing = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost'), missing)
    assert.equal(missing.status, 400)
    assert.equal(asked.length, 0, 'a request without a session reads nothing')

    const unknown = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-9'), unknown)
    assert.equal(JSON.parse(unknown.body).ok, false)
    assert.equal(JSON.parse(unknown.body).error, 'unknown-session')
    assert.deepEqual(asked, ['session-9'])

    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    assert.equal(res.status, 200)
    assert.deepEqual(asked, ['session-9', 'session-1'], 'one request, one session')
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.sessionId, 'session-1')
    assert.equal(payload.currency, 'CNY')
    assert.equal(payload.seq, 3)
    assert.equal(payload.nodes.length, 1)
    assert.equal(payload.nodes[0].cost, 10, '1M miss at 2 CNY plus 1M output at 8 CNY')
    assert.equal(payload.nodes[0].ended, false)
    assert.equal(payload.nodes[0].offPeak.cost, 5, 'the same Step under the off-peak projection')
    assert.equal(payload.nodes[0].peak.cost, 10, 'and under the peak one')
    assert.equal(payload.nodes[0].offPeak.costByBucket.output, 4)
    assert.match(payload.rule.sourceUrl, /pricing/)
    assert.equal(payload.rule.verifiedOn.length, 10)
    assert.equal(payload.rule.rates.at(-1).rates.flash.cacheMiss, 2)
    assert.ok(payload.rule.rates.every((entry) => Number.isFinite(entry.effectiveFrom)), 'every rate table carries its effective date')
    assert.ok(payload.peakIntervals.length >= 1, 'the peak window covering the series travels with it')
    assert.equal(payload.title, 'Cost of the last week', 'the series names the session it belongs to')
    assert.deepEqual(payload.prefs, {}, 'and the saved view choices ride along, empty by default')
  }, {
    sessionOf: (id) => {
      asked.push(id)
      return sessions.get(id)
    },
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
    // The stored read knows one session and refuses the rest, like the real query.
    readSession: async (id) => {
      if (id !== 'session-1') throw new Error('no such session')
      return { session: {}, inheritedEventCount: 0, events: [] }
    },
    readTitle: async (id) => (id === 'session-1' ? { title: 'Cost of the last week', eventSeq: 3 } : undefined),
  })
})

test('a session this host does not own live is folded from its stored log', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  const events = [
    { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 1e6 } } },
    { type: 'step/end', seq: 4, time: time + 1000, data: { turn: 1, step: 1 } },
  ]
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-stored'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    assert.equal(payload.sessionId, 'session-stored')
    assert.equal(payload.currency, 'CNY')
    assert.equal(payload.seq, 4)
    assert.equal(payload.nodes.length, 1)
    assert.equal(payload.nodes[0].cost, 10, 'the stored log is priced by the same rule')
    assert.equal(payload.nodes[0].ended, true)
  }, {
    sessionOf: () => undefined,
    readSession: async (id) => {
      assert.equal(id, 'session-stored')
      return { session: { id }, inheritedEventCount: 0, events }
    },
  })
})

test('a fallback rate entered through the settings route reprices the session', async () => {
  const states = new Map()
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    const time = Date.UTC(2026, 8, 24, 2, 0)
    const events = [
      { type: 'request/header', seq: 1, time, data: { header: { config: { model: 'reseller-model' } } } },
      { type: 'assistant/message', seq: 2, time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 0 } } },
    ]
    states.set('session-1', events.reduce((state, event) => unit.apply(state, event), unit.init()))

    const read = async () => {
      const res = response()
      await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
      return JSON.parse(res.body)
    }

    const before = await read()
    assert.equal(before.nodes[0].unpriced, true, 'no rate applies to the model yet')
    assert.equal(before.nodes[0].cost, 0)
    assert.equal(unit.wire.view(states.get('session-1')).cost, 0)

    const rejected = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { fallbackRates: { 'reseller-model': { cacheMiss: -1 } } }), rejected)
    assert.equal(rejected.status, 400, 'a negative rate is rejected')

    // A blank field is not a rate of zero: the same hole the browser editor refuses
    // has to be refused here too, or a hand-written body prices a model for nothing.
    const blank = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', {
      fallbackRates: { 'reseller-model': { cacheMiss: 2, cacheHit: '', output: '' } },
    }), blank)
    assert.equal(blank.status, 400, 'a blank rate is rejected rather than stored as zero')

    // Zero, on the other hand, is a price the reader may mean.
    const free = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', {
      fallbackRates: { 'reseller-model': { cacheHit: 0, cacheMiss: 0, output: 0 } },
    }), free)
    assert.equal(free.status, 200, 'a rate of zero is a rate')
    assert.deepEqual(JSON.parse(free.body).fallbackRates, { 'reseller-model': { cacheHit: 0, cacheMiss: 0, output: 0 } })

    const saved = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', {
      fallbackRates: { 'reseller-model': { cacheHit: 0.1, cacheMiss: 2, output: 8 } },
    }), saved)
    assert.equal(saved.status, 200)
    assert.deepEqual(JSON.parse(saved.body).changed, ['fallbackRates'])
    assert.deepEqual(JSON.parse(saved.body).fallbackRates, { 'reseller-model': { cacheHit: 0.1, cacheMiss: 2, output: 8 } })

    const after = await read()
    assert.equal(after.nodes[0].unpriced, false, 'the entered rate prices the model')
    assert.equal(after.nodes[0].cost, 2, '1M miss at the entered 2 CNY peak rate')
    assert.equal(after.nodes[0].offPeak.cost, 1, 'and half of it under the off-peak projection')
    assert.equal(unit.wire.view(states.get('session-1')).cost, 2, 'the chip reprices with the same rule')

    const prefs = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { costMetric: 'cacheRead', costAxis: 'index', costTab: 'subagents' }), prefs)
    assert.deepEqual(JSON.parse(prefs.body).changed, ['costMetric', 'costAxis', 'costTab'])
    const badAxis = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { costAxis: 'depth' }), badAxis)
    assert.equal(badAxis.status, 400)

    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const payload = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), payload)
    const view = JSON.parse(payload.body)
    assert.deepEqual(view.prefs, { costMetric: 'cacheRead', costAxis: 'index', costTab: 'subagents' }, 'the browser choices come back on the read route')
    assert.deepEqual(view.fallbackRates, { 'reseller-model': { cacheHit: 0.1, cacheMiss: 2, output: 8 } })

    const series = await read()
    assert.deepEqual(series.prefs, { costMetric: 'cacheRead', costAxis: 'index', costTab: 'subagents' }, 'and on the series route the view mounts with')
  }, {
    sessionOf: () => ({ id: 'session-1' }),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
  })
})

test('a stored session that cannot be read is reported, not served empty', async () => {
  await withPlugin(async ({ ctx }) => {
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=missing'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'unknown-session')
    assert.match(payload.detail, /not found/)
  }, {
    sessionOf: () => undefined,
    readSession: async () => {
      throw new Error('session "missing" not found')
    },
  })
})

test('a session with no projection state reports it instead of an empty series', async () => {
  await withPlugin(async ({ ctx }) => {
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, false)
    assert.equal(payload.error, 'projection-unavailable')
  }, { sessionOf: () => ({ id: 'session-1' }) })
})

test('a failing fetch keeps the last balance and reports the error', async () => {
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
    const res = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.balance.primary.total, 12.34)
    assert.equal(payload.balance.stale, true)
    assert.match(payload.balance.error, /HTTP 500/)
    assert.equal(payload.ledger.sampleCount, 1)
  })
})

test('a missing key is reported instead of throwing', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DSH_BALANCE_TEST_KEY
  process.env.DSH_HOME = home
  delete process.env.DSH_BALANCE_TEST_KEY
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?nokey=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKeyRef: 'DSH_BALANCE_TEST_KEY' }))
    const res = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.balance.ok, false)
    assert.equal(payload.balance.error, 'api-key-missing')
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('the child route walks the subagent tree while the main route stays on its own session', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  const states = new Map()
  /** One Step of a session, priced at peak: 1M miss at 2 CNY + 1M output at 8 CNY. */
  const stepEvents = (turn, step, input, output, offset = 0) => [
    { type: 'step/start', seq: 1 + offset, time: time + offset, data: { turn, step } },
    { type: 'request/header', seq: 2 + offset, time: time + offset, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3 + offset, time: time + offset, data: { turn, step, usage: { inputTokens: input, outputTokens: output } } },
    { type: 'step/end', seq: 4 + offset, time: time + offset + 500, data: { turn, step } },
  ]
  const reads = []
  const listings = []
  await withPlugin(async ({ ctx }) => {
    // A balance first, so the account currency (CNY) is the one everything is priced in.
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    const parent = [
      ...stepEvents(1, 1, 1e6, 1e6, 0),
      { type: 'subagent/catalog', seq: 5, time: time + 600, data: { version: 1, childId: 'child-1', childCreatedAt: time + 600, mode: 'continuable', label: 'Survey the tree' } },
    ]
    states.set('session-1', parent.reduce((state, event) => unit.apply(state, event), unit.init()))

    const main = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), main)
    const payload = JSON.parse(main.body)
    assert.equal(payload.ok, true, main.body)
    assert.equal(payload.nodes.length, 1)
    assert.equal(payload.nodes[0].cost, 10, 'the parent total is its own Steps only')
    assert.deepEqual(payload.nodes[0].children.map((child) => child.id), ['child-1'], 'the spawning Step carries the marker')
    assert.deepEqual(reads, [], 'and the main route reads no other session')

    const missing = response()
    await ctx.routes.get('/dsh-balance/session-cost/children')(request('GET', '/dsh-balance/session-cost/children'), missing)
    assert.equal(missing.status, 400)
    assert.deepEqual(listings, [], 'a request without a session walks nothing')

    const direct = response()
    await ctx.routes.get('/dsh-balance/session-cost/children')(request('GET', '/dsh-balance/session-cost/children?sessionId=session-1'), direct)
    const tree = JSON.parse(direct.body)
    assert.equal(tree.ok, true, direct.body)
    assert.equal(tree.full, false)
    assert.deepEqual(listings, [{ kind: 'children', id: 'session-1' }], 'the first ask walks direct children only')
    assert.equal(tree.children.length, 1)
    assert.deepEqual(reads, ['child-1'], 'and reads exactly the child it reports')
    assert.equal(tree.children[0].id, 'child-1')
    assert.equal(tree.children[0].parentId, 'session-1')
    assert.equal(tree.children[0].depth, 1)
    assert.equal(tree.children[0].label, 'Survey the tree')
    assert.equal(tree.children[0].cost, 10, "the child's own estimate, priced as the parent prices")
    assert.equal(tree.children[0].costByBucket.output, 8)
    assert.equal(tree.children[0].steps, 1)
    assert.equal(tree.children[0].tEnd, time + 1500)
    assert.equal(tree.total.cost, 10, 'and the subtree total is the sum of the child lines')
    assert.deepEqual(tree.diagnostics, [])

    const full = response()
    await ctx.routes.get('/dsh-balance/session-cost/children')(request('GET', '/dsh-balance/session-cost/children?sessionId=session-1&full=1'), full)
    const whole = JSON.parse(full.body)
    assert.equal(whole.full, true)
    assert.deepEqual(listings.at(-1), { kind: 'descendants', id: 'session-1' }, 'the explicit ask walks the whole tree')
    assert.deepEqual(whole.children.map((child) => child.id), ['child-1', 'child-2', 'child-3'])
    assert.deepEqual(whole.children.map((child) => child.depth), [1, 2, 3])
    assert.equal(whole.children[1].parentId, 'child-1')
    assert.equal(whole.total.cost, 13, 'and the subtree total covers every line, not the parent')
    assert.equal(whole.total.steps, 3, 'the subtree total counts Steps, not sessions')
    assert.deepEqual(whole.children.map((child) => child.createdAt), [null, null, null], 'a deep line carries no creation time rather than 1970')
    assert.equal(whole.children[2].mode, 'unknown', 'a session whose mode is not supported is still read and still a line')
    assert.deepEqual(whole.diagnostics, [{ id: 'bad-branch', parentId: 'child-2', depth: 2, reason: 'corrupt' }], 'a branch that cannot be read is reported, not fatal')
  }, {
    sessionOf: (id) => (id === 'session-1' ? { id } : undefined),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
    readSession: async (id) => {
      reads.push(id)
      if (id === 'child-1') return { session: { id }, inheritedEventCount: 0, events: stepEvents(1, 1, 1e6, 1e6, 1_000) }
      if (id === 'child-2') return { session: { id }, inheritedEventCount: 0, events: stepEvents(1, 1, 1e6, 0, 2_000) }
      if (id === 'child-3') return { session: { id }, inheritedEventCount: 0, events: stepEvents(1, 1, 5e5, 0, 3_000) }
      throw new Error(`unexpected session ${id}`)
    },
    subagents: {
      async listChildren(id) {
        listings.push({ kind: 'children', id })
        return [{ id: 'child-1', createdAt: time + 600, mode: 'continuable', label: 'Survey the tree' }]
      },
      async listDescendants(id) {
        listings.push({ kind: 'descendants', id })
        return [
          { kind: 'child', id: 'child-1', parentId: 'session-1', depth: 1, mode: 'continuable', label: 'Survey the tree', activity: 'inactive', hasChildren: true },
          { kind: 'diagnostic', id: 'bad-branch', parentId: 'child-2', depth: 2, reason: 'corrupt' },
          { kind: 'child', id: 'child-2', parentId: 'child-1', depth: 2, mode: 'one-shot', label: 'Read one page', activity: 'inactive', hasChildren: false },
          { kind: 'diagnostic', id: 'child-3', parentId: 'child-2', depth: 3, reason: 'unsupported' },
        ]
      },
    },
  })
})

test('a child folded from its stored log is billed for its own work only', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  // The child's log is seeded with the parent's completed turn (sequences 1..4),
  // and its own turn follows from sequence 5 on.
  const events = [
    { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 1e6 } } },
    { type: 'step/end', seq: 4, time: time + 500, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 5, time: time + 1_000, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 6, time: time + 1_000, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 7, time: time + 1_000, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 0 } } },
    { type: 'step/end', seq: 8, time: time + 1_500, data: { turn: 1, step: 1 } },
  ]
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=child-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    assert.equal(payload.nodes.length, 1, 'the inherited Step is not part of the child series')
    assert.equal(payload.nodes[0].cost, 2, 'and only the child’s own Step is billed')
    assert.equal(payload.nodes[0].tStart, time + 1_000)
  }, {
    sessionOf: () => undefined,
    readSession: async (id) => ({ session: { id }, inheritedEventCount: 4, events }),
  })
})

test('the text route serves one session’s words and skips the inherited prefix', async () => {
  const time = Date.UTC(2026, 8, 24, 3, 0)
  const events = [
    { seq: 1, time, type: 'user/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'the parent’s question' }] } } },
    { seq: 2, time: time + 1, type: 'step/start', data: { turn: 1, step: 1 } },
    { seq: 3, time: time + 2, type: 'user/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'the child’s own question' }] } } },
    {
      seq: 4,
      time: time + 3,
      type: 'assistant/message',
      data: {
        turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' }] },
      },
    },
  ]
  await withPlugin(async ({ ctx }) => {
    const missing = response()
    await ctx.routes.get('/dsh-balance/session-cost/text')(request('GET', '/dsh-balance/session-cost/text'), missing)
    assert.equal(missing.status, 400, 'the route refuses to guess a session')

    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost/text')(request('GET', '/dsh-balance/session-cost/text?sessionId=child-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    assert.deepEqual(payload.records.map((record) => [record.seq, record.type]), [
      [3, 'user_message'],
      [4, 'assistant_message'],
      [4, 'assistant_thinking'],
    ], 'the parent’s seeded turn is not quoted')
    assert.equal(payload.records[0].text, 'the child’s own question')
    assert.equal(payload.records[1].text, 'answer')

    const unreadable = response()
    await ctx.routes.get('/dsh-balance/session-cost/text')(request('GET', '/dsh-balance/session-cost/text?sessionId=gone'), unreadable)
    assert.equal(JSON.parse(unreadable.body).ok, false, 'a log that cannot be read is an error, not an empty export')
  }, {
    sessionOf: () => undefined,
    readSession: async (id) => {
      if (id === 'gone') throw new Error('no such session')
      return { session: { id }, inheritedEventCount: 2, events }
    },
  })
})

test('the series route reports the account-wide calibration of the session interval', async () => {
  const states = new Map()
  const sessions = new Map([['session-1', { id: 'session-1' }]])
  await withPlugin(async ({ ctx, setBalance }) => {
    // Two samples in the account's own currency, then a session that runs past the
    // second one, so both fall inside the interval the series covers.
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    setBalance(9.34)
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    const now = Date.now()
    const events = [
      { type: 'step/start', seq: 1, time: now - 60_000, data: { turn: 1, step: 1 } },
      { type: 'request/header', seq: 2, time: now - 60_000, data: { header: { config: { model: 'deepseek-flash' } } } },
      { type: 'assistant/message', seq: 3, time: now - 30_000, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 0 } } },
      { type: 'step/end', seq: 4, time: now + 1000, data: { turn: 1, step: 1 } },
    ]
    states.set('session-1', events.reduce((state, event) => unit.apply(state, event), unit.init()))

    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    assert.equal(payload.calibration.samples, 2, 'both samples of the interval calibrate the estimate')
    assert.equal(payload.calibration.currency, 'CNY')
    assert.equal(payload.calibration.delta, 3, 'the account lost 3 CNY while the session was sampled')
    assert.ok(payload.calibration.from <= payload.calibration.to)
  }, {
    sessionOf: (id) => sessions.get(id),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
  })
})

test('a write that arrives while the state is still loading survives the load', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  globalThis.fetch = async () => ({ ok: true, json: async () => balanceBody(12.34) })
  const ctx = hostContext()
  try {
    const { mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-balance'), { recursive: true })
    const at = Date.now() - 86_400_000
    // A sample just before the override, so the migration has a balance to anchor to.
    await writeFile(join(home, 'dsh-balance', 'samples.ndjson'), [
      JSON.stringify({ t: at - 60_000, currency: 'CNY', total: 10, granted: 0, toppedUp: 10 }),
    ].join('\n') + '\n', 'utf8')
    // A stored state with a saved identity and view choices, and one override the
    // migration will anchor: the anchor writes the file, so it must not write it
    // before the identity and the choices are back in memory.
    await writeFile(join(home, 'dsh-balance', 'state.json'), JSON.stringify({
      version: 1,
      overrides: { '2026-09-01': { amount: 1.5, at } },
      prefs: { costMetric: 'output', costTopK: 'turns' },
      client: { version: '9.9.9', at: 1234, count: 7 },
    }), 'utf8')
    const module = await import(`../src/index.js?write-race=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY' }))
    // Fire a write immediately: the load is still running.
    const res = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { costMetric: 'cost' }), res)
    assert.equal(res.status, 200, res.body)
    // No wait for the file: the settings route waits for the load and then awaits its
    // own write, and both go through the one persist chain, so a `200` is the event that
    // says every write is on disk. The 80 ms sleep this replaces could only ever expire
    // early on a loaded machine, and then the assertions below read the pre-load document.
    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.prefs.costTopK, 'turns', 'the choices the load restored are still on disk')
    assert.equal(state.prefs.costMetric, 'cost', 'with the one the request changed')
    assert.equal(state.client.version, '9.9.9', 'and the saved client identity was not blanked')
    assert.equal(state.overrides['2026-09-01'].balance !== undefined, true, 'while the override got its anchor')
    await rm(home, { recursive: true, force: true })
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
  }
})

test('the client heartbeat that lands during the load does not blank the stored state', { timeout: 60_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  globalThis.fetch = async () => ({ ok: true, json: async () => balanceBody(12.34) })
  const ctx = hostContext()
  try {
    const { mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-balance'), { recursive: true })
    // A document big enough that reading it outlasts the heartbeat below: the heartbeat
    // persists the whole state, so a write built before the load has restored it would
    // put an empty document where every correction and every panel choice is.
    const overrides = {}
    for (let i = 0; i < 60_000; i += 1) {
      overrides[`2026-09-${String((i % 28) + 1).padStart(2, '0')}-${String(i).padStart(5, '0')}`] = { amount: 1, at: Date.now() }
    }
    await writeFile(join(home, 'dsh-balance', 'state.json'), JSON.stringify({
      version: 1,
      overrides,
      prefs: { costMetric: 'output' },
      client: { version: '9.9.9', at: 1234, count: 7 },
    }), 'utf8')
    const module = await import(`../src/index.js?hello-race=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key' }))
    const res = response()
    await ctx.routes.get('/dsh-balance/hello')(request('POST', '/dsh-balance/hello', { phase: 'mount', version: 'test' }), res)
    assert.equal(res.status, 200, res.body)
    // The heartbeat's own write is fire-and-forget, so the file is the only place the
    // outcome is visible and the test reads it until it says what it is waiting for. The
    // wait this replaces was a two-second budget of 20 ms naps — a duration, so a loaded
    // machine ran out of it while a fast one did not. Here the loop costs one read of a
    // 3 MB document per event-loop turn and gives up after twenty thousand of those, and
    // the test carries a timeout for the case where the write never lands at all.
    const state = await readStateWhen(home, (stored) => stored.client?.mounts === 1,
      'the heartbeat to be written on top of the loaded state')
    assert.equal(state.client?.mounts, 1, 'the heartbeat landed on top of the loaded state')
    assert.equal(Object.keys(state.overrides ?? {}).length, Object.keys(overrides).length, 'every stored correction is still on disk')
    assert.equal(state.prefs.costMetric, 'output', 'and so is the stored panel choice')
    assert.equal(state.client.version, 'test', 'with the heartbeat’s own identity on top')
    await rm(home, { recursive: true, force: true })
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
  }
})

test('two corrections written at the same time both land on disk', async () => {
  await withPlugin(async ({ ctx, home }) => {
    const { readFile } = await import('node:fs/promises')
    // Both days are named by the ledger the Host serves, not written down here. The
    // second one used to be the literal `'2026-09-01'`, which is the same defect a date
    // written into a test always is and one this suite already fixed elsewhere: on the
    // day that literal names, the two writes below addressed the *same* day, the second
    // overwrote the first, and the assertion on the first amount read the second. Two
    // rows at the end of the window are inside it whatever day it is, and they are two
    // different days, which is what "both land" needs.
    const { ledger } = await readPayload(ctx)
    const [today, other] = [ledger.rows.at(-1).key, ledger.rows.at(-3).key]
    assert.notEqual(today, other, 'the two corrections name two different days')
    // The browser half heartbeats on every poll while a correction awaits its own
    // write, so two writes of the state document in flight is the normal case, not
    // an exotic one: one temp name per process lost one of every pair.
    const [first, second] = [response(), response()]
    await Promise.all([
      ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: today, amount: 1.5 }), first),
      ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: other, amount: 2.5 }), second),
    ])
    assert.equal(first.status, 200, first.body)
    assert.equal(second.status, 200, second.body)
    const state = JSON.parse(await readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.overrides[today].amount, 1.5)
    assert.equal(state.overrides[other].amount, 2.5)
    assert.deepEqual(ctx.warns.filter((line) => line.includes('cannot write state')), [],
      'no write lost its temp file to a concurrent one')
  })
})

test('a state write that cannot land is reported and does not wedge the next one', async () => {
  await withPlugin(async ({ ctx, home }) => {
    const { mkdir, readFile, rm } = await import('node:fs/promises')
    // The corrected days are named by the ledger the Host serves, not written down here:
    // that ledger is a rolling window of days, so a date from this file falls out of it as
    // the calendar moves on and the row under test is not there any more. Yesterday and
    // the day before it are inside the window whatever day it is.
    const rows = (await readPayload(ctx)).ledger.rows
    const yesterday = rows.at(-2).key
    const beforeYesterday = rows.at(-3).key
    // A directory in place of the document: the rename cannot replace it, so every
    // write fails from here on.
    const statePath = join(home, 'dsh-balance', 'state.json')
    await mkdir(statePath, { recursive: true })
    const failed = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: yesterday, amount: 3 }), failed)
    assert.equal(failed.status, 500, 'a change that is not on disk is not answered as saved')
    assert.equal(JSON.parse(failed.body).ok, false)
    const settings = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { costMetric: 'output' }), settings)
    assert.equal(settings.status, 500)
    // The plugin keeps running: the change is still served, from memory.
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    assert.equal(JSON.parse(read.body).ledger.rows.find((row) => row.key === yesterday).spend, 3)

    await rm(statePath, { recursive: true, force: true })
    const next = response()
    await ctx.routes.get('/dsh-balance/overrides')(request('POST', '/dsh-balance/overrides', { date: beforeYesterday, amount: 4 }), next)
    assert.equal(next.status, 200, 'the write queued behind the failure still ran')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.equal(state.overrides[beforeYesterday].amount, 4)
    assert.equal(state.overrides[yesterday].amount, 3, 'and the correction that could not be written is on disk too')
  })
})

test('the sample log is thinned while the Host runs, not only at startup', async () => {
  await withPlugin(async ({ ctx, home, setBalance }) => {
    const { appendFile, mkdir, readFile } = await import('node:fs/promises')
    const dir = join(home, 'dsh-balance')
    await mkdir(dir, { recursive: true })
    // History that crossed the retention window without the Host ever restarting:
    // three samples of one hour, all older than keepDays. The thinning buckets by the
    // clock hour of the ledger's zone, so the hour is anchored *inside* an hour — an
    // offset from now alone puts the three samples across a boundary whenever the suite
    // starts within two minutes of one, and the case then counts two survivors.
    const old = Math.floor((Date.now() - 30 * 86_400_000) / 3_600_000) * 3_600_000 + 600_000
    const line = (offset, total) => `${JSON.stringify({ t: old + offset, currency: 'CNY', total, granted: 0, toppedUp: total })}\n`
    await appendFile(join(dir, 'samples.ndjson'), [line(0, 10), line(60_000, 9.5), line(120_000, 9)].join(''), 'utf8')

    // Every sample carries news, so each refresh appends one and the log crosses the
    // interval between two thinning passes.
    for (let index = 0; index < 100; index += 1) {
      setBalance(100 - index / 100)
      await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    }

    const { parseSamples } = await import('../src/history.js')
    const stored = parseSamples(await readFile(join(dir, 'samples.ndjson'), 'utf8'))
    const thinned = stored.filter((sample) => sample.t < Date.now() - 7 * 86_400_000)
    assert.equal(thinned.length, 1, 'the old hour was thinned to its last sample without a restart')
    assert.equal(thinned[0].total, 9)
    assert.ok(stored.length >= 100, 'and the samples appended since were kept')
  }, { config: { keepDays: 7 } })
})

test('the sampling loop stops for good when the plugin is disposed with a fetch in flight', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  let calls = 0
  let release = null
  globalThis.fetch = () => {
    calls += 1
    return new Promise((resolve) => {
      release = () => resolve({ ok: true, json: async () => balanceBody(1) })
    })
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?dispose-race=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY', refreshIntervalMs: 15000 }))
    // Let the state load settle, then fire the first tick and wait for its fetch. The
    // wait is on the fetch, with the clock advanced to let the tick fire — the same
    // shape as the settings-during-a-poll case, and for the same reason: a fixed number
    // of turns is a guess about how long a load takes.
    await ticking(t, () => calls > 0, 'the first tick to ask for the balance', 500)
    assert.equal(calls, 1, 'the first tick asked for the balance')
    ctx.dispose()
    release()
    // The poll in flight has to finish before the clock is trusted again: it is that
    // tick which would have re-armed, and what is asserted is that it does not. Its last
    // act is appending a sample, so the log growing is the event that says the tick is
    // done — a fixed number of `setImmediate` hops was a guess about how long a poll and
    // a file write take, and a loaded machine needed more hops than it allowed.
    const { readFile: read } = await import('node:fs/promises')
    await eventually(async () => {
      try {
        return (await read(join(home, 'dsh-balance', 'samples.ndjson'), 'utf8')).split('\n').filter(Boolean).length === 1
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
        return false
      }
    }, 'the released poll to finish appending its sample')
    t.mock.timers.tick(10 * 60_000)
    assert.equal(calls, 1, 'and the loop did not schedule another poll after the plugin went away')
  } finally {
    ctx.dispose()
    t.mock.timers.reset()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
    const { rm } = await import('node:fs/promises')
    await rm(home, { recursive: true, force: true })
  }
})

/** Ten Steps of one session: nine around a median, the last one far above it. */
const spikeEvents = (time) => {
  const events = []
  for (let index = 0; index < 9; index += 1) {
    const at = time + index * 1000
    events.push(
      { type: 'step/start', time: at, data: { turn: 1, step: index + 1 } },
      { type: 'request/header', time: at, data: { header: { config: { model: 'deepseek-flash' } } } },
      { type: 'assistant/message', time: at, data: { turn: 1, step: index + 1, usage: { inputTokens: [1e6, 1.05e6, 1.1e6][index % 3], outputTokens: 0 } } },
      { type: 'step/end', time: at + 500, data: { turn: 1, step: index + 1 } },
    )
  }
  events.push(
    { type: 'step/start', time: time + 20000, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', time: time + 20000, data: { turn: 2, step: 1, usage: { inputTokens: 2e7, outputTokens: 0 } } },
  )
  return events.map((event, index) => ({ ...event, seq: index + 1 }))
}

test('the series carries the Findings and the thresholds they were detected under', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  const states = new Map()
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    states.set('session-1', spikeEvents(time).reduce((state, event) => unit.apply(state, event), unit.init()))

    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    assert.deepEqual(payload.anomalies.preset, 'strict', 'the configured preset is the one in force')
    assert.equal(payload.anomalies.thresholds.spike.madMultiple, 9, '6 × 1.5')
    assert.equal(payload.anomalies.thresholds.spike.floor, 0.375)
    assert.equal(payload.anomalies.thresholds['verbose-output'].minTokens, 3000, 'a preset moves the gates together')
    assert.deepEqual(
      ctx.warns.filter((line) => line.includes('no-such-indicator')).length, 1,
      'an unknown Indicator id is dropped with one warning instead of failing the plugin',
    )
    assert.deepEqual(
      ctx.warns.filter((line) => line.includes('madMultiple')).length, 1,
      'and a value that is not a number is dropped the same way',
    )

    const spike = payload.findings.find((finding) => finding.kind === 'spike')
    assert.ok(spike, 'the dominating Step is reported with the series it belongs to')
    assert.equal(payload.nodes[spike.refs.from].cost, 40, 'the reference points into the nodes of the same response')
    assert.equal(spike.refs.from, spike.refs.to)
    assert.equal(spike.severity, 'alert')
    assert.ok(Number.isInteger(spike.confidence) && spike.confidence > 0 && spike.confidence <= 100)
    assert.equal(spike.evidence.threshold, 3, 'median 2.1 + 9 × MAD 0.1: the strict gate, not the balanced one')

    const again = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), again)
    assert.deepEqual(JSON.parse(again.body).findings, payload.findings, 'the same series yields the same Findings')
  }, {
    config: {
      anomalies: {
        preset: 'strict',
        thresholds: { spike: { madMultiple: 'lots' }, 'no-such-indicator': { share: 1 } },
      },
    },
    sessionOf: (id) => (id === 'session-1' ? { id } : undefined),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
    readSession: async (id) => {
      if (id !== 'session-1') throw new Error('no such session')
      return { session: {}, inheritedEventCount: 0, events: [] }
    },
  })
})

test('a subtree Finding appears only where the subtree was asked for', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  const states = new Map()
  const reads = []
  const stepEvents = (turn, step, input, output, offset = 0) => [
    { type: 'step/start', seq: 1 + offset, time: time + offset, data: { turn, step } },
    { type: 'request/header', seq: 2 + offset, time: time + offset, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3 + offset, time: time + offset, data: { turn, step, usage: { inputTokens: input, outputTokens: output } } },
    { type: 'step/end', seq: 4 + offset, time: time + offset + 500, data: { turn, step } },
  ]
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    const parent = [
      ...stepEvents(1, 1, 1e6, 1e6, 0),
      { type: 'subagent/catalog', seq: 5, time: time + 600, data: { version: 1, childId: 'child-1', childCreatedAt: time + 600, mode: 'continuable', label: 'Survey the tree' } },
    ]
    states.set('session-1', parent.reduce((state, event) => unit.apply(state, event), unit.init()))

    const main = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), main)
    const own = JSON.parse(main.body)
    assert.deepEqual(own.findings.filter((finding) => finding.kind === 'expensive-subtree'), [], 'one session alone claims no subtree')
    assert.deepEqual(reads, [], 'and the session route reads no other session')

    const tree = response()
    await ctx.routes.get('/dsh-balance/session-cost/children')(request('GET', '/dsh-balance/session-cost/children?sessionId=session-1'), tree)
    const payload = JSON.parse(tree.body)
    assert.equal(payload.ok, true, tree.body)
    assert.deepEqual(reads, ['child-1'], 'the subtree was read because it was asked for, and only then')
    const finding = payload.findings.find((entry) => entry.kind === 'expensive-subtree')
    assert.ok(finding, 'a child that costs as much as its parent is worth naming')
    assert.equal(finding.evidence.value, 1, 'the child costs exactly what the session itself does')
    assert.deepEqual(
      { from: finding.refs.from, to: finding.refs.to },
      { from: 0, to: 0 },
      'and it blames the Step that spawned the child',
    )
    assert.equal(payload.anomalies.preset, 'balanced')
  }, {
    sessionOf: (id) => (id === 'session-1' ? { id } : undefined),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
    readSession: async (id) => {
      reads.push(id)
      if (id === 'child-1') return { session: { id }, inheritedEventCount: 0, events: stepEvents(1, 1, 1e6, 1e6, 1_000) }
      throw new Error(`unexpected session ${id}`)
    },
    subagents: {
      async listChildren() {
        return [{ id: 'child-1', createdAt: time + 600, mode: 'continuable', label: 'Survey the tree' }]
      },
    },
  })
})

test('the documented configuration example loads and yields the thresholds it describes', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  const states = new Map()
  // The example in README.md, verbatim: a strict preset and one override beside it.
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    states.set('session-1', spikeEvents(time).reduce((state, event) => unit.apply(state, event), unit.init()))
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    assert.equal(ctx.warns.length, 0, `a documented example warns about nothing: ${ctx.warns.join('; ')}`)
    assert.equal(payload.anomalies.preset, 'strict')
    assert.equal(payload.anomalies.thresholds.spike.madMultiple, 12, 'the pinned override, not the strict default of 9')
    const growth = payload.anomalies.thresholds['context-growth'].minR2
    assert.ok(growth > 0 && growth < 1, `an Indicator the example does not name still carries its preset value: ${growth}`)
    const spike = payload.findings.find((finding) => finding.kind === 'spike')
    assert.equal(spike.evidence.threshold, 3.3, 'and the Finding names the gate it cleared: 2.1 + 12 × 0.1')
  }, {
    config: { anomalies: { preset: 'strict', thresholds: { spike: { madMultiple: 12 } } } },
    sessionOf: (id) => (id === 'session-1' ? { id } : undefined),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
    readSession: async (id) => {
      if (id !== 'session-1') throw new Error('no such session')
      return { session: {}, inheritedEventCount: 0, events: [] }
    },
  })
})

test('the peak intervals cover a multi-day series and skip the days the tariff does not trade', async () => {
  // Thursday 2026-09-24 10:00 Beijing — inside the morning peak window — through
  // Saturday 2026-09-26 10:00, which is a weekend day. The intervals must be clipped to
  // the series they describe, and no interval may cover the Saturday instant.
  const { bjt } = await import('./fixtures/anomaly-sessions.js')
  const time = bjt(2026, 9, 24, 10, 0)
  const weekend = bjt(2026, 9, 26, 10, 0)
  const events = [
    { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, time: time + 1000, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 0 } } },
    { type: 'step/end', seq: 4, time: time + 2000, data: { turn: 1, step: 1 } },
    { type: 'step/start', seq: 5, time: weekend, data: { turn: 1, step: 2 } },
    { type: 'assistant/message', seq: 6, time: weekend + 1000, data: { turn: 1, step: 2, usage: { inputTokens: 1e6, outputTokens: 0 } } },
    { type: 'step/end', seq: 7, time: weekend + 2000, data: { turn: 1, step: 2 } },
  ]
  await withPlugin(async ({ ctx }) => {
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    const payload = JSON.parse(res.body)
    assert.equal(payload.ok, true, res.body)
    const nodes = payload.nodes
    assert.equal(nodes.length, 2)
    const from = nodes[0].tStart
    const to = nodes[nodes.length - 1].tEnd
    assert.ok(payload.peakIntervals.length >= 1, 'the series carries the windows that cover it')
    for (const interval of payload.peakIntervals) {
      // The windows are absolute tariff windows, not slices of the series: what matters
      // is that each one overlaps the series and is a window rather than an instant.
      assert.ok(interval.endMs > from && interval.startMs < to, 'every interval overlaps the series')
      assert.ok(interval.startMs < interval.endMs, 'and each one is a window, not an instant')
    }
    assert.equal(
      payload.peakIntervals.some((interval) => interval.startMs <= weekend && weekend < interval.endMs), false,
      'a Saturday instant is inside no peak window',
    )
    // The two projections answer different questions: `peak` is what the Step would cost
    // at peak rates, `offPeak` at half of them, and `fact` is what the phase charged.
    assert.equal(nodes[0].cost, nodes[0].peak.cost, 'the Thursday-morning step was charged the peak rate')
    assert.ok(nodes[0].offPeak.cost < nodes[0].cost, 'and its off-peak projection is cheaper')
    assert.equal(nodes[1].cost, nodes[1].offPeak.cost, 'the Saturday step was charged the off-peak rate')
    assert.ok(nodes[1].peak.cost > nodes[1].cost, 'while its peak projection is dearer')
  }, {
    sessionOf: () => undefined,
    readSession: async (id) => {
      if (id !== 'session-1') throw new Error('no such session')
      return { session: {}, inheritedEventCount: 0, events }
    },
  })
})

test('the anomaly thresholds are configuration, not something the panel can edit', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  const states = new Map()
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const unit = ctx.projections[0]
    states.set('session-1', spikeEvents(time).reduce((state, event) => unit.apply(state, event), unit.init()))
    const written = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', {
      anomalies: { preset: 'loose', thresholds: { spike: { madMultiple: 1 } } },
    }), written)
    assert.equal(written.status, 200)
    const payload = JSON.parse(written.body)
    assert.deepEqual(payload.changed, [], 'a settings write changes only the view settings it knows')
    assert.equal(payload.prefs.anomalies, undefined, 'and never stores the Indicator rules')
    const res = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), res)
    const series = JSON.parse(res.body)
    assert.equal(series.anomalies.preset, 'balanced', 'the configured preset is untouched by the request')
    assert.equal(series.anomalies.thresholds.spike.madMultiple, 6, 'and so are the thresholds')
  }, {
    config: { anomalies: { preset: 'balanced' } },
    sessionOf: (id) => (id === 'session-1' ? { id } : undefined),
    projectionState: (session, key) => (key === 'dshBalanceCost' ? states.get(session.id) : undefined),
    readSession: async (id) => {
      if (id !== 'session-1') throw new Error('no such session')
      return { session: {}, inheritedEventCount: 0, events: [] }
    },
  })
})

test('a stored log with one malformed event is still a session with a cost, and still a priced child', async () => {
  const time = Date.UTC(2026, 8, 24, 2, 0)
  // The log the harness handed over, with one entry whose `data` never made it to disk.
  // The fold reads it, finds no `(Turn, Step)` to place it at, and skips it — instead of
  // throwing, which `projectionStateOf` answers as `unknown-session` for the whole session
  // and as an `unavailable` diagnostic for a child line.
  const log = (turn, step) => [
    { type: 'step/start', seq: 1, time, data: { turn, step } },
    { type: 'request/header', seq: 2, time, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, time: time + 1000 },
    { type: 'tool/call', seq: 4, time: time + 1500, data: { turn, step, callId: 'call-1', name: 'bash', arguments: '{}' } },
    { type: 'assistant/message', seq: 5, time: time + 2000, data: { turn, step, usage: { inputTokens: 1e6, outputTokens: 1e6 } } },
    { type: 'step/end', seq: 6, time: time + 2500, data: { turn, step } },
  ]
  await withPlugin(async ({ ctx }) => {
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), response())
    const own = response()
    await ctx.routes.get('/dsh-balance/session-cost')(request('GET', '/dsh-balance/session-cost?sessionId=session-1'), own)
    const series = JSON.parse(own.body)
    assert.equal(series.ok, true, own.body)
    assert.equal(series.nodes.length, 1, 'the priced Step is the whole series')
    assert.equal(series.nodes[0].cost, 10, 'and it is priced at 1M miss plus 1M output')
    assert.equal(series.nodes[0].calls.length, 1, 'the malformed event cost the Step nothing but its call')

    const tree = response()
    await ctx.routes.get('/dsh-balance/session-cost/children')(request('GET', '/dsh-balance/session-cost/children?sessionId=session-1'), tree)
    const payload = JSON.parse(tree.body)
    assert.equal(payload.ok, true, tree.body)
    assert.deepEqual(payload.diagnostics, [], 'a child whose log holds one bad entry is not a branch that could not be read')
    assert.deepEqual(payload.children.map((child) => [child.id, child.cost]), [['child-1', 10]])
  }, {
    sessionOf: () => undefined,
    readSession: async (id) => ({ session: { id }, inheritedEventCount: 0, events: log(1, 1) }),
    subagents: {
      async listChildren() {
        return [{ id: 'child-1', createdAt: time, mode: 'continuable', label: 'Survey the tree' }]
      },
    },
  })
})

test('the sampling loop asks again after a poll that rejected', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  const previousRef = process.env.DSH_BALANCE_ABSENT_KEY
  process.env.DSH_HOME = home
  delete process.env.DSH_BALANCE_ABSENT_KEY
  let polls = 0
  globalThis.fetch = async () => ({ ok: true, json: async () => balanceBody(1) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = hostContext()
  // The credentials service cannot be read, so resolving the key throws before the
  // request is even built. That rejection used to be the end of the loop: `refresh()`
  // never resolved, nothing rescheduled, and sampling stopped for the rest of the
  // process's life behind an unhandled rejection.
  const get = ctx.get
  ctx.get = (key) => {
    if (key === 'credentials') {
      polls += 1
      throw new Error('the credentials service is not readable')
    }
    return get(key)
  }
  try {
    const module = await import(`../src/index.js?rejected-tick=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: '', apiKeyRef: 'DSH_BALANCE_ABSENT_KEY', refreshIntervalMs: 15000 }))
    const settle = async (reached, what) => ticking(t, reached, what)
    await settle(() => polls > 0, 'the first tick to resolve the key')
    assert.equal(polls, 1, 'the first tick resolved the key and failed')
    await settle(() => polls > 1, 'the loop to re-arm after the failed tick')
    assert.equal(polls, 2, 'the loop re-armed after the failed tick')
    assert.ok(
      ctx.warns.some((line) => line.includes('the credentials service is not readable')),
      `the failure is still reported: ${ctx.warns.join('; ')}`,
    )
  } finally {
    ctx.dispose()
    t.mock.timers.reset()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousRef !== undefined) process.env.DSH_BALANCE_ABSENT_KEY = previousRef
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('a settings write that lands after the plugin was disposed arms no timer', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  let polls = 0
  globalThis.fetch = async () => {
    polls += 1
    return { ok: true, json: async () => balanceBody(1) }
  }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = hostContext()
  try {
    const module = await import(`../src/index.js?disposed-settings=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY' }))
    // The write is taken before the disposal and run after it: that is the race this is
    // about, a settings request that was already in flight when the plugin went away.
    const settings = ctx.routes.get('/dsh-balance/settings')
    ctx.dispose()
    const res = response()
    await settings(request('POST', '/dsh-balance/settings', { refreshIntervalMs: 15000 }), res)
    assert.equal(res.status, 200, res.body)
    assert.deepEqual(JSON.parse(res.body).changed, ['refreshIntervalMs'], 'the setting itself is still stored')
    for (let index = 0; index < 20; index += 1) {
      t.mock.timers.tick(60_000)
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(polls, 0, 'a disposed plugin is not woken up by a late settings write')
  } finally {
    ctx.dispose()
    t.mock.timers.reset()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('a settings write during a poll in flight does not arm a second loop', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  const previousTimeout = globalThis.setTimeout
  const previousClear = globalThis.clearTimeout
  process.env.DSH_HOME = home
  let polls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async () => {
    polls += 1
    // Only the first poll is held, which is what leaves a tick awaiting its refresh
    // while the write below goes through. A tick whose timer has already fired cannot
    // be cancelled by `resetLoop()`, and the timer it came back to arm used to land on
    // top of the one the reset had just armed — a second loop nothing owned.
    if (polls === 1) await gate
    return { ok: true, json: async () => balanceBody(1) }
  }
  // The live timers are the thing under test, so they are counted rather than timed:
  // a second arming is a pending timer the first one does not know about, and once both
  // loops run at the same cadence a poll count cannot tell them apart. The wrapper goes
  // on after the mock is installed, so it counts the timers the loop actually arms: a
  // timer is live from the moment it is armed until it fires or is cleared.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const live = new Set()
  const mockedTimeout = globalThis.setTimeout
  const mockedClear = globalThis.clearTimeout
  globalThis.setTimeout = (fn, ms, ...rest) => {
    let id
    id = mockedTimeout((...args) => {
      live.delete(id)
      return fn(...args)
    }, ms, ...rest)
    live.add(id)
    return id
  }
  globalThis.clearTimeout = (id) => {
    live.delete(id)
    return mockedClear(id)
  }
  const ctx = hostContext()
  // The mocked clock says *when* the loop is allowed to tick; the real event loop says
  // how long a tick takes to get through its own poll. A poll ends in a real append to
  // the sample log, so the number of event-loop turns it occupies is the machine's, not
  // the test's. The waits below are therefore on the two events the loop produces — a
  // poll, and the arming that follows it — and the turn count inside `eventually` is a
  // backstop against hanging, not the thing being asserted. Ticking a fixed span of
  // mocked time and counting what turned up is what made this case read `1 polls` on a
  // loaded machine and pass on a fast one.
  const ticked = async (count) => {
    for (let index = 0; index < count; index += 1) {
      const before = polls
      await ticking(t, () => polls > before, `a poll after interval ${index + 1}`)
      // The tick re-arms only once its own poll is finished, so the arming is the event
      // that says this interval is over and the next one may be started. It is also the
      // assertion the case is really about: a second loop would leave two live timers.
      await eventually(() => live.size === 1, `the loop to re-arm after poll ${polls}, with ${live.size} timers live`)
      assert.equal(polls, before + 1, 'one interval of a fifteen-second cadence is one poll')
    }
  }
  try {
    const module = await import(`../src/index.js?settings-in-flight=${encodeURIComponent(home)}`)
    module.apply(ctx, module.Config({ apiKey: 'test-key', currency: 'CNY', refreshIntervalMs: 15000 }))
    // The first tick fires 500 ms in and its poll is held open, which is the window the
    // write below has to land in.
    await ticking(t, () => polls > 0, 'the first tick to reach its poll')
    assert.equal(polls, 1, 'the first tick is holding its poll open')
    const res = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { refreshIntervalMs: 15000 }), res)
    assert.equal(res.status, 200, res.body)
    release()
    // Four intervals of a fifteen-second cadence. Every tick re-arms, so the count of
    // live timers settles at one however many polls went by, and a second loop shows
    // up as a second pending timer the first arming never knew about.
    await ticked(4)
    assert.equal(live.size, 1, `exactly one loop timer is armed, not two: ${live.size}`)
  } finally {
    release()
    ctx.dispose()
    t.mock.timers.reset()
    globalThis.setTimeout = previousTimeout
    globalThis.clearTimeout = previousClear
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('a refresh answered during the load reports the history on disk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  const previousRef = process.env.DSH_BALANCE_ABSENT_KEY
  process.env.DSH_HOME = home
  delete process.env.DSH_BALANCE_ABSENT_KEY
  let polls = 0
  globalThis.fetch = async () => {
    polls += 1
    return { ok: true, json: async () => balanceBody(12.34) }
  }
  const ctx = hostContext()
  try {
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(home, 'dsh-balance'), { recursive: true })
    const now = Date.now()
    const line = (offset, total) => `${JSON.stringify({ t: now - offset, currency: 'CNY', total, granted: 0, toppedUp: total })}\n`
    await writeFile(join(home, 'dsh-balance', 'samples.ndjson'), [line(60_000, 10), line(0, 9)].join(''), 'utf8')
    const module = await import(`../src/index.js?startup-refresh=${encodeURIComponent(home)}`)
    // No key anywhere, which is the case where `refresh()` returns before its own wait
    // for the load: the route then used to build its payload from an empty in-memory
    // history and report `samples: 0` and an all-zero ledger over two real samples.
    module.apply(ctx, module.Config({ apiKey: '', apiKeyRef: 'DSH_BALANCE_ABSENT_KEY', currency: 'CNY' }))
    const res = response()
    await ctx.routes.get('/dsh-balance/refresh')(request('POST', '/dsh-balance/refresh'), res)
    assert.equal(res.status, 200, res.body)
    const payload = JSON.parse(res.body)
    assert.equal(payload.host.loaded, true, 'the answer was built after the load finished')
    assert.equal(payload.host.samples, 2)
    assert.equal(payload.ledger.sampleCount, 2, 'and the ledger is the one the log holds')
    assert.equal(payload.ledger.totals.d1.amount, 1, 'the minute of spend between the two samples')
    assert.equal(payload.balance.error, 'api-key-missing')
    assert.equal(polls, 0, 'and no request was made without a key')
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousRef !== undefined) process.env.DSH_BALANCE_ABSENT_KEY = previousRef
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('a HEAD read costs no payload build', async () => {
  await withPlugin(async ({ ctx }) => {
    const head = response()
    await ctx.routes.get('/dsh-balance')(request('HEAD', '/dsh-balance?sessionId=session-1'), head)
    assert.equal(head.status, 200)
    assert.equal(head.body, '', 'a HEAD answers no body')
    // The session read is the observable side effect of building the payload, which is
    // why this drives the HEAD with a session id and an unreadable session store.
    assert.deepEqual(ctx.warns, [], 'and builds nothing it would have to throw away')

    const get = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance?sessionId=session-1'), get)
    assert.equal(get.status, 200, get.body)
    assert.equal(ctx.warns.length, 1, 'the same read with a body does build the payload')
  }, { sessionOf: () => { throw new Error('the session store is closed') } })
})

test('the subtree walk stops when the reader goes away, and only then', async () => {
  const signals = []
  // The walk announces itself rather than being looked for: a stub that resolves this
  // promise on its first call is the event the test waits on. Counting event-loop turns
  // instead — the shape this used to have, twenty `setImmediate` hops — measures how
  // busy the machine is, because the route ahead of the walk reads a session log and
  // builds a ledger first, and twenty turns is generous on a fast box and too few on a
  // loaded one. A wait that can expire is a timeout wearing a loop's clothes.
  let announceWalk
  const walkStarted = new Promise((resolve) => { announceWalk = resolve })
  const children = '/dsh-balance/session-cost/children?sessionId=session-1'
  await withPlugin(async ({ ctx }) => {
    const route = ctx.routes.get('/dsh-balance/session-cost/children')
    const res = response()
    const req = request('GET', children)
    const pending = route(req, res)
    await walkStarted
    assert.equal(signals.length, 1, 'the walk runs under a signal of its own')
    assert.equal(signals[0].aborted, false, 'which starts out live')
    // What a real `IncomingMessage` emits once its request body is consumed — about a
    // millisecond into the walk, long before the answer. The walk used to cancel itself
    // here and to run to the end when a GET had no body to consume at all.
    req.emit('close')
    assert.equal(signals[0].aborted, false, 'a consumed request is not a reader who went away')
    // What a lost connection emits: the response closes with nothing written.
    res.emit('close')
    assert.equal(signals[0].aborted, true, 'the disconnect cancels the walk')
    await pending
    assert.equal(res.status, 200, res.body)

    const answered = response()
    const finished = request('GET', children)
    await route(finished, answered)
    assert.equal(answered.writableEnded, true, 'the answer was written')
    finished.emit('close')
    answered.emit('close')
    assert.equal(signals.at(-1).aborted, false, 'a read that was answered is not a disconnect')
  }, {
    subagents: {
      async listChildren(id, signal) {
        signals.push(signal)
        announceWalk()
        for (let step = 0; step < 5; step += 1) await new Promise((resolve) => setImmediate(resolve))
        return [{ id: 'child-1', createdAt: Date.now(), mode: 'continuable', label: 'Survey the tree' }]
      },
    },
  })
})

test('a body limit that counted characters let four times the text through', async () => {
  await withPlugin(async ({ ctx }) => {
    // Three bytes per character, so 400 000 of them are 1.2 MB of text in 400 000
    // characters: under a 1 MB limit measured in characters, over it in bytes.
    const big = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { currency: '€'.repeat(400_000) }), big)
    assert.equal(big.status, 400)
    assert.match(JSON.parse(big.body).error, /payload too large/, big.body)
    // The limit is the number of bytes on the wire, and a body inside it is still read.
    const small = response()
    await ctx.routes.get('/dsh-balance/settings')(request('POST', '/dsh-balance/settings', { dayZone: 'Europe/Berlin' }), small)
    assert.equal(small.status, 200, small.body)
  })
})
