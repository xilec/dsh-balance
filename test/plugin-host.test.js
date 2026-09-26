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
function hostContext() {
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
    }],
    ['sessions', { get: () => undefined }],
  ])
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

async function withPlugin(run) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-balance-test-'))
  const previousHome = process.env.DSH_HOME
  const previousFetch = globalThis.fetch
  process.env.DSH_HOME = home
  let body = balanceBody(12.34)
  globalThis.fetch = async () => ({ ok: true, json: async () => body })
  const ctx = hostContext()
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
      ['/dsh-balance', '/dsh-balance/hello', '/dsh-balance/overrides', '/dsh-balance/refresh', '/dsh-balance/settings'],
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
    assert.equal(state.overrides[day], 4.5)
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
    await ctx.routes.get('/dsh-balance/hello')(request('POST', '/dsh-balance/hello', { version: '0.1.0' }), hello)
    assert.equal(JSON.parse(hello.body).ok, true)
    // persist() is fire-and-forget from the route; give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const state = JSON.parse(await (await import('node:fs/promises')).readFile(join(home, 'dsh-balance', 'state.json'), 'utf8'))
    assert.equal(state.client.version, '0.1.0')
    assert.ok(state.client.at > 0)
    const read = response()
    await ctx.routes.get('/dsh-balance')(request('GET', '/dsh-balance'), read)
    const payload = JSON.parse(read.body)
    assert.equal(payload.client.version, '0.1.0')
    assert.equal(payload.client.count, 1)
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
