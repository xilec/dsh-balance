import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/** A response stub capturing status and body. */
function response() {
  const res = {
    status: 0,
    body: '',
    writeHead(status) {
      res.status = status
    },
    end(text) {
      res.body = text ?? ''
    },
  }
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
  return {
    routes,
    projections,
    effects,
    logger: { info() {}, warn() {} },
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
    const config = module.Config({ apiKey: 'test-key' })
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
    // persist() is fire-and-forget from the route; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
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

test('the account currency replaces a preference the account does not have', async () => {
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
    assert.equal(payload.prices.peak['deepseek-flash'].cacheMiss, 0.3, 'USD peak rate for Flash')
    assert.equal(payload.prices.current['deepseek-flash'].cacheMiss, 0.15, 'off-peak is half of peak')
  } finally {
    ctx.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    globalThis.fetch = previousFetch
    await rm(home, { recursive: true, force: true })
  }
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
    await new Promise((resolve) => setTimeout(resolve, 60))

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
    await new Promise((resolve) => setTimeout(resolve, 80))
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
    // Let the state load settle, then fire the first tick and wait for its fetch.
    for (let index = 0; index < 500 && calls === 0; index += 1) {
      t.mock.timers.tick(500)
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(calls, 1, 'the first tick asked for the balance')
    ctx.dispose()
    release()
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve))
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
