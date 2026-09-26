import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * The browser half is a `window.__ModuleLoader__` registration, so this test
 * stands in for the client module loader and for React: it checks the module
 * shape, the slot registration, and that a real payload renders through the
 * component. Actual pixels are verified in the running shell.
 */

/** A React stub: enough for the hooks the chip uses, and effects run inline. */
function reactStub() {
  const state = { cursor: 0, slots: {} }
  const subscriptions = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: (component) => component,
    /** Reset the hook cursor, the way a render pass would. */
    beginRender() {
      state.cursor = 0
    },
    /** Tear down every store subscription a render opened, or the poller keeps the loop alive. */
    stop() {
      while (subscriptions.length > 0) {
        try {
          subscriptions.pop()()
        } catch {
          /* already gone */
        }
      }
    },
    useRef(initial) {
      const index = state.cursor++
      if (!(index in state.slots)) state.slots[index] = { current: initial ?? null }
      return state.slots[index]
    },
    useState(initial) {
      const index = state.cursor++
      if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial
      return [state.slots[index], (next) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next
      }]
    },
    useEffect(effect) {
      state.cursor += 1
      const disposer = effect()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      state.cursor += 1
      if (typeof subscribe === 'function') {
        const disposer = subscribe(() => {})
        if (typeof disposer === 'function') subscriptions.push(disposer)
      }
      return getSnapshot()
    },
  }
  return react
}

/** Render an element tree (calling function components) down to its text. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }))
  return textOf(node.children ?? [])
}

/** Load the client module with a stubbed loader and React. */
async function loadClient() {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  await import(`../client/client.js?test=${Math.random()}`)
  assert.equal(registrations.length, 1)
  const react = reactStub()
  const exported = registrations[0].factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration: registrations[0], exported, react }
}

/** A Host context stub capturing the slot registration. */
function clientContext() {
  const registered = []
  return {
    registered,
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: { register: () => () => {} },
    slots: {
      inject(name, callback) {
        callback()
        return () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
  }
}

/** One `/dsh-balance` payload. */
const payload = {
  host: { version: '0.1.0', now: Date.now(), dir: '/tmp', samples: 3, loaded: true },
  balance: {
    ok: true,
    error: null,
    stale: false,
    fetchedAt: Date.now() - 60000,
    isAvailable: true,
    balances: [{ currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 }],
    primary: { currency: 'CNY', total: 12.34, granted: 0, toppedUp: 12.34 },
    currency: 'CNY',
    thresholds: { warning: 10, danger: 5 },
    currencyMissing: false,
  },
  ledger: {
    zone: 'local',
    currency: 'CNY',
    todayKey: '2026-09-26',
    rows: [
      { key: '2026-09-25', spend: 1.5, computed: 1.5, override: null, coarse: false, open: false },
      { key: '2026-09-26', spend: 0.5, computed: 0.5, override: null, coarse: false, open: true },
    ],
    credits: [{ t: Date.now() - 3600000, amount: 50, fromTotal: 10, toTotal: 60 }],
    creditTotal: 50,
    totals: {
      d1: { amount: 0.5, covered: true },
      w1: { amount: 2, covered: false },
      m1: { amount: 2, covered: false },
    },
    firstSampleMs: Date.now() - 86400000,
    lastSampleMs: Date.now() - 60000,
    sampleCount: 3,
    medianGapMs: 300000,
  },
  peak: {
    peak: false,
    reason: 'weekend',
    offPeakRatio: 0.5,
    changeAt: Date.now() + 3600000,
    changeToPeak: true,
    changeReason: 'peak',
    rule: { sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', verifiedOn: '2026-09-27', holidays: [] },
  },
  prices: {
    current: { 'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4, peak: false, currency: 'CNY', class: 'flash' } },
    peak: { 'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8, peak: true, currency: 'CNY', class: 'flash' } },
    atPeak: Date.now(),
  },
  fallbackPrices: null,
  sampling: { refreshIntervalMs: 300000, clientPollIntervalMs: 15000 },
  client: { version: '0.1.0', at: Date.now(), count: 1 },
  session: { cost: 0.42, currency: 'CNY', models: ['deepseek-flash'], costByModel: { 'deepseek-flash': 0.42 }, tokens: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, unpriced: [], peakNow: false },
}

test('the client module registers one plugin with its services', async () => {
  const { registration, exported } = await loadClient()
  assert.equal(registration.id, 'dsh-balance')
  assert.deepEqual(exported.inject, ['slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply registers the chip into the shell overlay with its dictionary', async () => {
  const { exported } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  assert.equal(ctx.registered.length, 1)
  assert.equal(ctx.registered[0].options.name, 'shell.overlay')
  assert.equal(ctx.registered[0].options.id, 'dsh-balance')
  assert.equal(ctx.registered[0].options.locale, 'dsh-balance')
})

test('the chip renders the balance, the 1d/1w/1m metrics and the session cost', async () => {
  const { exported, react } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const Chip = ctx.registered[0].component

  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, method: options?.method ?? 'GET' })
    if (String(url).startsWith('/dsh-balance/hello')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    // First render starts the poller through useSyncExternalStore's subscribe.
    react.beginRender()
    const loading = textOf(react.createElement(Chip, { t: (key) => key, useSessions: (select) => select({ byId: {} }) }))
    assert.match(loading, /chip\.unknown/)
    await new Promise((resolve) => setTimeout(resolve, 10))

    react.beginRender()
    const rendered = textOf(react.createElement(Chip, { t: (key) => key, useSessions: (select) => select({ byId: {} }) }))
    assert.match(rendered, /12\.34/)
    assert.match(rendered, /0\.50/, 'the day total renders')
    assert.match(rendered, /chip\.session/)
    assert.match(rendered, /0\.42/, 'the session cost renders')
    assert.equal(calls.some((call) => call.url === '/dsh-balance'), true)
    assert.equal(calls.some((call) => call.url === '/dsh-balance/hello' && call.method === 'POST'), true)
  } finally {
    react.stop()
    globalThis.fetch = previousFetch
  }
})

test('the chip asks the host about the session the main view retains', async () => {
  const { exported, react } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const Chip = ctx.registered[0].component
  const previousFetch = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    const select = (selector) => selector({ byId: { 'session-7': { id: 'session-7', retainedBy: { mainView: 1 } } } })
    react.beginRender()
    void textOf(react.createElement(Chip, { t: (key) => key, useSessions: select }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(urls.some((url) => url.includes('sessionId=session-7')), true, urls.join(', '))
  } finally {
    react.stop()
    globalThis.fetch = previousFetch
  }
})
