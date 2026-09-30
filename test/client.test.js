import test from 'node:test'
import assert from 'node:assert/strict'
import { CATALOGUE } from '../src/indicators.js'

/**
 * The browser half is a `window.__ModuleLoader__` registration, so this test stands
 * in for the client module loader and for React: it checks the module shape, the slot
 * registrations, the compact readout, the peak chip's state derivation and the panel.
 * Actual pixels are verified in the running shell.
 */

/** A React stub: enough for the hooks the plugin uses, with effects run inline. */
function reactStub() {
  const state = { cursor: 0, slots: {} }
  const subscriptions = []
  const cleanups = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    memo: (component) => component,
    /** Reset the hook cursor, the way a render pass would. */
    beginRender() {
      state.cursor = 0
    },
    /** Tear down every subscription and effect a render opened, or timers keep the loop alive. */
    stop() {
      while (subscriptions.length > 0) {
        try {
          subscriptions.pop()()
        } catch {
          /* already gone */
        }
      }
      while (cleanups.length > 0) {
        try {
          cleanups.pop()()
        } catch {
          /* already gone */
        }
      }
    },
    /**
     * Unmount the view the way the shell does when another conversation view takes
     * over: hook state and effects go away, module-level memory does not.
     */
    unmount() {
      while (cleanups.length > 0) {
        try {
          cleanups.pop()()
        } catch {
          /* already gone */
        }
      }
      state.slots = {}
      state.cursor = 0
    },
    useRef(initial) {
      const index = state.cursor++
      // The plugin takes refs to measure elements and to attach the non-passive
      // wheel listener, so the stub hands it a stand-in that can do both.
      if (!(index in state.slots)) {
        const target = {
          offsetHeight: 321,
          listeners: {},
          addEventListener(type, fn) {
            this.listeners[type] = [...(this.listeners[type] ?? []), fn]
          },
          removeEventListener(type, fn) {
            this.listeners[type] = (this.listeners[type] ?? []).filter((each) => each !== fn)
          },
        }
        state.slots[index] = { current: initial === null || initial === undefined ? target : initial }
      }
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
      if (typeof disposer === 'function') cleanups.push(disposer)
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

/**
 * The stub below keeps hook state in one flat array, so every traversal of a tree
 * has to start from index zero: it stands in for a render pass of the top-level
 * component, exactly as a reconciler would call it.
 */
let currentReact = null

/** Render an element tree (calling function components) down to its text. */
function textOf(node) {
  currentReact?.beginRender()
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node.type === 'function') return textOf(node.type({ ...node.props, children: node.children }))
  return textOf(node.children ?? [])
}

/** Every element whose props satisfy one predicate. */
function find(node, predicate, out = []) {
  if (out.length === 0) currentReact?.beginRender()
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const child of node) find(child, predicate, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') return out
  if (typeof node.type === 'function') {
    find(node.type({ ...node.props, children: node.children }), predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  find(node.children, predicate, out)
  return out
}

/** Load the client module with a stubbed loader and React. */
async function loadClient() {
  const registrations = []
  globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  await import(`../client/client.js?test=${Math.random()}`)
  assert.equal(registrations.length, 1)
  const react = reactStub()
  currentReact = react
  const exported = registrations[0].factory((specifier) => {
    if (specifier === 'react') return react
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration: registrations[0], exported, react }
}

/** A Host context stub capturing slot registrations. */
function clientContext() {
  const registered = []
  const services = new Map()
  // The locale service is where the dictionaries land, and the only place a test can
  // read them: the shell itself only ever calls `t`.
  let dictionary = null
  return {
    registered,
    services,
    dictionary: () => dictionary,
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: {
      register: (namespace, copy) => {
        if (namespace === 'dsh-balance') dictionary = copy
        return () => {}
      },
      bind: () => (key) => key,
    },
    get: (key) => services.get(key),
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

/** Readout labels as the dictionary renders them, so the line reads as it does in the shell. */
const fakeT = (key) => ({ 'readout.balance': 'b', 'readout.session': 's' }[key] ?? key)

const HOUR = 3600_000
const MINUTE = 60_000
/** A fixed instant so the payload below stays meaningful: Friday, off-peak. */
const NOW = Date.parse('2026-09-18T10:00:00Z')

/** One `/dsh-balance` payload. */
const payload = {
  host: { version: '0.1.0', now: NOW, dir: '/tmp', samples: 5, loaded: true },
  balance: {
    ok: true,
    error: null,
    stale: false,
    fetchedAt: NOW - 60000,
    isAvailable: true,
    balances: [{ currency: 'USD', total: 19.52, granted: 0, toppedUp: 19.52 }],
    primary: { currency: 'USD', total: 19.52, granted: 0, toppedUp: 19.52 },
    currency: 'USD',
    currencyPreference: 'USD',
    thresholds: { warning: 10, danger: 5 },
    currencyMissing: false,
  },
  ledger: {
    zone: 'Europe/Moscow',
    currency: 'USD',
    todayKey: '2026-09-18',
    rows: [
      { key: '2026-09-17', spend: 1.5, computed: 1.5, override: null, coarse: false, open: false },
      { key: '2026-09-18', spend: 0.39, computed: 0.39, override: null, coarse: false, open: true },
    ],
    credits: [{ t: NOW - HOUR, amount: 50, fromTotal: 10, toTotal: 60, intervalFrom: NOW - 2 * HOUR }],
    creditTotal: 50,
    totals: {
      d1: { amount: 0.39, covered: true },
      w1: { amount: 2.29, covered: true },
      m1: { amount: 10.43, covered: true },
    },
    firstSampleMs: NOW - 30 * 24 * HOUR,
    lastSampleMs: NOW - MINUTE,
    sampleCount: 5,
    medianGapMs: 300000,
  },
  peak: {
    peak: false,
    phase: 'off-peak',
    reason: 'off-peak',
    untilMs: 2 * 24 * HOUR + 15 * HOUR,
    changeAt: Date.parse('2026-09-21T01:00:00Z'),
    changeToPeak: true,
    nextPeakAt: Date.parse('2026-09-21T01:00:00Z'),
    schedule: [
      { atMs: Date.parse('2026-09-21T01:00:00Z'), toPeak: true, reason: 'peak' },
      { atMs: Date.parse('2026-09-21T04:00:00Z'), toPeak: false, reason: 'off-peak' },
      { atMs: Date.parse('2026-09-21T06:00:00Z'), toPeak: true, reason: 'peak' },
      { atMs: Date.parse('2026-09-21T10:00:00Z'), toPeak: false, reason: 'off-peak' },
    ],
    offPeakRatio: 0.5,
    zone: 'Europe/Moscow',
    windows: { today: ['04:00–07:00', '09:00–13:00'], tomorrow: [] },
    rule: {
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      verifiedOn: '2026-09-27',
      holidays: ['2026-10-01'],
      utcWindows: '01:00–04:00 and 06:00–10:00',
    },
  },
  prices: { current: {}, peak: {}, atPeak: NOW, currency: 'USD' },
  fallbackPrices: null,
  sampling: { refreshIntervalMs: 300000, clientPollIntervalMs: 15000 },
  client: { version: '0.1.0', at: NOW, count: 1, reads: 1, mounts: 1 },
  session: { cost: 0.33, currency: 'USD', models: ['deepseek-flash'], costByModel: { 'deepseek-flash': 0.33 }, tokens: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 1 }, unpriced: [], peakNow: false },
}

/** A fetch stub that answers the read route and records the writes. */
function stubFetch({ posts = [], calls = [] } = {}) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options?.method ?? 'GET', body: options?.body })
    if (options?.method === 'POST') {
      posts.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true, sampling: payload.sampling }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  return () => {
    globalThis.fetch = previous
  }
}

test('the client module registers one plugin with its services', async () => {
  const { registration, exported } = await loadClient()
  assert.equal(registration.id, 'dsh-balance')
  assert.deepEqual(exported.inject, ['slots', 'locale'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply registers the readout before the stats entry, both peak surfaces and the Cost view', async () => {
  const { exported } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const readout = ctx.registered.find((entry) => entry.options.id === 'dsh-balance').options
  assert.equal(readout.name, 'conversation.composer.dock')
  assert.equal(readout.locale, 'dsh-balance')
  assert.ok(readout.order < 0, 'a negative order draws it left of the shipped stats entry (order 0)')
  const peaks = ctx.registered
    .filter((entry) => entry.options.id === 'dsh-balance-peak')
    .map((entry) => entry.options.name)
    .sort()
  assert.deepEqual(peaks, ['conversation.input.overlay', 'conversation.session.header.actions'])
  const cost = ctx.registered.find((entry) => entry.options.id === 'dsh-balance-cost').options
  assert.equal(cost.name, 'conversation.view')
  assert.equal(cost.order, 20, 'directly after Trajectory (order 10) and its own id, not Trajectory’s')
  assert.equal(cost.locale, 'dsh-balance')
  assert.equal(cost.label(), 'view.cost')
  assert.equal(ctx.registered.length, 4)
})

test('the readout renders the compact balance and spend line', async () => {
  const { exported, react } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const Readout = ctx.registered[0].component
  const restore = stubFetch()
  try {
    const props = { t: fakeT, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    const loading = react.createElement(Readout, props)
    const line = (element) => textOf(element).replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim()
    assert.equal(line(loading), '— — —')
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(Readout, props)
    // Balance, the three window totals and the session estimate, with no labels:
    // the pill shares one line with the turn counters and the token pills.
    assert.equal(line(tree), '$19.52 $0.39/$2.29/$10.43 $0.33')
    const pill = find(tree, (element) => element.type === 'button' && element.props?.className === 'dshb_pill')[0]
    assert.ok(pill !== undefined, 'the readout is a pill button, like the token usage pills')
    // The legend is the only place the labels live, since the line itself has none.
    assert.match(pill.props.title, /tip\.balance/)
    assert.match(pill.props.title, /tip\.spend1d\/tip\.spend1w\/tip\.spend1m/)
    assert.match(pill.props.title, /tip\.session/)
    assert.equal(pill.props['aria-expanded'], false)
  } finally {
    react.stop()
    restore()
  }
})

test('the session projection outranks the payload copy of the session cost', async () => {
  const { exported, react } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const Readout = ctx.registered[0].component
  const restore = stubFetch()
  try {
    const props = {
      t: fakeT,
      sessionId: 'session-7',
      useProjection: (key) => (key === 'dshBalanceCost' ? { cost: 0.91, currency: 'USD' } : undefined),
    }
    react.beginRender()
    textOf(react.createElement(Readout, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    assert.equal(
      textOf(react.createElement(Readout, props)).replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim(),
      '$19.52 $0.39/$2.29/$10.43 $0.91',
    )
  } finally {
    react.stop()
    restore()
  }
})

test('the readout asks the Host about the session and its zone', async () => {
  const { exported, react } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const Readout = ctx.registered[0].component
  const calls = []
  const restore = stubFetch({ calls })
  try {
    react.beginRender()
    textOf(react.createElement(Readout, { t: fakeT, sessionId: 'session-7', useProjection: () => undefined }))
    // The first read starts during the render, before the mount effect can hand the
    // store its session id; the store must therefore read once more after that.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reads = calls.filter((call) => call.url.startsWith('/dsh-balance?'))
    assert.ok(reads.length >= 1, calls.map((call) => call.url).join(', '))
    assert.equal(reads.some((call) => /sessionId=session-7/.test(call.url)), true, reads.map((call) => call.url).join(', '))
    assert.equal(reads.every((call) => /zone=/.test(call.url)), true)
    assert.equal(calls.some((call) => call.url === '/dsh-balance/hello' && call.method === 'POST'), true)
    assert.equal(calls.some((call) => String(call.body).includes('"phase":"mount"')), true)
  } finally {
    react.stop()
    restore()
  }
})

test('phaseFromSchedule walks the transitions the Host sent', async () => {
  const { exported } = await loadClient()
  const { phaseFromSchedule } = exported.__internals
  const schedule = payload.peak.schedule
  const off = phaseFromSchedule(schedule, NOW, false, NOW)
  assert.equal(off.phase, 'off-peak')
  assert.equal(off.changeToPeak, true)
  assert.equal(off.untilMs, 2 * 24 * HOUR + 15 * HOUR)
  const soon = phaseFromSchedule(schedule, NOW, false, Date.parse('2026-09-21T00:45:00Z'))
  assert.equal(soon.phase, 'soon', 'the warning lead is half an hour')
  assert.equal(soon.untilMs, 15 * MINUTE)
  const peak = phaseFromSchedule(schedule, NOW, false, Date.parse('2026-09-21T02:00:00Z'))
  assert.equal(peak.phase, 'peak')
  assert.equal(peak.changeToPeak, false)
  assert.equal(peak.untilMs, 2 * HOUR)
  // Past the last transition the schedule decides: it ends off-peak, and no further
  // change is known until the next poll.
  const beyond = phaseFromSchedule(schedule, NOW, true, Date.parse('2026-10-01T00:00:00Z'))
  assert.equal(beyond.phase, 'off-peak')
  assert.equal(beyond.untilMs, null)
  // With no transitions at all the anchor is all there is.
  assert.equal(phaseFromSchedule([], NOW, true, NOW).phase, 'peak')
  assert.equal(phaseFromSchedule([], NOW, false, NOW).phase, 'off-peak')
  assert.equal(phaseFromSchedule(undefined, NOW, true, NOW).untilMs, null)
})

test('the peak chip renders its countdown and hides for a foreign provider', async () => {
  const { exported, react } = await loadClient()
  const catalogSnapshot = () => ({ value: { default: { provider: 'deepseek-official', model: 'deepseek-flash' } } })
  const Chip = exported.__internals.createPeakChip({ forNewSession: false, catalogSnapshot })
  const restore = stubFetch()
  try {
    const props = {
      t: (key) => key,
      useSession: (select) => select({ blank: false, running: false, promptAttempted: false }),
      useProjection: (key) => (key === 'modelSelection' ? { next: null, lastUsed: null } : undefined),
    }
    react.beginRender()
    textOf(react.createElement(Chip, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    assert.match(textOf(react.createElement(Chip, props)), /peak\.chip\.(off|soon|peak)/)

    const foreign = exported.__internals.createPeakChip({
      forNewSession: false,
      catalogSnapshot: () => ({ value: { default: { provider: 'pi-ai', model: 'deepseek-flash' } } }),
    })
    react.beginRender()
    assert.equal(textOf(react.createElement(foreign, props)), '')

    const floating = exported.__internals.createPeakChip({ forNewSession: true, catalogSnapshot })
    react.beginRender()
    assert.equal(textOf(react.createElement(floating, props)), '', 'the floating copy skips a session with a header')
    react.beginRender()
    assert.match(textOf(react.createElement(floating, {
      ...props,
      useSession: (select) => select({ blank: true, running: false, promptAttempted: false }),
    })), /peak\.chip/)
  } finally {
    react.stop()
    restore()
  }
})

test('the route helpers prefer the projection and fall back to the catalog default', async () => {
  const { exported } = await loadClient()
  const { effectiveRoute, routeFromModelSelection, routeFromCatalogDefault, isPeakRuleRoute } = exported.__internals
  assert.deepEqual(
    routeFromModelSelection({ next: { provider: 'deepseek-official', model: 'deepseek-flash' }, lastUsed: null }),
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  )
  assert.deepEqual(routeFromModelSelection({ next: null, lastUsed: { provider: 'pi-ai', model: 'x' } }), { provider: 'pi-ai', model: 'x' })
  assert.equal(routeFromModelSelection(undefined), null)
  assert.deepEqual(
    routeFromCatalogDefault({ value: { default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } } }),
    { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
  )
  assert.equal(routeFromCatalogDefault(undefined), null)
  assert.deepEqual(
    effectiveRoute({ next: null, lastUsed: null }, { value: { default: { provider: 'deepseek-official', model: 'deepseek-flash' } } }),
    { provider: 'deepseek-official', model: 'deepseek-flash' },
  )
  assert.equal(effectiveRoute(undefined, { value: { default: { provider: 'deepseek-official' } } }), null, 'a missing projection is not guessed')
  assert.equal(isPeakRuleRoute('deepseek-official'), true)
  assert.equal(isPeakRuleRoute('pi-ai'), false)
})

test('the panel opens on the summary with the cards in order', async () => {
  const { exported, react } = await loadClient()
  react.beginRender()
  const tree = react.createElement(exported.__internals.Popover, {
    t: (key) => key,
    state: { status: 'ok', payload, error: null, at: Date.now() },
    projection: { cost: 0.33, currency: 'USD' },
    onClose: () => {},
  })
  const text = textOf(tree)
  // Balance, today and this session first, then the week, then the month.
  const order = ['card.balance', 'card.today', 'card.session', 'card.week', 'card.month'].map((key) => text.indexOf(key))
  assert.equal(order.every((index) => index >= 0), true, text)
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the cards render in the intended order')
  assert.match(text, /card\.title/)
  assert.match(text, /tab\.summary/)
  assert.match(text, /tab\.days/)
  // The tab row lists summary first and the summary is what is rendered.
  assert.ok(text.indexOf('tab.summary') < text.indexOf('tab.days'))
  assert.match(text, /tip\.samples/, 'the summary carries the statistics')
  const summaryTab = find(tree, (element) => element.type === 'button' && element.props?.['data-active'] === 'true')[0]
  assert.equal(textOf(summaryTab), 'tab.summary', 'the summary tab is active on open')
  const links = find(tree, (element) => element.type === 'a' && element.props?.className === 'dshb_link')
  assert.equal(links[0].props.href, 'https://api-docs.deepseek.com/quick_start/pricing', 'the rules link points at the English page')
  assert.equal(links[1].props.href, 'https://platform.deepseek.com/usage', 'the platform usage page is linked too')
  assert.equal(links[1].props.target, '_blank')
  // A Host started before the locale fix still reports the Chinese page; the panel
  // normalizes it rather than sending the reader there.
  const chinese = { ...payload, peak: { ...payload.peak, rule: { ...payload.peak.rule, sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing' } } }
  react.beginRender()
  const normalized = find(react.createElement(exported.__internals.Popover, {
    t: (key) => key,
    state: { status: 'ok', payload: chinese, error: null, at: Date.now() },
    projection: { cost: 0.33, currency: 'USD' },
    onClose: () => {},
  }), (element) => element.type === 'a' && element.props?.className === 'dshb_link')[0]
  assert.equal(normalized.props.href, 'https://api-docs.deepseek.com/quick_start/pricing')
})

test('the panel holds the summary height for every tab', async () => {
  const { exported, react } = await loadClient()
  react.beginRender()
  const tree = react.createElement(exported.__internals.Popover, {
    t: (key) => key,
    state: { status: 'ok', payload, error: null, at: Date.now() },
    projection: { cost: 0.33, currency: 'USD' },
    onClose: () => {},
  })
  // The first pass mounts the summary and runs the measuring effect; the second
  // reads the height it stored.
  find(tree, (element) => element.props?.className === 'dshb_popover')
  react.beginRender()
  const panel = find(tree, (element) => element.props?.className === 'dshb_popover')[0]
  assert.equal(panel.props.style.height, '321px', 'the panel keeps the measured summary height')
  const body = find(tree, (element) => element.props?.className === 'dshb_popover_body')[0]
  assert.ok(body !== undefined, 'the panel has a body')
  assert.equal(body.props.style, undefined, 'the body itself is not sized: it fills the panel and scrolls')
  const tabs = find(tree, (element) => element.props?.className === 'dshb_tabs')[0]
  assert.ok(tabs !== undefined, 'the tab row sits outside the body')
})

test('the summary tab spells out every figure the plugin holds', async () => {
  const { exported, react } = await loadClient()
  react.beginRender()
  const tree = react.createElement(exported.__internals.Summary, {
    t: (key) => key,
    state: { status: 'ok', payload, error: null, at: Date.now() },
    projection: { cost: 0.91, currency: 'USD' },
  })
  const text = textOf(tree)
  for (const key of ['tip.balance', 'tip.toppedUp', 'tip.granted', 'tip.spend1d', 'tip.spend1w', 'tip.spend1m', 'tip.session', 'tip.tariff', 'tip.next', 'tip.samples', 'tip.cadence', 'tip.credits', 'tip.fetched']) {
    assert.match(text, new RegExp(key.replace('.', '\\.')), `the summary is missing ${key}`)
  }
  assert.match(text, /\$19\.52/)
  assert.match(text, /\$0\.91/, 'the projection supplies the session figure')
  assert.match(text, /5/, 'the sample count is listed')
  assert.match(text, /5m/, 'the median sampling gap is listed')
})

test('the pill opens the anchored panel, and the catch layer closes it', async () => {
  const { exported, react } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const Readout = ctx.registered.find((entry) => entry.options.id === 'dsh-balance').component
  const restore = stubFetch()
  try {
    const props = { t: fakeT, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(Readout, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(Readout, props)
    assert.equal(find(tree, (element) => element.props?.role === 'dialog').length, 0, 'the panel starts closed')

    const pill = find(tree, (element) => element.type === 'button' && element.props?.className === 'dshb_pill')[0]
    pill.props.onClick()
    react.beginRender()
    tree = react.createElement(Readout, props)
    const dialog = find(tree, (element) => element.props?.role === 'dialog')
    assert.equal(dialog.length, 1, 'clicking the pill opens the panel')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_catch').length, 1, 'an outside-click layer is mounted')
    assert.equal(pill.props['aria-expanded'] === false, true, 'the toggle state is exposed to assistive tech')
  } finally {
    react.stop()
    restore()
  }
})

test('the settings tab posts the fields it edits', async () => {
  const { exported, react } = await loadClient()
  const posts = []
  const restore = stubFetch({ posts })
  try {
    react.beginRender()
    const tree = react.createElement(exported.__internals.Settings, {
      t: (key) => key,
      state: { status: 'ok', payload, error: null, at: Date.now() },
    })
    assert.match(textOf(tree), /settings\.currency/)
    const apply = find(tree, (element) => element.props?.className === 'dshb_btn dshb_btn_primary')[0]
    assert.ok(apply !== undefined, 'the apply button exists')
    await apply.props.onClick()
    const settings = posts.filter((post) => post.url === '/dsh-balance/settings')
    assert.equal(settings.length, 1)
    assert.equal(typeof settings[0].body.currency, 'string')
    assert.equal(typeof settings[0].body.refreshIntervalMs, 'number')
  } finally {
    react.stop()
    restore()
  }
})

test('a day row saves and clears a manual correction through the Host', async () => {  const { exported, react } = await loadClient()
  const posts = []
  const restore = stubFetch({ posts })
  try {
    const ledger = {
      ...payload.ledger,
      rows: [
        ...payload.ledger.rows,
        { key: '2026-09-16', spend: 2.4, computed: 2, override: 2, overrideAt: Date.now() - 3600_000, measuredAfter: 0.4, coarse: true, open: false },
      ],
    }
    react.beginRender()
    const tree = react.createElement(exported.__internals.DaysTable, { t: (key) => key, ledger, currency: 'USD' })
    const flags = textOf(tree)
    assert.match(flags, /days\.coarse/, 'a coarse day is flagged')
    assert.match(flags, /days\.growing/, 'a corrected day shows the samples that arrived after the correction')
    const reset = find(tree, (element) => element.type === 'button' && element.props?.className === 'dshb_btn')[0]
    assert.ok(reset !== undefined, 'the reset button exists for an overridden day')
    await reset.props.onClick()
    const overrides = posts.filter((post) => post.url === '/dsh-balance/overrides')
    assert.deepEqual(overrides.at(-1).body, { date: '2026-09-16', amount: null })
  } finally {
    react.stop()
    restore()
  }
})

//#region cost view

/** One Step record as the session-cost route serves it. */
const costNode = (over = {}) => {
  const buckets = { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6, ...(over.buckets ?? {}) }
  const costByBucket = { uncachedInput: 2, cacheRead: 0, cacheWrite: 0, output: 8, ...(over.costByBucket ?? {}) }
  const half = Object.fromEntries(Object.entries(costByBucket).map(([key, value]) => [key, value / 2]))
  return {
    turn: 1,
    step: 1,
    tStart: NOW - 2 * HOUR,
    tEnd: NOW - 2 * HOUR + MINUTE,
    ended: true,
    hasUsage: true,
    interrupted: false,
    retries: 0,
    evicted: [],
    calls: [],
    buckets,
    byModel: { 'deepseek-flash': { buckets, cost: 10 } },
    cost: 10,
    costByBucket,
    offPeak: { cost: 5, costByBucket: half },
    peak: { cost: 10, costByBucket: { ...costByBucket } },
    unpriced: false,
    unknownModel: false,
    ...over,
  }
}

/** One `/dsh-balance/session-cost` payload. */
const costPayload = (nodes, over = {}) => ({
  ok: true,
  sessionId: 'session-7',
  seq: 5,
  currency: 'CNY',
  nodes,
  rule: {
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    verifiedOn: '2026-09-27',
    holidays: [],
    rates: [],
  },
  peakIntervals: [{ startMs: NOW - 2 * HOUR, endMs: NOW - 2 * HOUR + 30 * MINUTE }],
  ...over,
})

/** A fetch stub answering the series route with the payload under test. */
function stubCostFetch(answer, { calls = [] } = {}) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    if (String(url).startsWith('/dsh-balance/session-cost')) {
      return { ok: true, status: 200, json: async () => (typeof answer === 'function' ? answer() : answer) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  return () => {
    globalThis.fetch = previous
  }
}

test('the chart marks peak windows, turn boundaries and the axis', async () => {
  const { exported, react } = await loadClient()
  const nodes = [
    costNode(),
    costNode({ turn: 1, step: 2, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE }),
    costNode({ turn: 2, step: 1, tStart: NOW - 5 * MINUTE, tEnd: NOW }),
  ]
  const restore = stubCostFetch(costPayload(nodes))
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    assert.match(text, /¥30\.00/, 'the header leads with the session estimate')
    assert.match(text, /cost\.steps/)
    assert.match(text, /cost\.proj\.fact/)
    assert.match(text, /cost\.control\.projection/, 'the projection, metric and axis controls are offered')
    assert.match(text, /cost\.metric\.cacheRead/)
    assert.match(text, /cost\.axis\.index/)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_canvas').length, 1)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_band').length, 1, 'one peak window is shaded')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_sep').length, 2, 'a separator per Turn')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_axis').length, 1)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_grid').length, 5, 'a reference line per tick')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_ylabel').length, 5, 'the vertical scale is labelled')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_yaxis').length, 1)
  } finally {
    react.stop()
    restore()
  }
})

test('the Cost view states its three empty and error states in place', async () => {
  const { exported, react } = await loadClient()
  const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }

  const render = async (answer) => {
    const restore = stubCostFetch(answer)
    try {
      react.beginRender()
      textOf(react.createElement(exported.__internals.CostView, props))
      await new Promise((resolve) => setTimeout(resolve, 10))
      react.beginRender()
      return react.createElement(exported.__internals.CostView, props)
    } finally {
      restore()
    }
  }

  const empty = await render(costPayload([]))
  assert.match(textOf(empty), /cost\.empty\.steps/)
  assert.equal(find(empty, (element) => element.props?.className === 'dshb_cost_canvas').length, 0, 'no blank plot is drawn')

  const noUsage = await render(costPayload([costNode({ hasUsage: false, cost: 0, byModel: {} })]))
  assert.match(textOf(noUsage), /cost\.empty\.steps/, 'a Step without usage is not a point on the chart')

  const unpriced = await render(costPayload([costNode({ cost: 0, unpriced: true, unknownModel: true, byModel: { 'reseller-model': { buckets: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 }, cost: 0 } } })]))
  assert.match(textOf(unpriced), /cost\.empty\.rates/)

  const failed = await render({ ok: false, error: 'unknown-session' })
  const errorText = textOf(failed)
  assert.match(errorText, /cost\.empty\.error/)
  assert.match(errorText, /unknown-session/)
  assert.match(errorText, /—/, 'a failed read leads with a dash, not a zero total')
  assert.doesNotMatch(errorText, /¥0\.00/)
  const retry = find(failed, (element) => element.type === 'button' && element.props?.className === 'dshb_btn')[0]
  assert.ok(retry !== undefined, 'a failed read offers a retry')
  const refetches = []
  const second = stubCostFetch(costPayload([costNode()]), { calls: refetches })
  try {
    await retry.props.onClick()
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(refetches.some((url) => url.startsWith('/dsh-balance/session-cost')), 'the retry re-reads the series')
  } finally {
    second()
  }
  react.stop()
})

/** A fetch stub answering the series route and recording every settings write. */
function stubSeriesAndWrites(series, posts) {
  const previous = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('/dsh-balance/session-cost')) {
      return { ok: true, status: 200, json: async () => series }
    }
    if (options?.method === 'POST') {
      posts.push({ url: String(url), body: options.body === undefined ? undefined : JSON.parse(options.body) })
      return { ok: true, status: 200, json: async () => ({ ok: true, sampling: payload.sampling }) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  return () => {
    globalThis.fetch = previous
  }
}

test('the metric and the Tariff projection move every figure together', async () => {
  const { exported } = await loadClient()
  const { buildPlot, metricOf, seriesSummary } = exported.__internals
  const nodes = [
    costNode(),
    costNode({
      turn: 1,
      step: 2,
      tStart: NOW - HOUR,
      tEnd: NOW - HOUR + MINUTE,
      cost: 4,
      costByBucket: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 3 },
      offPeak: { cost: 2, costByBucket: { uncachedInput: 0.5, cacheRead: 0, cacheWrite: 0, output: 1.5 } },
      peak: { cost: 4, costByBucket: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 3 } },
    }),
  ]

  // The same buckets, priced three ways: the chart and every total move with it.
  assert.equal(metricOf(nodes[0], 'cost'), 10, 'fact is the default')
  assert.equal(metricOf(nodes[0], 'cost', 'offPeak'), 5)
  assert.equal(metricOf(nodes[0], 'cost', 'peak'), 10)
  assert.equal(metricOf(nodes[0], 'tokens', 'peak'), 2e6, 'a token metric ignores the projection')

  const fact = buildPlot(nodes, { width: 300, height: 100, clip: false })
  const offPeak = buildPlot(nodes, { width: 300, height: 100, clip: false, projection: 'offPeak' })
  assert.deepEqual(fact.points.map((point) => point.value), [10, 4])
  assert.deepEqual(offPeak.points.map((point) => point.value), [5, 2])
  assert.notEqual(fact.digest, offPeak.digest, 'the canvas redraws when the projection moves')
  const output = buildPlot(nodes, { width: 300, height: 100, clip: false, metric: 'output' })
  assert.deepEqual(output.points.map((point) => point.value), [1e6, 1e6])
  assert.notEqual(output.digest, fact.digest, 'and when the metric does')

  const summary = seriesSummary(nodes)
  assert.equal(summary.total, 14, 'the fact figure stays available whatever is shown')
  assert.deepEqual(summary.totals, { fact: 14, offPeak: 7, peak: 14 })
})

test('the Step-index axis is labelled by (Turn, Step)', async () => {
  const { exported } = await loadClient()
  const { indexTicks, buildPlot } = exported.__internals
  const nodes = Array.from({ length: 9 }, (_, index) => costNode({
    turn: 2,
    step: index + 1,
    tStart: NOW - (9 - index) * MINUTE,
    tEnd: NOW - (8 - index) * MINUTE,
  }))
  const ticks = indexTicks(nodes, 4)
  assert.equal(ticks.length, 5)
  assert.deepEqual(ticks.map((tick) => tick.x), [0, 0.25, 0.5, 0.75, 1])
  assert.deepEqual(ticks.map((tick) => tick.label), ['2.1', '2.3', '2.5', '2.7', '2.9'])
  assert.deepEqual(indexTicks([], 4), [])
  assert.deepEqual(
    buildPlot(nodes, { width: 80, axis: 'index' }).points.map((point) => point.x),
    [0, 10, 20, 30, 40, 50, 60, 70, 80],
    'points are spaced by index, not by time',
  )
  assert.equal(buildPlot(nodes, { axis: 'index' }).mode, 'index')
})

test('the chart data helpers decimate, clip and band without a DOM', async () => {
  const { exported } = await loadClient()
  const {
    buildPlot, clipThreshold, decimatePoints, linearScale, metricOf, bandRanges, turnSeparators,
    seriesWindow, seriesSummary, seriesState, plotTicks, shareOf, bucketLine,
  } = exported.__internals

  assert.equal(clipThreshold([0, 0, 0]), null, 'nothing positive means nothing to clip')
  const steady = Array.from({ length: 20 }, () => 1)
  assert.equal(clipThreshold([...steady, 1000]), 10, 'a spike above ten times the p95 is clipped')
  assert.equal(clipThreshold([...steady, 5]), 10, 'a spike inside ten times the p95 is not')
  assert.equal(
    clipThreshold(Array.from({ length: 100 }, (_, index) => index + 1)),
    950,
    'the percentile is the 95th of a hundred values, not the 96th',
  )

  const points = Array.from({ length: 10_000 }, (_, index) => ({ x: index / 100, y: index % 7 }))
  const { bars, marks } = decimatePoints(points, 100)
  assert.equal(bars.length, 100, 'one bar per pixel column, not one per Step')
  assert.deepEqual({ min: bars[0].min, max: bars[0].max }, { min: 0, max: 6 }, 'the bar keeps the column extent')
  assert.equal(marks.length, 100, 'the newest point of every column is the marker')

  const scale = linearScale(0, 10, 0, 100)
  assert.equal(scale(5), 50)
  assert.equal(linearScale(3, 3, 0, 100)(3), 0, 'a flat domain collapses instead of dividing by zero')

  const nodes = [
    costNode(),
    costNode({ turn: 1, step: 2, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 1, buckets: { uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    costNode({ turn: 2, step: 1, tStart: NOW - MINUTE, tEnd: NOW, cost: 100, unpriced: true }),
  ]
  assert.equal(metricOf(nodes[1], 'cost'), 1)
  // The canvas repaints only when the digest moves, so the digest has to move for
  // everything the canvas draws — the clipping above all, which leaves the points
  // themselves untouched.
  const clippedPlot = buildPlot(nodes, { width: 300, height: 100, clip: true })
  const unclippedPlot = buildPlot(nodes, { width: 300, height: 100, clip: false })
  assert.notEqual(clippedPlot.threshold, null, 'the spike is clipped')
  assert.equal(unclippedPlot.threshold, null, 'and the reader can take the clipping off')
  assert.notEqual(clippedPlot.digest, unclippedPlot.digest, 'which is a repaint, not a no-op')
  assert.deepEqual(
    buildPlot(nodes, { width: 300, height: 100, clip: true }).digest,
    clippedPlot.digest,
    'while the same inputs still produce the same digest',
  )
  assert.equal(metricOf(nodes[1], 'tokens'), 10)
  assert.equal(metricOf(nodes[0], 'output'), 1e6)
  const { fromMs, toMs } = seriesWindow(nodes)
  assert.equal(fromMs, nodes[0].tStart)
  assert.equal(toMs, nodes[2].tEnd)

  const plot = buildPlot(nodes, { width: 300, height: 100, clip: false })
  assert.equal(plot.points.length, 3)
  assert.deepEqual(plot.points.map((point) => point.x > 0), [false, true, true], 'time is the x axis by default')
  assert.equal(plot.threshold, null, 'clipping off means no threshold')
  // A Step with tokens but no rate is marked, not drawn as a free Step.
  assert.deepEqual(plot.points.map((point) => point.unpriced), [false, false, true])
  assert.ok(plot.points.every((point) => point.y >= 0 && point.y <= 100), 'every point stays inside the plot')
  assert.deepEqual(buildPlot(nodes, { width: 300, height: 100, axis: 'index' }).points.map((point) => point.x), [0, 150, 300])

  // A long session with one outlier: the percentile has enough samples to sit low.
  const long = [
    ...Array.from({ length: 40 }, (_, index) => costNode({ turn: 1, step: index + 1, tStart: NOW - (40 - index) * MINUTE, tEnd: NOW - (39 - index) * MINUTE, cost: 1 })),
    costNode({ turn: 2, step: 1, tStart: NOW, tEnd: NOW + MINUTE, cost: 1000 }),
  ]
  const clipped = buildPlot(long, { width: 300, height: 100, clip: true })
  assert.equal(clipped.points.at(-1).clipped, true, 'the outlier is clipped')
  assert.ok(clipped.threshold < 1000)
  assert.equal(buildPlot(long, { width: 300, height: 100, clip: false }).points.at(-1).clipped, false)
  const unclipped = buildPlot(long, { width: 300, height: 100, clip: false })
  assert.equal(unclipped.threshold, null)
  assert.deepEqual(unclipped.points.at(-1).node, long.at(-1), 'and the whole Step is still the point')

  const bands = bandRanges([{ startMs: fromMs - HOUR, endMs: fromMs + HOUR }], fromMs, toMs)
  assert.equal(bands.length, 1)
  assert.ok(bands[0].from === 0 && bands[0].to > 0 && bands[0].to < 1, 'a window is clipped to the range')
  assert.deepEqual(bandRanges([{ startMs: fromMs - 2 * HOUR, endMs: fromMs - HOUR }], fromMs, toMs), [])
  assert.deepEqual(turnSeparators(nodes, fromMs, toMs).map((separator) => separator.turn), [1, 2])
  assert.equal(plotTicks(fromMs, toMs).length, 5)

  const summary = seriesSummary(nodes)
  assert.equal(summary.total, 111)
  assert.equal(summary.steps, 3)
  assert.deepEqual(summary.unpriced, ['deepseek-flash'], 'the model of an unpriced Step is named')
  assert.equal(seriesState('ok', costPayload(nodes), nodes, summary), 'ok')
  assert.equal(seriesState('ok', costPayload([]), [], seriesSummary([])), 'empty-steps')
  assert.equal(seriesState('error', null, nodes, summary), 'error')
  assert.equal(SeriesStateNoRates(seriesState, seriesSummary), 'empty-rates')
  assert.equal(shareOf(5, 10), '50%')
  assert.equal(shareOf(1, 0), '0%')
  assert.match(bucketLine(nodes[0].buckets), /1000000 in/)
})

/** The no-rates state: tokens were reported, but no rate applies to them. */
function SeriesStateNoRates(seriesState, seriesSummary) {
  const node = costNode({ cost: 0, unpriced: true })
  return seriesState('ok', costPayload([node]), [node], seriesSummary([node]))
}

test('the inspector explains a Step and offers the jump only for a tool call', async () => {
  const { exported, react } = await loadClient()
  const Inspector = exported.__internals.CostInspector
  const props = {
    t: (key) => key,
    node: costNode(),
    currency: 'CNY',
    total: 10,
    peakIntervals: costPayload([]).peakIntervals,
  }
  react.beginRender()
  const tree = react.createElement(Inspector, props)
  const text = textOf(tree)
  assert.match(text, /cost\.inspector\.title/)
  assert.match(text, /deepseek-flash/, 'the model is named on the title line')
  assert.doesNotMatch(text, /cost\.inspector\.model/, 'the model no longer takes a row of its own')
  assert.match(text, /cost\.column\.cost/, 'the cost column of the token table')
  assert.match(text, /cost\.bucket\.in/)
  assert.match(text, /cost\.bucket\.cacheWrite/)
  // Transposed: one row per bucket, one column per figure.
  const cells = find(tree, (element) => element.type === 'td').map((cell) => textOf(cell))
  assert.deepEqual(cells.slice(0, 3), ['cost.bucket.in', '1000000', '¥2.00'])
  assert.deepEqual(cells.slice(3, 6), ['cost.bucket.out', '1000000', '¥8.00'])
  assert.deepEqual(cells.slice(6, 9), ['cost.bucket.cacheRead', '0', '¥0.00'])
  assert.deepEqual(cells.slice(9, 12), ['cost.bucket.cacheWrite', '0', '¥0.00'])
  assert.deepEqual(cells.slice(12, 15), ['cost.bucket.total', '2000000', '¥10.00'], 'the last row is the Step total')
  assert.match(text, /cost\.inspector\.noCalls/)
  assert.match(text, /cost\.inspector\.noFocus/, 'an assistant-only Step has no focus target')
  assert.equal(find(tree, (element) => element.type === 'button' && element.children.join('') === 'cost.inspector.focus').length, 0)
  assert.match(text, /cost\.inspector\.noPrompt/, 'the prompt is not loaded until the reader asks')
  assert.equal(find(tree, (element) => element.type === 'button' && element.children.join('') === 'cost.inspector.loadOlder').length, 1)

  const opened = []
  const loaded = []
  react.beginRender()
  const withCall = react.createElement(Inspector, {
    ...props,
    node: costNode({ calls: [{ name: 'bash', callId: 'call-1', preview: 'ls -la' }] }),
    inspectCall: (callId) => opened.push(callId),
    loadPrompt: async (node) => {
      loaded.push(node.turn)
      return 'where did the money go?'
    },
  })
  const focus = find(withCall, (element) => element.type === 'button' && element.children.join('') === 'cost.inspector.focus')[0]
  assert.ok(focus !== undefined, 'a Step with a tool call offers the Trajectory jump')
  focus.props.onClick()
  assert.deepEqual(opened, ['call-1'])
  const older = find(withCall, (element) => element.type === 'button' && element.children.join('') === 'cost.inspector.loadOlder')[0]
  assert.ok(older !== undefined, 'the prompt is behind an explicit action')
  await older.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(loaded, [1], 'the prompt was asked for by the Step it belongs to')
  const shown = react.createElement(Inspector, {
    ...props,
    node: costNode({ calls: [{ name: 'bash', callId: 'call-1', preview: 'ls -la' }] }),
    loadPrompt: async () => 'where did the money go?',
  })
  assert.match(textOf(shown), /where did the money go\?/, 'and the words appear where the offer was')
  assert.doesNotMatch(textOf(shown), /cost\.inspector\.loadOlder/, 'the offer is gone once the prompt is there')
  assert.doesNotMatch(textOf(shown), /cost\.inspector\.noPrompt/)

  // Another Step starts over: the prompt of the previous one is not carried over.
  const moved = react.createElement(Inspector, {
    ...props,
    node: costNode({ turn: 2, step: 1 }),
    loadPrompt: async () => 'the other question',
  })
  assert.match(textOf(moved), /cost\.inspector\.noPrompt/, 'a Step of its own asks again')
  assert.doesNotMatch(textOf(moved), /where did the money go\?/)
  react.stop()
})

//#endregion

test('the tooltip stays inside the plot at every edge', async () => {
  const { exported } = await loadClient()
  const { tooltipPlacement } = exported.__internals
  const box = { width: 300, height: 200, tipWidth: 160, tipHeight: 70 }

  const left = tooltipPlacement({ x: 2, y: 100 }, box)
  assert.equal(left.left, 88, 'a point at the left edge keeps half the tooltip inside')
  assert.equal(left.transform, 'translate(-50%, -108%)')

  const right = tooltipPlacement({ x: 298, y: 100 }, box)
  assert.equal(right.left, 212, 'and the same at the right edge')
  assert.ok(right.left + box.tipWidth / 2 <= box.width, 'the tooltip never pokes out')

  const top = tooltipPlacement({ x: 150, y: 4 }, box)
  assert.match(top.transform, /translate\(-50%, 14px\)/, 'with no room above, the tooltip drops below the point')
  assert.equal(top.left, 150, 'a middle point stays centred')

  const narrow = tooltipPlacement({ x: 40, y: 100 }, { width: 60, height: 100, tipWidth: 160, tipHeight: 70 })
  assert.ok(narrow.left >= 0, 'a tooltip wider than the plot is still pinned inside it')
  const empty = tooltipPlacement({ x: 0, y: 0 }, {})
  assert.equal(empty.left, 98, 'a missing plot size falls back to the default tooltip width')
})

test('per-Step costs keep their decimals instead of rounding to 0.00', async () => {
  const { exported, react } = await loadClient()
  const { costDigits, costText } = exported.__internals
  assert.equal(costDigits(0.318674), 2, 'a session total keeps the familiar two decimals')
  assert.equal(costText(0.318674, 'USD'), '$0.32')
  assert.equal(costText(0.0421, 'USD'), '$0.042', 'tens of cents show three')
  assert.equal(costText(0.001234, 'USD'), '$0.0012', 'a step below a cent shows four')
  assert.equal(costText(0.0000123, 'CNY'), '¥0.00001', 'and a really small one shows five')
  assert.equal(costDigits(0), 2)
  assert.equal(costDigits(Number.NaN), 2)
  assert.equal(costText(null, 'USD'), '—', 'an absent figure stays a dash')

  // The inspector is where a single Step's cost is read.
  react.beginRender()
  const tree = react.createElement(exported.__internals.CostInspector, {
    t: (key) => key,
    node: costNode({ cost: 0.001234, costByBucket: { uncachedInput: 0.001234, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    currency: 'USD',
    total: 0.318674,
    peakIntervals: [],
  })
  assert.match(textOf(tree), /\$0\.0012/, 'the inspector does not round a Step away')
  react.stop()
})


test('the vertical scale is rounded, labelled and metric-aware', async () => {
  const { exported } = await loadClient()
  const { valueAxis, compactNumber, tickLabel } = exported.__internals

  const axis = valueAxis(0.318674)
  assert.equal(axis.max, 0.4, 'the scale rounds up to a readable step')
  assert.equal(axis.ticks.length, 5)
  assert.deepEqual(axis.ticks.map((tick) => tick.fraction), [0, 0.25, 0.5, 0.75, 1])
  assert.deepEqual(axis.ticks.map((tick) => Number(tick.value.toFixed(6))), [0, 0.1, 0.2, 0.3, 0.4])
  assert.ok(axis.max >= 0.318674, 'nothing is cut off by the rounding')

  assert.equal(valueAxis(10).max, 10, 'an exact step is not inflated')
  assert.equal(valueAxis(0.0132).max, 0.02)
  assert.equal(valueAxis(0).max, 1, 'an empty series still has a scale')
  assert.equal(valueAxis(Number.NaN).max, 1)

  assert.equal(compactNumber(1_234_567), '1.2M')
  assert.equal(compactNumber(12_340_000), '12M')
  assert.equal(compactNumber(2345), '2.3k')
  assert.equal(compactNumber(42), '42')
  assert.equal(tickLabel(0.005, 'cost', 'USD'), '$0.0050', 'a money tick keeps its cents')
  assert.equal(tickLabel(2000, 'tokens', 'USD'), '2.0k', 'a token tick is compact')
})

test('the tooltip names the model beside the Step, not on its own line', async () => {
  const { exported } = await loadClient()
  const { tooltipLines } = exported.__internals
  const lines = tooltipLines(costNode({ cost: 0.0049, buckets: { uncachedInput: 156, cacheRead: 184960, cacheWrite: 0, output: 7224 } }), {
    t: (key, params) => (key === 'cost.tip.turn' ? `Turn ${params.turn} · Step ${params.step}` : key),
    currency: 'USD',
    total: 0.35,
    intervals: [],
  })
  assert.equal(lines.length, 4, 'the tooltip is four lines')
  assert.equal(lines[0], 'Turn 1 · Step 1 · deepseek-flash', 'the model shares the Step line')
  assert.match(lines[1], /^\d{2}:\d{2} · cost\.tip\.phase\.off-peak$/, 'the time and the tariff phase share one line')
  assert.equal(lines[2], '156 in · 7224 out · 184960 cache read · 0 cache write', 'input and output first, then the caches')
  assert.match(lines[3], /^\$0\.0049 · cost\.tip\.share$/)
  assert.ok(!lines.some((line) => line === 'deepseek-flash'), 'the model never takes a line of its own')

  const unnamed = tooltipLines(costNode({ byModel: {} }), { t: (key, params) => (key === 'cost.tip.turn' ? `Turn ${params.turn} · Step ${params.step}` : key) })
  assert.equal(unnamed[0], 'Turn 1 · Step 1', 'a Step without a priced model keeps a clean head')
})


test('the cost column of the inspector adds up to its total', async () => {
  const { exported, react } = await loadClient()
  const { costColumnDigits, costCell } = exported.__internals
  assert.equal(costColumnDigits([0.000175, 0.001101, 0, 0.002056, 0.003332]), 6, 'a sub-cent value forces the host resolution')
  assert.equal(costColumnDigits([2, 8, 0, 0, 10]), 2, 'a column of whole cents keeps two decimals')
  assert.equal(costCell(0.000175, 'USD', 6), '$0.000175')
  assert.equal(costCell(0, 'USD', 6), '$0.000000', 'every cell of the column prints the same digits')
  assert.equal(costCell(2, 'USD', 2), '$2.00')

  const costByBucket = { uncachedInput: 0.000175, cacheRead: 0.001101, cacheWrite: 0, output: 0.002056 }
  const total = 0.003332
  react.beginRender()
  const tree = react.createElement(exported.__internals.CostInspector, {
    t: (key) => key,
    node: costNode({ cost: total, costByBucket }),
    currency: 'USD',
    total: 0.42,
    peakIntervals: [],
  })
  // Every row prints the same number of decimals, and the column adds up.
  const rows = find(tree, (element) => element.type === 'tr').slice(1)
  const money = rows.map((row) => textOf(find(row, (element) => element.type === 'td')[2]))
  assert.deepEqual(money, ['$0.000175', '$0.002056', '$0.001101', '$0.000000', '$0.003332'], 'in, out, cache read, cache write, then the total')
  const decimals = money.map((cell) => cell.split('.')[1].length)
  assert.deepEqual([...new Set(decimals)], [6], 'the same number of digits after the point')
  const numbers = money.map((cell) => Number(cell.replace('$', '')))
  assert.equal(Number(numbers.slice(0, 4).reduce((sum, value) => sum + value, 0).toFixed(6)), numbers[4], 'the bucket costs add up to the printed total')
  assert.equal(numbers[4], total)
  assert.equal(textOf(rows[0]), 'cost.bucket.in 1000000 $0.000175', 'a row reads bucket, tokens, cost')
  assert.equal(textOf(rows[4]).startsWith('cost.bucket.total 2000000'), true, 'the total row sums the tokens too')
  react.stop()
})

test('the top rows follow the metric and always carry their cost', async () => {
  const { exported } = await loadClient()
  const { topRows, sumBuckets } = exported.__internals
  const nodes = [
    costNode({ turn: 1, step: 1, tStart: NOW - 3 * HOUR, tEnd: NOW - 3 * HOUR + MINUTE, cost: 1, buckets: { uncachedInput: 10, cacheRead: 0, cacheWrite: 0, output: 100 } }),
    costNode({
      turn: 1, step: 2, tStart: NOW - 2 * HOUR, tEnd: NOW - 2 * HOUR + MINUTE, cost: 4,
      buckets: { uncachedInput: 0, cacheRead: 4000, cacheWrite: 0, output: 0 },
      calls: [{ name: 'bash', callId: 'call-1', preview: 'git status\nsecond line' }],
    }),
    costNode({ turn: 2, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 2, buckets: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 2000 } }),
  ]

  const byCost = topRows(nodes, { metric: 'cost' })
  assert.deepEqual(byCost.map((row) => row.step), [2, 1, 1], 'ranked by cost, best first')
  assert.deepEqual(byCost.map((row) => row.index), [1, 2, 0], 'each row selects its own Step')
  assert.ok(byCost.every((row) => typeof row.cost === 'number'), 'the cost stays in every row')
  assert.deepEqual(byCost[0].buckets, nodes[1].buckets)
  assert.equal(byCost[0].call.name, 'bash', 'a row names the tool it called')

  // An unpriced Step is worth nothing under the money metric, but the spec puts it in
  // top-K anyway: it is the one row the reader has to price.
  const withUnpriced = [...nodes, costNode({
    turn: 3, step: 1, tStart: NOW, tEnd: NOW + MINUTE, cost: 0, unpriced: true,
    buckets: { uncachedInput: 500, cacheRead: 0, cacheWrite: 0, output: 0 },
  })]
  const ranked = topRows(withUnpriced, { metric: 'cost' })
  assert.equal(ranked.length, 4, 'the unpriced Step keeps its row')
  assert.equal(ranked.at(-1).turn, 3, 'ranked last, because it is worth nothing')
  assert.equal(ranked.at(-1).unpriced, true, 'and marked as unpriced')
  assert.deepEqual(topRows(nodes, { metric: 'cost' }).length, 3, 'while a priced Step worth nothing is not invented')

  const byCacheRead = topRows(nodes, { metric: 'cacheRead' })
  assert.deepEqual(byCacheRead.map((row) => row.index), [1], 'only the Step with cache reads ranks')
  assert.equal(byCacheRead[0].cost, 4, 'and it still shows its cost')
  assert.deepEqual(topRows(nodes, { metric: 'output' }).map((row) => row.index), [2, 0], 'output ranks the other way')

  // Top Turns fold their Steps and name the Step that drove the Turn's rank.
  const turns = topRows(nodes, { metric: 'cost', mode: 'turns' })
  assert.deepEqual(turns.map((row) => row.turn), [1, 2])
  assert.equal(turns[0].steps, 2, 'both Steps of Turn 1 are in one row')
  assert.equal(turns[0].step, 2, 'the heaviest Step of the Turn is the one named')
  assert.equal(turns[0].index, 1, 'and it is what the row selects')
  assert.equal(turns[0].cost, 5, 'the Turn row sums its Steps')
  assert.equal(turns[0].value, 5)
  assert.deepEqual(turns[1].buckets, nodes[2].buckets)

  assert.equal(topRows(nodes, { metric: 'cost', count: 2 }).length, 2, 'the list is capped')
  assert.deepEqual(topRows([], { metric: 'cost' }), [])
  const zero = costNode({ cost: 0, buckets: { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 } })
  assert.deepEqual(topRows([zero], { metric: 'cost' }), [], 'a Step with nothing to rank is not a top row')
  assert.deepEqual(sumBuckets(nodes).output, 2100)
})

test('the visible window zooms, pans and slices the series', async () => {
  const { exported } = await loadClient()
  const { zoomWindow, panWindow, clampWindow, isFullWindow, visibleSlice, seriesWindow } = exported.__internals
  const nodes = Array.from({ length: 11 }, (_, index) => costNode({
    turn: 1,
    step: index + 1,
    tStart: NOW - (11 - index) * MINUTE,
    tEnd: NOW - (10 - index) * MINUTE,
  }))

  assert.equal(isFullWindow(null), true)
  assert.equal(isFullWindow({ from: 0.2, to: 0.4 }), false)
  assert.equal(isFullWindow(clampWindow(0, 1)), true)

  // Zoom in holds the anchored fraction, zoom out walks back towards the whole series.
  assert.deepEqual(zoomWindow(null, 0.8, 0.5), { from: 0.1, to: 0.9 })
  assert.deepEqual(zoomWindow({ from: 0.2, to: 0.6 }, 0.5, 0), { from: 0.2, to: 0.4 })
  assert.deepEqual(zoomWindow({ from: 0.2, to: 0.6 }, 0.5, 1), { from: 0.4, to: 0.6 })
  assert.deepEqual(zoomWindow(null, 4, 0.5), { from: 0, to: 1 }, 'zooming out past the series is clamped')
  const floor = zoomWindow({ from: 0.2, to: 0.4 }, 1e-6, 0.5)
  assert.equal(Number((floor.to - floor.from).toFixed(6)), 0.004, 'and zooming in stops at the floor')
  assert.ok(Math.abs(floor.from - 0.3) < 1e-6, 'which stays centred on the anchor')

  assert.deepEqual(panWindow({ from: 0.2, to: 0.4 }, -0.5), { from: 0.1, to: 0.3 })
  assert.deepEqual(panWindow({ from: 0.2, to: 0.4 }, 5), { from: 0.8, to: 1 }, 'panning stops at the right edge')
  assert.deepEqual(panWindow(null, 0.5), { from: 0, to: 1 }, 'the whole series cannot slide')

  const full = visibleSlice(nodes, null, 'time')
  assert.equal(full.nodes.length, 11)
  assert.deepEqual({ fromMs: full.fromMs, toMs: full.toMs }, seriesWindow(nodes))

  const half = visibleSlice(nodes, { from: 0, to: 0.5 }, 'time')
  assert.equal(half.nodes.length, 6, 'half the time span, the first six Steps')
  assert.equal(half.fromMs, seriesWindow(nodes).fromMs, 'the axis spans the window, not the slice')
  assert.ok(half.toMs < seriesWindow(nodes).toMs)
  assert.equal(half.nodes[0].step, 1)

  assert.deepEqual(visibleSlice(nodes, { from: 0.8, to: 1 }, 'index').nodes.map((node) => node.step), [9, 10, 11], 'the index axis slices Steps, not instants')
  assert.deepEqual(visibleSlice(nodes, { from: 0.2, to: 0.4 }, 'index').nodes.map((node) => node.step), [3, 4, 5])
  assert.deepEqual(visibleSlice([], { from: 0.2, to: 0.4 }, 'time').nodes, [])
})

test('the chart zooms with the wheel, pans on the right button and brushes a range', async () => {
  const { exported, react } = await loadClient()
  const windows = []
  const selected = []
  const nodes = Array.from({ length: 20 }, (_, index) => costNode({
    turn: 1,
    step: index + 1,
    tStart: NOW - (20 - index) * MINUTE,
    tEnd: NOW - (19 - index) * MINUTE,
    cost: index + 1,
  }))
  // The stub keeps hook state in flat slots, so every gesture is taken from the render
  // that follows the last one: a handler closes over the state of its own render.
  const render = (range) => {
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostChart, {
      t: (key) => key,
      nodes,
      payload: costPayload(nodes),
      clip: false,
      currency: 'CNY',
      total: 20,
      axis: 'time',
      metric: 'cost',
      projection: 'fact',
      range,
      onWindow: (next) => windows.push(next),
      selected: -1,
      onSelect: (index) => selected.push(index),
    })
    textOf(tree)
    return { plot: find(tree, (element) => element.props?.className === 'dshb_cost_plot')[0], tree }
  }

  // Wheel: an 0.8 factor anchored at the pointer, `preventDefault` so the page does not scroll.
  let prevented = 0
  const wheelPlot = render(null).plot
  wheelPlot.props.onWheel({ deltaY: -1, clientX: 360, preventDefault: () => { prevented += 1 } })
  // The zoom itself rides React's passive listener; a native listener beside it is
  // what actually stops the panel from scrolling, and it must not zoom as well.
  // The stub re-runs effects on every traversal instead of tracking mount and update,
  // so the newest native listener stands in for the single one a browser would hold.
  const native = wheelPlot.props.ref.current.listeners.wheel
  assert.ok(native.length >= 1, 'the plot listens for the wheel natively')
  let refused = 0
  const windowsBefore = windows.length
  native.at(-1)({ deltaY: -1, clientX: 360, preventDefault: () => { refused += 1 } })
  assert.equal(refused, 1, 'and refuses the scroll the passive listener cannot')
  assert.equal(windows.length, windowsBefore, 'without zooming a second time')
  assert.equal(prevented, 1)
  assert.deepEqual(windows.at(-1), { from: 0.1, to: 0.9 })

  // Right-drag pans by the pixel distance, as a fraction of the window on screen.
  let pan = render({ from: 0.2, to: 0.4 }).plot
  pan.props.onMouseDown({ button: 2, clientX: 300 })
  pan.props.onMouseMove({ button: 2, clientX: 372 })
  assert.deepEqual(windows.at(-1), { from: 0.18, to: 0.38 })

  // Left-drag brushes: the interval is drawn while it is dragged and becomes the window.
  let brush = render(null).plot
  brush.props.onMouseDown({ button: 0, clientX: 100 })
  brush = render(null).plot
  brush.props.onMouseMove({ clientX: 200 })
  const drawn = render(null).tree
  const selection = find(drawn, (element) => element.props?.className === 'dshb_cost_brush')
  assert.equal(selection.length, 1, 'the dragged interval is drawn')
  assert.equal(selection[0].props.style.left, '100px')
  assert.equal(selection[0].props.style.width, '100px')
  const plot = find(drawn, (element) => element.props?.className === 'dshb_cost_plot')[0]
  plot.props.onMouseUp()
  const range = windows.at(-1)
  assert.ok(Math.abs(range.from - 100 / 720) < 1e-5 && Math.abs(range.to - 200 / 720) < 1e-5, 'the brushed columns become the window')
  // The click that follows the brush must not select a point of the range that just left.
  plot.props.onClick({ clientX: 150 })
  assert.deepEqual(selected, [])

  // A click that did not drag still selects the nearest point.
  const single = render(null).plot
  single.props.onClick({ clientX: single ? 0 : 0 })
  assert.deepEqual(selected, [0])
  react.stop()
})

test('the Turns top-K mode bands the chart by Turn', async () => {
  const { exported, react } = await loadClient()
  const { turnSpans } = exported.__internals
  const nodes = [
    costNode({ turn: 1, step: 1, tStart: NOW - 4 * HOUR, tEnd: NOW - 4 * HOUR + MINUTE }),
    costNode({ turn: 1, step: 2, tStart: NOW - 3 * HOUR, tEnd: NOW - 3 * HOUR + MINUTE }),
    costNode({ turn: 2, step: 1, tStart: NOW - 2 * HOUR, tEnd: NOW - 2 * HOUR + MINUTE }),
    costNode({ turn: 3, step: 1, tStart: NOW - HOUR, tEnd: NOW }),
  ]
  const points = nodes.map((node, index) => ({ index, node, x: index * 100 }))
  assert.deepEqual(turnSpans(points, 320), [
    { turn: 1, from: 0, to: 200 },
    { turn: 2, from: 200, to: 300 },
    { turn: 3, from: 300, to: 320 },
  ], 'a Turn runs up to where the next one starts, so the bands tile the axis')
  assert.deepEqual(turnSpans([], 320), [])

  const render = (topk) => {
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostChart, {
      t: (key) => key,
      nodes,
      payload: costPayload(nodes),
      clip: false,
      currency: 'CNY',
      total: 40,
      axis: 'time',
      metric: 'cost',
      projection: 'fact',
      range: null,
      topk,
      onWindow: () => {},
      selected: -1,
      onSelect: () => {},
    })
    textOf(tree)
    return tree
  }

  const banded = render('turns')
  const bands = find(banded, (element) => element.props?.className?.includes?.('dshb_cost_turn') === true &&
    element.props?.className?.includes?.('Label') !== true)
  assert.equal(bands.length, 3, 'one band per Turn')
  // The four Steps sit at 0, 180, 360 and 540 of the 720px plot: Turn 1 owns the span
  // up to where Turn 2 begins, and the last band reaches the right edge.
  assert.deepEqual(bands.map((band) => band.props.style.left), ['0px', '360px', '540px'])
  assert.deepEqual(bands.map((band) => band.props.style.width), ['360px', '180px', '180px'])
  assert.equal(textOf(find(banded, (element) => element.props?.className === 'dshb_cost_turnLabel')[0]), 'T1')
  const plain = find(render('steps'), (element) => element.props?.className?.includes?.('dshb_cost_turn') === true &&
    element.props?.className?.includes?.('Label') !== true)
  assert.equal(plain.length, 0, 'the Step mode leaves the chart unbanded')
  react.stop()
})

test('the inspector sits beside the top list, not below it', async () => {
  const { exported, react } = await loadClient()
  const nodes = [
    costNode({ cost: 10, calls: [{ name: 'bash', callId: 'call-1', preview: 'ls' }] }),
    costNode({ turn: 1, step: 2, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 4 }),
  ]
  const restore = stubSeriesAndWrites(costPayload(nodes), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined, inspectCall: () => {} }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    textOf(tree)
    const panes = find(tree, (element) => element.props?.className === 'dshb_cost_panes')
    assert.equal(panes.length, 1, 'the two cards share one grid')
    const listed = panes[0].children ?? []
    const children = Array.isArray(listed[0]) ? listed[0] : listed
    assert.equal(children.length, 3, 'the session reading, the top list and the findings list')
    assert.equal(children[0].props.className, 'dshb_cost_pane', 'inspector first, so it is the left column')
    assert.match(textOf(children[0]), /cost\.inspector\.empty/)
    assert.match(textOf(children[1]), /cost\.topk\.title/)
    assert.match(textOf(children[2]), /cost\.findings\.title/, 'and the findings card closes the band')
    assert.equal(
      find(tree, (element) => (element.props?.className ?? '').includes('dshb_cost_card')).length, 3,
      'three cards of equal height: the inspector, the top list and the findings list',
    )
  } finally {
    react.stop()
    restore()
  }
})

test('the Step reached from Trajectory is still marked when the view comes back', async () => {
  const { exported, react } = await loadClient()
  const jumped = []
  const nodes = [
    costNode({ turn: 1, step: 1, cost: 10, calls: [{ name: 'bash', callId: 'call-1', preview: 'ls' }] }),
    costNode({ turn: 2, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 4 }),
  ]
  const restore = stubSeriesAndWrites(costPayload(nodes), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined, inspectCall: (id) => jumped.push(id) }
    const mount = async () => {
      react.beginRender()
      textOf(react.createElement(exported.__internals.CostView, props))
      await new Promise((resolve) => setTimeout(resolve, 10))
      react.beginRender()
      const tree = react.createElement(exported.__internals.CostView, props)
      textOf(tree)
      return tree
    }

    let tree = await mount()
    const row = find(tree, (element) => element.props?.className?.includes?.('dshb_topk_row') === true)[0]
    assert.ok(row !== undefined, 'the top list has rows')
    row.props.onClick()
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    textOf(tree)
    assert.match(textOf(tree), /cost\.inspector\.title/, 'the row opened its Step')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_mark').length, 1, 'and the chart marks it')
    assert.match(textOf(find(tree, (element) => element.props?.className?.includes?.('dshb_topk_row_on') === true)[0]), /¥10\.00/)
    const focus = find(tree, (element) => element.props?.className === 'dshb_btn' && element.children?.join('') === 'cost.inspector.focus')[0]
    await focus.props.onClick()
    assert.deepEqual(jumped, ['call-1'], 'the jump carries the call')

    // The conversation unmounts the Cost view when Trajectory becomes active, so the
    // Step has to be remembered outside it: coming back must mark the same one. The
    // unmount drops every hook value, so a Step kept in component state would be lost.
    react.unmount()
    const back = await mount()
    assert.match(textOf(back), /cost\.inspector\.title/, 'the Step is still open after the round trip')
    assert.equal(find(back, (element) => element.props?.className === 'dshb_cost_mark').length, 1)
    const onRow = find(back, (element) => element.props?.className?.includes?.('dshb_topk_row_on') === true)
    assert.equal(onRow.length, 1, 'and its row is still the one marked')
    assert.match(textOf(onRow[0]), /¥10\.00/, 'which is the Step that was open, not just any Step')

    // Zooming is a deliberate change of what is on screen: it drops the selection.
    const plot = find(back, (element) => element.props?.className === 'dshb_cost_plot')[0]
    plot.props.onWheel({ deltaY: -1, clientX: 200, preventDefault: () => {} })
    react.beginRender()
    const zoomed = react.createElement(exported.__internals.CostView, props)
    textOf(zoomed)
    assert.doesNotMatch(textOf(zoomed), /cost\.inspector\.title/, 'a new window starts with nothing selected')
  } finally {
    react.stop()
    restore()
  }
})

test('the arrow keys walk the Steps of the visible slice', async () => {
  const { exported } = await loadClient()
  const { arrowDelta, nextSelection } = exported.__internals

  assert.equal(arrowDelta({ key: 'ArrowRight' }), 1)
  assert.equal(arrowDelta({ key: 'ArrowLeft' }), -1)
  assert.equal(arrowDelta({ key: 'ArrowUp' }), 0)
  assert.equal(arrowDelta({ key: 'ArrowRight', ctrlKey: true }), 0, 'a modifier means the shell, not the chart')
  assert.equal(arrowDelta({ key: 'ArrowRight', target: { tagName: 'INPUT' } }), 0, 'a caret keeps its arrows')
  assert.equal(arrowDelta({ key: 'ArrowLeft', target: { tagName: 'textarea' } }), 0)
  assert.equal(arrowDelta({ key: 'ArrowLeft', target: { isContentEditable: true } }), 0)
  assert.equal(arrowDelta(null), 0)

  assert.equal(nextSelection(-1, 1, 5), 0, 'the right arrow enters at the first Step')
  assert.equal(nextSelection(-1, -1, 5), 4, 'the left arrow enters at the last')
  assert.equal(nextSelection(2, 1, 5), 3)
  assert.equal(nextSelection(2, -1, 5), 1)
  assert.equal(nextSelection(0, -1, 5), 0, 'and neither end wraps around')
  assert.equal(nextSelection(4, 1, 5), 4)
  assert.equal(nextSelection(3, 1, 0), -1, 'nothing on screen means nothing to select')
  assert.equal(nextSelection(9, 1, 5), 0, 'a stale index starts over instead of pointing nowhere')
})

test('a stored projection and metric come back on mount, and a click is written through', async () => {
  const { exported, react } = await loadClient()
  const posts = []
  const nodes = [costNode(), costNode({ turn: 1, step: 2, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE })]
  const restore = stubSeriesAndWrites(costPayload(nodes, {
    prefs: { costProjection: 'offPeak', costMetric: 'output', costAxis: 'index' },
  }), posts)
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    // The peak bands and Turn separators are time facts: the Step-index axis drops them.
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_band').length, 0)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_sep').length, 0)
    assert.match(text, /1\.2/, 'the axis is labelled by (Turn, Step)')
    // The headline follows the stored projection and the fact figure stays beside it.
    assert.match(text, /¥10\.00/, 'the off-peak total leads')
    assert.match(text, /cost\.fact/, 'and the fact figure is still labelled beside it')
    assert.match(text, /cost\.proj\.offPeak/)

    const metric = find(tree, (element) => element.type === 'button' && element.children?.join('') === 'cost.metric.cost')[0]
    assert.ok(metric !== undefined, 'the metric control is on screen')
    await metric.props.onClick()
    const settings = posts.filter((post) => post.url === '/dsh-balance/settings')
    assert.equal(settings.length, 1)
    assert.deepEqual(settings[0].body, { costMetric: 'cost' })

    // Zoom and brush are transient: they must never reach the settings route (D34).
    const plot = find(tree, (element) => element.props?.className === 'dshb_cost_plot')[0]
    plot.props.onWheel({ deltaY: -1, clientX: 200, preventDefault: () => {} })
    react.beginRender()
    const zoomed = react.createElement(exported.__internals.CostView, props)
    textOf(zoomed)
    assert.match(textOf(zoomed), /cost\.session/, 'the header now speaks for the visible range')
    assert.match(textOf(zoomed), /cost\.zoom\.reset/, 'and offers a way back to the whole session')
    assert.equal(posts.filter((post) => post.url === '/dsh-balance/settings').length, 1, 'no window was persisted')
  } finally {
    react.stop()
    restore()
  }
})

test('an unpriced Step offers its rate, and saving it writes through the settings route', async () => {
  const { exported, react } = await loadClient()
  const posts = []
  const unpriced = costNode({
    cost: 0,
    unpriced: true,
    unknownModel: true,
    buckets: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 },
    byModel: { 'reseller-model': { buckets: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, cost: 0 } },
  })
  const restore = stubSeriesAndWrites(costPayload([unpriced]), posts)
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    assert.match(textOf(tree), /cost\.empty\.rates/, 'no rate applies to the only model')
    assert.match(textOf(tree), /reseller-model/, 'the model to price is named')

    const inputs = find(tree, (element) => element.type === 'input')
    assert.equal(inputs.length, 3, 'one field per rate')
    const values = ['2', '0.1', '8']
    inputs.forEach((input, index) => input.props.onChange({ target: { value: values[index] } }))

    // The save closure reads the draft of the render it was taken from, so the tree
    // is traversed once more before the button is pressed.
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    textOf(tree)
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    const save = find(tree, (element) => element.props?.className === 'dshb_btn dshb_btn_primary dshb_rates_save')[0]
    assert.ok(save !== undefined, 'the rate editor has its own save')
    await save.props.onClick()
    const settings = posts.filter((post) => post.url === '/dsh-balance/settings')
    assert.equal(settings.length, 1)
    assert.deepEqual(settings[0].body, {
      fallbackRates: { 'reseller-model': { cacheMiss: 2, cacheHit: 0.1, output: 8 } },
    })
  } finally {
    react.stop()
    restore()
  }
})

test('the settings tab shows a rate block for an unpriced model, and its own save writes them', async () => {
  const { exported, react } = await loadClient()
  const posts = []
  const restore = stubFetch({ posts })
  try {
    const withRates = {
      ...payload,
      fallbackRates: { 'reseller-model': { cacheHit: 0.1, cacheMiss: 2, output: 8 } },
      session: { ...(payload.session ?? {}), unpriced: ['reseller-model'] },
    }
    react.beginRender()
    const tree = react.createElement(exported.__internals.Settings, {
      t: (key) => key,
      state: { status: 'ok', payload: withRates, error: null, at: Date.now() },
    })
    const text = textOf(tree)
    assert.match(text, /settings\.fallbackRates/, 'the rates have their own block')
    assert.match(text, /reseller-model/, 'the model the session could not price is offered')
    assert.match(text, /cost\.rates\.note/, 'the block warns that saving reprices the history')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_btn dshb_btn_primary dshb_rates_save').length, 1)

    const apply = find(tree, (element) => element.props?.className === 'dshb_btn dshb_btn_primary')[0]
    assert.ok(apply !== undefined, 'the panel keeps its own Apply button')
    await apply.props.onClick()
    const panel = posts.filter((post) => post.url === '/dsh-balance/settings').at(-1)
    assert.equal(typeof panel.body.currency, 'string', 'Apply still writes the panel fields')
  } finally {
    react.stop()
    restore()
  }
})

test('the rate editor writes the rates it holds, and an empty row clears one', async () => {
  const { exported, react } = await loadClient()
  const RateEntry = exported.__internals.RateEntry
  const writes = []
  const onSave = async (next) => {
    writes.push(next)
  }
  const rates = { 'reseller-model': { cacheHit: 0.1, cacheMiss: 2, output: 8 } }
  /**
   * Type one row of the editor and press save, then read the status back. The stub
   * keeps hook state between render passes, so each step needs a fresh tree.
   */
  const typeAndSave = async (values) => {
    const mount = () => {
      react.beginRender()
      return react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
    }
    find(mount(), (element) => element.type === 'input').forEach((input, index) => {
      input.props.onChange({ target: { value: values[index] } })
    })
    textOf(mount())
    await find(mount(), (element) => element.props?.className?.includes?.('dshb_rates_save') === true)[0].props.onClick()
    return textOf(mount())
  }
  react.beginRender()
  let tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  const text = textOf(tree)
  assert.match(text, /cost\.rates\.miss/)
  assert.match(text, /cost\.rates\.hit/)
  assert.match(text, /cost\.rates\.output/)
  const inputs = find(tree, (element) => element.type === 'input')
  assert.deepEqual(inputs.map((input) => input.props.value), ['2', '0.1', '8'], 'the stored rates fill the fields')

  // Clearing every field means "no rate for this model", not a rate of zero.
  inputs.forEach((input) => input.props.onChange({ target: { value: '' } }))
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  textOf(tree)
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  await find(tree, (element) => element.props?.className?.includes?.('dshb_rates_save') === true)[0].props.onClick()
  assert.deepEqual(writes, [{}], 'an empty row drops the model')

  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  find(tree, (element) => element.type === 'input').forEach((input, index) => {
    input.props.onChange({ target: { value: ['1', '0.02', '4'][index] } })
  })
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  textOf(tree)
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  await find(tree, (element) => element.props?.className?.includes?.('dshb_rates_save') === true)[0].props.onClick()
  assert.deepEqual(writes.at(-1), { 'reseller-model': { cacheMiss: 1, cacheHit: 0.02, output: 4 } })

  // A negative rate is refused before anything is written.
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  find(tree, (element) => element.type === 'input')[0].props.onChange({ target: { value: '-1' } })
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  textOf(tree)
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  await find(tree, (element) => element.props?.className?.includes?.('dshb_rates_save') === true)[0].props.onClick()
  assert.equal(writes.length, 2, 'a negative rate is not written')

  // A partly filled row is refused too: the two fields left empty are not rates of
  // zero, and writing them as such would under-price the model on screen.
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  find(tree, (element) => element.type === 'input').forEach((input, index) => {
    input.props.onChange({ target: { value: index === 0 ? '2' : '' } })
  })
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  textOf(tree)
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  await find(tree, (element) => element.props?.className?.includes?.('dshb_rates_save') === true)[0].props.onClick()
  react.beginRender()
  tree = react.createElement(RateEntry, { t: (key) => key, models: ['reseller-model'], rates, onSave })
  assert.match(textOf(tree), /cost\.rates\.invalid/, 'the reader is told what is wrong with the row')
  assert.equal(writes.length, 2, 'a partly filled row is not written')

  // A rate of zero is a rate the reader typed: only an empty row removes the entry.
  assert.match(await typeAndSave(['0', '0', '0']), /cost\.rates\.saved/, 'a row of zeros is a price, not an absence')
  assert.deepEqual(writes.at(-1), { 'reseller-model': { cacheMiss: 0, cacheHit: 0, output: 0 } })

  // The gap can sit anywhere in the row, and a field holding only spaces is empty.
  assert.match(await typeAndSave(['', '2', '']), /cost\.rates\.invalid/, 'the first field empty is the same refusal')
  assert.match(await typeAndSave(['2', ' ', '']), /cost\.rates\.invalid/, 'a blank-looking field is empty, not a zero')
  assert.equal(writes.length, 3, 'neither partly filled row is written')

  assert.equal(exported.__internals.RateEntry({ t: (key) => key, models: [], rates: {}, onSave }), null, 'no model, no editor')
  react.stop()
})

test('the tooltip names the projection it prices under and marks an unpriced Step', async () => {
  const { exported } = await loadClient()
  const { tooltipLines } = exported.__internals
  const node = costNode({ retries: 2 })
  const lines = tooltipLines(node, { t: (key) => key, currency: 'CNY', total: 20, intervals: [], projection: 'offPeak' })
  assert.equal(lines.length, 6, 'four facts, the fact figure and the retry count')
  assert.match(lines[3], /¥5\.00 · cost\.tip\.share/)
  assert.match(lines[4], /cost\.proj\.fact: ¥10\.00/)
  assert.match(lines[5], /cost\.inspector\.retries/)

  const unpriced = tooltipLines(costNode({ cost: 0, unpriced: true }), { t: (key) => key, currency: 'CNY', total: 20 })
  assert.equal(unpriced.at(-1), 'cost.tip.unpriced')
  assert.equal(tooltipLines(node, { t: (key) => key, currency: 'CNY', total: 20 }).length, 5, 'the fact line only appears under a projection')
})

test('a Step that spawned subagents is marked without changing the session total', async () => {
  const { exported, react } = await loadClient()
  const child = { id: 'child-1234-abcd', mode: 'continuable', label: 'Survey the tree', createdAt: NOW, turn: 1, step: 1 }
  const nodes = [
    costNode({ turn: 1, step: 1, children: [child] }),
    costNode({ turn: 1, step: 2, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 20, byModel: { 'deepseek-flash': { buckets: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 }, cost: 20 } } }),
  ]
  const restore = stubCostFetch(costPayload(nodes))
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_spawn').length, 1, 'the spawning Step carries a chart mark')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_spawn')[0].props.title, 'cost.subagents.mark', 'and the mark names the child')
    assert.match(text, /cost\.subagents\.count/, 'the header counts the spawns')
    assert.match(text, /cost\.tab\.session/, 'the session tab is offered')
    assert.match(text, /cost\.topk\.title/, 'and the top list is what opens')
    assert.match(String(find(tree, (element) => String(element.props?.className).includes('dshb_topk'))[0].props.className), /dshb_cost_card/, 'the top list is a card like the inspector')
    assert.doesNotMatch(text, /cost\.subagents\.include/, 'the subtree is not read behind the reader’s back')

    // The mode switch: the session tab carries the session's own reading, the
    // subagents tab carries the subtree, and neither touches the header total.
    const tab = find(tree, (element) => element.props?.className === 'dshb_cost_tab' && textOf(element) === 'cost.tab.subagents')[0]
    assert.ok(tab !== undefined, 'the subagents tab is offered')
    tab.props.onClick()
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    const subtreeText = textOf(tree)
    assert.match(subtreeText, /cost\.subagents\.include/, 'the subtree is offered on its tab, not read')
    assert.doesNotMatch(subtreeText, /cost\.topk\.title/, 'and the session reading is replaced by it')
    assert.match(String(find(tree, (element) => String(element.props?.className).includes('dshb_subagents'))[0].props.className), /dshb_cost_card/, 'and so is the subtree panel')
    assert.match(subtreeText, /Survey the tree/, 'the child is named from the catalog entry')
    assert.match(subtreeText, /cost\.subagents\.notLoaded/, 'with no money until the subtree is read')
    assert.match(subtreeText, /¥30\.00/, 'the header still covers this session alone')
    assert.doesNotMatch(subtreeText, /¥40\.00/, 'and no child figure leaks into it')
    react.stop()
  } finally {
    restore()
  }
})

test('the subtree is read on demand and its money stays out of the session total', async () => {
  const { exported, react } = await loadClient()
  const nodes = [costNode({ turn: 1, step: 1, children: [{ id: 'child-1', mode: 'continuable', label: 'Survey the tree', createdAt: NOW, turn: 1, step: 1 }] })]
  const children = {
    ok: true,
    sessionId: 'session-7',
    full: false,
    currency: 'CNY',
    children: [{
      id: 'child-1', parentId: 'session-7', depth: 1, mode: 'continuable', label: 'Survey the tree', createdAt: NOW,
      steps: 4, models: ['deepseek-flash'], unpriced: false, tStart: NOW - HOUR, tEnd: NOW,
      cost: 12.5, costByBucket: { uncachedInput: 2, cacheRead: 0.5, cacheWrite: 0, output: 10 },
      offPeak: { cost: 6.25, costByBucket: {} }, peak: { cost: 12.5, costByBucket: {} }, tokens: { uncachedInput: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e6 },
    }],
    diagnostics: [{ id: 'broken-1', parentId: 'session-7', depth: 1, reason: 'corrupt' }],
    total: { cost: 12.5, steps: 4 },
    // The reading carries its own verdicts, detected over this same series with the
    // subtree cost folded in.
    findings: [finding('expensive-subtree', [0], {
      severity: 'warn',
      evidence: { metric: 'subtreeShare', value: 0.6, threshold: 0.3, subtreeCost: 12.5, sessionCost: 10, sample: 1 },
    })],
  }
  const deeper = {
    ...children,
    full: true,
    children: [
      children.children[0],
      {
        id: 'grandchild-2', parentId: 'child-1', depth: 2, mode: 'one-shot', label: 'Read one page', createdAt: null,
        steps: 2, models: ['deepseek-flash'], unpriced: false, tStart: NOW - HOUR, tEnd: NOW,
        cost: 3.25, costByBucket: { uncachedInput: 1, cacheRead: 0, cacheWrite: 0, output: 2.25 },
        offPeak: { cost: 1.625, costByBucket: {} }, peak: { cost: 3.25, costByBucket: {} }, tokens: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 1e6 },
      },
    ],
    total: { cost: 15.75, steps: 6 },
  }
  const previousFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    if (String(url).startsWith('/dsh-balance/session-cost/children')) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { ok: true, status: 200, json: async () => (String(url).includes('full=1') ? deeper : children) }
    }
    if (String(url).startsWith('/dsh-balance/session-cost')) {
      return { ok: true, status: 200, json: async () => costPayload(nodes) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    const openSubagents = () => {
      const tab = find(tree, (element) => element.props?.className === 'dshb_cost_tab' && textOf(element) === 'cost.tab.subagents')[0]
      tab.props.onClick()
      react.beginRender()
      tree = react.createElement(exported.__internals.CostView, props)
    }
    openSubagents()
    const panel = () => textOf(find(tree, (element) => String(element.props?.className).includes('dshb_subagents'))[0])
    assert.doesNotMatch(panel(), /¥0\.00/, 'an unread subtree is never priced at zero')
    assert.match(panel(), /cost\.subagents\.notLoaded/, 'it says it was not read')
    const include = find(tree, (element) => element.type === 'button' && element.props?.className === 'dshb_btn' && textOf(element) === 'cost.subagents.include')[0]
    assert.ok(include !== undefined, 'the subtree is an explicit action')
    await include.props.onClick()
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    assert.match(textOf(tree), /cost\.subagents\.loading/, 'the reader is told while foreign sessions are read')
    await new Promise((resolve) => setTimeout(resolve, 20))
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    assert.ok(seen.some((url) => url.includes('/session-cost/children?sessionId=session-7')), 'the children route is the one asked')
    assert.equal(seen.filter((url) => url.includes('full=1')).length, 0, 'and only the direct children are read first')
    assert.match(text, /¥12\.50/, 'the child line carries its own estimate')
    assert.match(text, /cost\.subagents\.total/)
    assert.match(text, /¥10\.00/, 'the session total is still its own Step')
    assert.doesNotMatch(text, /¥22\.50/, 'the child is not folded in')
    assert.match(text, /broken-1/, 'a branch that could not be read is named')
    assert.match(text, /cost\.subagents\.reason\.corrupt/, 'with the reason the Host gave')
    // The card describes the reading the tab shows: the subtree's own Finding while
    // the Subagents tab is open, the session's own — none — on the session tab.
    assert.match(text, /cost\.findings\.subtree/, 'the card says it is the subtree reading')
    assert.match(text, /cost\.finding\.kind\.expensive-subtree/, 'and lists the Finding of that reading')
    assert.doesNotMatch(text, /cost\.findings\.empty/, 'so the reading is not reported empty')

    // Select the Step itself: the attribution belongs beside the Step that caused it.
    const toTab = (label) => {
      const target = find(tree, (element) => element.props?.className === 'dshb_cost_tab' && textOf(element) === label)[0]
      target.props.onClick()
      react.beginRender()
      tree = react.createElement(exported.__internals.CostView, props)
    }
    toTab('cost.tab.session')
    assert.doesNotMatch(textOf(tree), /cost\.finding\.kind\.expensive-subtree/, 'the session reading keeps its own Findings')
    assert.match(textOf(tree), /cost\.findings\.empty/, 'and it has none of its own')
    const row = find(tree, (element) => element.props?.className === 'dshb_topk_row')[0]
    row.props.onClick()
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    toTab('cost.tab.subagents')
    assert.match(textOf(tree), /cost\.subagents\.stepTotal/, 'and the subtree is attributed to the spawning Step')

    const full = find(tree, (element) => element.type === 'button' && textOf(element) === 'cost.subagents.loadFull')[0]
    assert.ok(full !== undefined, 'the whole subtree is a second, explicit action')
    assert.equal(full.props.title, 'cost.subagents.fullHint')
    await full.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    assert.ok(seen.some((url) => url.includes('full=1')), 'Load full history walks every session below')
    const whole = textOf(tree)
    assert.match(whole, /Read one page/, 'a session below the direct children gets its own line')
    assert.match(whole, /¥3\.25/, 'with its own estimate')
    assert.match(whole, /¥15\.75/, 'and the subtree total covers every visible line')
    react.stop()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('the child lines of a Step follow the catalog order and keep unread children visible', async () => {
  const { exported } = await loadClient()
  const { subtreeOf, stepGroups } = exported.__internals
  const node = {
    turn: 2,
    step: 3,
    children: [
      { id: 'a', mode: 'continuable', label: 'First' },
      { id: 'b', mode: 'one-shot', label: '' },
    ],
  }
  const lines = [{ id: 'a', cost: 1.5, steps: 2, parentId: 'session-7' }, { id: 'c', cost: 9, steps: 1, parentId: 'session-7' }]
  const own = subtreeOf(node, lines)
  assert.deepEqual(own.lines.map((line) => [line.id, line.loaded]), [['a', true], ['b', false]], 'the catalog order survives, unread children included')
  assert.equal(own.cost, 1.5, 'only read children are summed')
  assert.equal(own.steps, 2)
  assert.equal(own.loaded, 1)
  assert.deepEqual(subtreeOf(null, lines).lines, [])
  // A session below the direct children belongs to the same group, indented: the
  // route counts it in the subtree total, so the panel has to show it.
  const nested = subtreeOf(node, [...lines, { id: 'grand', parentId: 'a', cost: 4, steps: 1 }])
  assert.deepEqual(nested.lines.map((line) => [line.id, line.depth, line.loaded]), [['a', 0, true], ['grand', 1, true], ['b', 0, false]])
  assert.equal(nested.cost, 5.5)
  assert.equal(nested.steps, 3)
  assert.deepEqual(stepGroups([costNode({ turn: 1, step: 1 }), { ...node, children: [] }], lines), [], 'a Step without children is not a group')
  const groups = stepGroups([costNode({ turn: 2, step: 3, children: node.children })], lines)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].key, '2:3')
  assert.equal(groups[0].cost, 1.5)
  // A repeated id cannot loop the walk.
  const looped = subtreeOf({ children: [{ id: 'a' }] }, [{ id: 'a', parentId: 'session-7', cost: 1, steps: 1 }, { id: 'a', parentId: 'a', cost: 1, steps: 1 }])
  assert.equal(looped.lines.length, 1)
})

test('the calibration line appears only when the samples can express it', async () => {
  const { exported, react } = await loadClient()
  const render = async (over) => {
    const restore = stubCostFetch(costPayload([costNode()], over))
    try {
      const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
      react.beginRender()
      textOf(react.createElement(exported.__internals.CostView, props))
      await new Promise((resolve) => setTimeout(resolve, 10))
      react.beginRender()
      return textOf(react.createElement(exported.__internals.CostView, props))
    } finally {
      restore()
    }
  }
  const calibrated = await render({
    calibration: { currency: 'CNY', samples: 6, from: NOW - 90 * MINUTE, to: NOW - 10 * MINUTE, delta: 2.5 },
  })
  assert.match(calibrated, /cost\.calibration/, 'the account-wide figure sits beside the estimate')
  assert.match(calibrated, /¥2\.50/)
  const bare = await render({})
  assert.doesNotMatch(bare, /cost\.calibration/, 'and it is absent when the host could not compute it')
  react.stop()
})

test('the tab is a stored view choice, and a session without subagents never opens on an empty one', async () => {
  const { exported, react } = await loadClient()
  const posts = []
  const child = { id: 'child-1', mode: 'one-shot', label: 'Read one page', createdAt: NOW, turn: 1, step: 1 }
  const restore = stubSeriesAndWrites(costPayload([costNode({ children: [child] })], {
    prefs: { costTab: 'subagents' },
  }), posts)
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    const id = find(tree, (element) => element.props?.className === 'dshb_cost_id')[0]
    assert.equal(textOf(id), 'session-7', 'the id is shown in full on a line of its own')
    assert.equal(id.props.title, 'session-7')
    assert.match(textOf(tree), /cost\.session\.copy/, 'and it can be copied in one click')
    assert.match(textOf(tree), /cost\.subagents\.include/, 'the stored tab comes back')
    assert.doesNotMatch(textOf(tree), /cost\.topk\.title/, 'and the session reading is not the one drawn')

    const session = find(tree, (element) => element.props?.className === 'dshb_cost_tab' && textOf(element) === 'cost.tab.session')[0]
    await session.props.onClick()
    assert.match(textOf(react.createElement(exported.__internals.CostView, props)), /cost\.topk\.title/, 'the session tab brings the top list back')
    const settings = posts.filter((post) => post.url === '/dsh-balance/settings')
    assert.deepEqual(settings.at(-1).body, { costTab: 'session' }, 'and the choice is written through')
    react.stop()
  } finally {
    restore()
  }

  // The same stored tab on a session that spawned nothing falls back to the session
  // reading rather than opening a tab with nothing on it.
  const plain = stubSeriesAndWrites(costPayload([costNode()], { prefs: { costTab: 'subagents' } }), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_tab').length, 0, 'no tabs without subagents')
    assert.match(textOf(tree), /cost\.topk\.title/)
    react.stop()
  } finally {
    plain()
  }
})

test('the session id can be copied in one click', async () => {
  const { exported, react } = await loadClient()
  const written = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (value) => { written.push(value) } } },
  })
  const restore = stubSeriesAndWrites(costPayload([costNode()]), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    const copy = find(tree, (element) => element.type === 'button' && textOf(element) === 'cost.session.copy')[0]
    assert.ok(copy !== undefined, 'the id line offers the copy action')
    await copy.props.onClick()
    assert.deepEqual(written, ['session-7'], 'the whole id is what reaches the clipboard')
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    assert.match(textOf(tree), /cost\.session\.copied/, 'and the reader is told it happened')
    react.stop()
  } finally {
    restore()
    if (previous === undefined) delete globalThis.navigator
    else Object.defineProperty(globalThis, 'navigator', previous)
  }
})

test('a subagent line opens that session’s own Cost view', async () => {
  const { exported, react } = await loadClient()
  const { Subagents, SubagentOpen, CostInspector, openSessionCost, preferCostView } = exported.__internals
  // The panel asks the owner to follow the child, and never invents a session id.
  const opened = []
  const groups = [{
    key: '1:1',
    turn: 1,
    step: 1,
    cost: 1,
    loaded: 1,
    lines: [
      { id: 'child-1', label: 'Survey the tree', mode: 'continuable', depth: 0, cost: 1, steps: 2, loaded: true },
      { id: '', label: '', mode: 'one-shot', depth: 1, cost: 0, steps: 0, loaded: false },
    ],
  }]
  react.beginRender()
  let tree = react.createElement(Subagents, {
    t: (key) => key,
    currency: 'CNY',
    groups,
    spawns: 2,
    state: { status: 'ok', lines: [{ id: 'child-1' }], total: { cost: 1 }, diagnostics: [], full: false },
    onLoad: async () => {},
    onOpen: (id) => opened.push(id),
  })
  const buttons = find(tree, (element) => element.type === 'button' && textOf(element) === 'cost.subagents.open')
  assert.equal(buttons.length, 1, 'only a child with a session id gets the jump')
  assert.equal(buttons[0].props.title, 'cost.subagents.openHint')
  buttons[0].props.onClick()
  assert.deepEqual(opened, ['child-1'], 'the child session id is what the jump carries')
  react.beginRender()
  tree = react.createElement(Subagents, {
    t: (key) => key,
    currency: 'CNY',
    groups,
    spawns: 2,
    state: { status: 'ok', lines: [{ id: 'child-1' }], total: { cost: 1 }, diagnostics: [], full: false },
    onLoad: async () => {},
  })
  assert.equal(find(tree, (element) => element.type === 'button' && textOf(element) === 'cost.subagents.open').length, 0, 'without an owner action there is no button')

  react.beginRender()
  assert.equal(textOf(react.createElement(SubagentOpen, { t: (key) => key, id: 'child-9' })), '', 'no owner action, no button')
  react.beginRender()
  assert.equal(textOf(react.createElement(SubagentOpen, { t: (key) => key, id: '', onOpen: () => {} })), '', 'no session id, no button')

  // The inspector carries the same jump beside the Step it belongs to.
  react.beginRender()
  const inspector = react.createElement(CostInspector, {
    t: (key) => key,
    node: costNode({ children: [{ id: 'child-1', mode: 'one-shot', label: 'Read one page' }] }),
    currency: 'CNY',
    total: 10,
    subtree: { status: 'ok', lines: [{ id: 'child-1', cost: 1, steps: 2, loaded: true }], total: { cost: 1 }, diagnostics: [], full: false },
    onOpenSubtree: (id) => opened.push(id),
  })
  const inInspector = find(inspector, (element) => element.type === 'button' && textOf(element) === 'cost.subagents.open')[0]
  assert.ok(inInspector !== undefined, 'the inspector attributes the subtree and offers the jump')
  inInspector.props.onClick()
  assert.deepEqual(opened, ['child-1', 'child-1'])
  react.stop()

  // The jump itself: open the session, then activate the Cost tab as soon as the
  // shell has bound it — and never loop forever when it never does.
  const calls = []
  const workspace = { openSession: (id) => calls.push(['open', id]) }
  let bound = 0
  const conversation = {
    binding: (id) => {
      bound += 1
      calls.push(['binding', id])
      if (bound < 3) throw new Error('inactive session')
      return { activate: (view) => calls.push(['activate', id, view]) }
    },
  }
  const queue = []
  const schedule = (fn) => { queue.push(fn) }
  assert.equal(openSessionCost({ workspace, conversation, sessionId: 'child-1', schedule }), true)
  for (let i = 0; i < 6 && queue.length > 0; i += 1) queue.shift()()
  assert.deepEqual(calls[0], ['open', 'child-1'], 'the session is opened first')
  assert.deepEqual(calls.at(-1), ['activate', 'child-1', 'dsh-balance-cost'], 'and its Cost tab is activated')

  const never = []
  assert.equal(openSessionCost({
    workspace,
    conversation: { binding: () => { throw new Error('inactive session') } },
    sessionId: 'child-2',
    attempts: 3,
    delay: 1,
    schedule: (fn) => { never.push(fn) },
  }), true)
  let guard = 0
  while (never.length > 0 && guard < 10) {
    guard += 1
    never.shift()()
  }
  assert.equal(guard, 3, 'the retry is bounded, not a loop')
  assert.equal(openSessionCost({ sessionId: 'child-3', workspace: {} }), false, 'a shell without the workspace action is a no-op')
  assert.equal(openSessionCost({ workspace, sessionId: '' }), false)

  // The stored preference is what makes a session the shell has never bound mount on
  // Cost; the rest of the record (the reader's draft) must survive the write, and a
  // session with no record at all gets every field the shell's store starts with —
  // the shell replaces its whole state with this JSON, so a partial record would
  // leave the composer with an undefined draft.
  const disk = new Map()
  disk.set('dsh.conversation.chat.child-4', JSON.stringify({ draft: 'keep me', view: 'chat', inspect: 'x' }))
  const storage = {
    getItem: (name) => (disk.has(name) ? disk.get(name) : null),
    setItem: (name, value) => disk.set(name, value),
  }
  assert.equal(preferCostView(storage, 'child-4'), true)
  assert.deepEqual(JSON.parse(disk.get('dsh.conversation.chat.child-4')), {
    selection: null, draft: 'keep me', view: 'dsh-balance-cost', inspect: 'x',
  })
  assert.equal(preferCostView(storage, 'child-5'), true, 'a session with no record gets one')
  assert.deepEqual(JSON.parse(disk.get('dsh.conversation.chat.child-5')), {
    selection: null, draft: '', view: 'dsh-balance-cost', inspect: null,
  })
  assert.equal(preferCostView(undefined, 'child-5'), false, 'no storage, no claim')
  disk.set('dsh.conversation.chat.child-6', 'not json')
  assert.equal(preferCostView(storage, 'child-6'), false, 'a record that cannot be read is left alone')
  disk.set('dsh.conversation.chat.child-7', '[]')
  assert.equal(preferCostView(storage, 'child-7'), false, 'and an array is not a store record')
})

test('a subagent group head carries an aggregate, never a copy of its only line', async () => {
  const { exported, react } = await loadClient()
  const { Subagents } = exported.__internals
  const line = (over) => ({ label: '', mode: 'one-shot', depth: 0, cost: 1, steps: 2, loaded: true, ...over })
  const groups = [
    { key: '1:1', turn: 1, step: 1, cost: 1, loaded: 1, lines: [line({ id: 'child-1' })] },
    { key: '2:2', turn: 2, step: 2, cost: 3, loaded: 2, lines: [line({ id: 'child-2', cost: 1 }), line({ id: 'child-3', cost: 2 })] },
    { key: '3:3', turn: 3, step: 3, cost: 0, loaded: 0, lines: [line({ id: 'child-4', cost: 0, loaded: false })] },
  ]
  react.beginRender()
  const tree = react.createElement(Subagents, {
    t: (key) => key,
    currency: 'CNY',
    groups,
    spawns: 4,
    state: { status: 'ok', lines: [{ id: 'child-1' }], total: { cost: 4, steps: 4 }, diagnostics: [], full: false },
    onLoad: async () => {},
  })
  const heads = find(tree, (element) => element.props?.className === 'dshb_sub_head')
  assert.equal(heads.length, 3)
  assert.equal(textOf(heads[0]).includes('¥1.00'), false, 'a group of one line does not repeat that line’s figure')
  assert.equal(textOf(heads[1]).includes('¥3.00'), true, 'a group of several lines shows their sum')
  assert.equal(textOf(heads[2]).includes('¥0.00'), false, 'an unread group shows no figure at all')
  react.stop()
})

test('the export line offers the two levels, warns on full and folds subagents in on request', async () => {
  const { exported, react } = await loadClient()
  const nodes = [{
    ...costNode(),
    reports: [{ model: 'deepseek-flash', time: NOW, buckets: { uncachedInput: 1e6, cacheRead: 0, cacheWrite: 0, output: 0 }, seq: 5, cost: 2, offPeak: { cost: 1 }, peak: { cost: 2 } }],
    children: [{ id: 'child-1', mode: 'one-shot', label: 'Read one page', createdAt: NOW, seq: 9 }],
  }]
  const asked = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const target = String(url)
    asked.push(target)
    if (target.includes('/session-cost/children')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, full: true, children: [{ id: 'child-1', depth: 1, mode: 'one-shot', label: 'Read one page', cost: 1 }], diagnostics: [], total: { cost: 1 } }) }
    }
    if (target.includes('/session-cost/text')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, records: [{ seq: 2, t: NOW - 60, turn: 1, step: 1, type: 'user_message', text: 'why' }] }) }
    }
    if (target.includes('/session-cost')) {
      return { ok: true, status: 200, json: async () => costPayload(nodes) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  const saved = []
  const previousDocument = globalThis.document
  const previousCreate = URL.createObjectURL
  const previousRevoke = URL.revokeObjectURL
  globalThis.document = { body: { appendChild: () => {} }, createElement: () => ({ click() { saved.push({ name: this.download, blob: this.href }) }, remove() {} }) }
  URL.createObjectURL = (blob) => {
    saved.push({ blob })
    return 'blob:test'
  }
  URL.revokeObjectURL = () => {}
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    let text = textOf(tree)
    assert.match(text, /cost\.export\.title/, 'the export line is on screen')
    assert.match(text, /cost\.export\.detail\.costs/)
    assert.doesNotMatch(text, /cost\.export\.warn/, 'the default level carries no text and needs no warning')
    assert.match(text, /cost\.export\.subagents/, 'and the subtree is an explicit choice')

    const full = find(tree, (element) => element.type === 'button' && textOf(element) === 'cost.export.detail.full')[0]
    full.props.onClick()
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    text = textOf(tree)
    assert.match(text, /cost\.export\.warn/, 'the full level says what it carries before the download')

    const box = find(tree, (element) => element.type === 'input' && element.props?.type === 'checkbox')[0]
    assert.ok(box !== undefined)
    box.props.onChange({ target: { checked: true } })
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    const run = find(tree, (element) => element.type === 'button' && textOf(element) === 'cost.export.download')[0]
    run.props.onClick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    assert.match(textOf(tree), /cost\.export\.done/)

    const file = saved.find((entry) => entry.blob !== undefined)
    assert.ok(file !== undefined, 'the browser is handed the file')
    assert.match(file.blob.type, /ndjson/)
    const stream = await file.blob.text()
    const records = stream.trimEnd().split('\n').map((line) => JSON.parse(line))
    assert.equal(records[0].type, 'meta')
    assert.equal(records[0].detail, 'full')
    assert.ok(records.some((record) => record.type === 'user_message'), 'the words are in')
    assert.ok(records.some((record) => record.type === 'subagent_spawn' && record.child === 'child-1'), 'the child was folded in')
    assert.ok(records.some((record) => record.session === 'child-1'), 'with its own records')
    assert.ok(asked.some((url) => url.includes('children?sessionId=session-7&full=1')), 'the whole subtree is read for the export')
    assert.ok(asked.some((url) => url.includes('/session-cost/text?sessionId=child-1')), 'and a child’s words are read from the log')
    react.stop()
  } finally {
    globalThis.fetch = previousFetch
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
    URL.createObjectURL = previousCreate
    URL.revokeObjectURL = previousRevoke
  }
})

test('a series still being read shows a spinner instead of an empty chart', async () => {
  const { exported, react } = await loadClient()
  const previousFetch = globalThis.fetch
  let release = () => {}
  const gate = new Promise((resolve) => { release = resolve })
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('/dsh-balance/session-cost')) await gate
    return { ok: true, status: 200, json: async () => costPayload([costNode()]) }
  }
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    let text = textOf(tree)
    assert.match(text, /cost\.loading/, 'the view says it is reading, not that the session is empty')
    assert.doesNotMatch(text, /cost\.empty\.steps/, 'the empty state is a lie until the answer arrives')
    assert.equal(find(tree, (element) => String(element.props?.className).includes('dshb_spinner_ring')).length, 1)
    assert.equal(find(tree, (element) => element.props?.role === 'status').length, 1, 'and it is announced as a status')

    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    text = textOf(tree)
    assert.doesNotMatch(text, /cost\.loading/, 'the spinner gives way once the series lands')
    assert.match(text, /cost\.topk\.title/)

    // A read that fails ends the same way: the spinner is for waiting, not for hiding
    // an error that has already arrived.
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) })
    // Another session means another mount, so nothing of the previous one is left.
    react.unmount()
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, { ...props, sessionId: 'session-8' }))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const failed = react.createElement(exported.__internals.CostView, { ...props, sessionId: 'session-8' })
    assert.doesNotMatch(textOf(failed), /cost\.loading/)
    assert.match(textOf(failed), /cost\.empty\.error/)
    assert.match(textOf(failed), /cost\.retry/)
    react.stop()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('the Top-K mode is a saved choice, and every row says when and in which phase', async () => {
  const { exported, react } = await loadClient()
  const posts = []
  // Two Turns, one inside the peak interval of the payload and one outside it, so the
  // grouped list has two rows and each can be asked about its phase.
  const nodes = [costNode(), costNode({ turn: 2, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 4 })]
  const restore = stubSeriesAndWrites(costPayload(nodes, { prefs: { costTopK: 'turns' } }), posts)
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    let text = textOf(tree)
    assert.match(text, /cost\.topk\.ofSteps/, 'the stored mode came back grouped by Turns')
    // The first Step starts inside the peak interval of the payload, the second outside it.
    const rows = find(tree, (element) => String(element.props?.className).includes('dshb_topk_row'))
    assert.equal(rows.length, 2)
    assert.match(textOf(rows[0]), /cost\.tip\.phase\.peak/, 'a row says which tariff phase it fell in')
    assert.match(textOf(rows[1]), /cost\.tip\.phase\.off-peak/)

    const steps = find(tree, (element) => element.type === 'button' && element.children?.join('') === 'cost.topk.steps')[0]
    await steps.props.onClick()
    const settings = posts.filter((post) => post.url === '/dsh-balance/settings')
    assert.deepEqual(settings.map((post) => post.body), [{ costTopK: 'steps' }], 'switching the mode is written through alone')
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    assert.doesNotMatch(textOf(tree), /cost\.topk\.ofSteps/, 'and the list regroups at once')
    react.stop()
  } finally {
    restore()
  }
})

test('the plugin registers with no Coding Tools service and reads nothing before the tab is chosen', async () => {
  const { exported } = await loadClient()
  const ctx = clientContext()
  // The stub offers slots, locale and no coding-tools service at all: the Cost view
  // must register anyway, and nothing may be fetched until the reader selects it.
  const previousFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    exported.apply(ctx)
    assert.equal(ctx.registered.length, 4, 'the readout, both peak surfaces and the Cost view are registered')
    assert.equal(fetches, 0, 'registering the plugin reads nothing')
    const cost = ctx.registered.find((entry) => entry.options.id === 'dsh-balance-cost')
    // The view is a component until it is mounted: mounting it is what starts the read.
    assert.equal(typeof cost.component, 'function')
    assert.equal(fetches, 0, 'and neither does holding the component')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a new projection sequence re-reads the series of an open view', async () => {
  const { exported, react } = await loadClient()
  const reads = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    reads.push(String(url))
    return { ok: true, status: 200, json: async () => costPayload([costNode()]) }
  }
  try {
    let seq = 5
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(reads.filter((url) => url.startsWith('/dsh-balance/session-cost?')).length, 1)

    // The projection sequence moves as the session runs: the open view follows it,
    // which is what makes the tab a live tail rather than a snapshot.
    seq = 6
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(reads.filter((url) => url.startsWith('/dsh-balance/session-cost?')).length, 2)
    react.stop()
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('a clipped chart offers its way back out, and taking it keeps every Step', async () => {
  const { exported, react } = await loadClient()
  // One outlier among many Steps: enough samples for the percentile to sit low.
  const nodes = [
    ...Array.from({ length: 40 }, (_, index) => costNode({
      turn: 1, step: index + 1, tStart: NOW - (40 - index) * MINUTE, tEnd: NOW - (39 - index) * MINUTE, cost: 1,
    })),
    costNode({ turn: 2, step: 1, tStart: NOW, tEnd: NOW + MINUTE, cost: 1000 }),
  ]
  const restore = stubSeriesAndWrites(costPayload(nodes), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    assert.match(textOf(tree), /cost\.clip/)
    const unclip = find(tree, (element) => element.type === 'button' && element.children?.join('') === 'cost.unclip')[0]
    assert.ok(unclip !== undefined, 'the note offers to stop clipping')

    await unclip.props.onClick()
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    assert.doesNotMatch(text, /cost\.unclip/, 'the offer goes away with the clipping')
    assert.doesNotMatch(text, /cost\.clip/, 'and so does the note that announced it')
    assert.match(text, /cost\.topk\.title/, 'the list is still there, now with every Step in it')
    const rows = find(tree, (element) => String(element.props?.className).includes('dshb_topk_row'))
    assert.equal(rows.length, 10, 'the outlier no longer hides the rest')
    assert.match(textOf(rows[0]), /¥1000/, 'and the biggest Step leads the list')
    react.stop()
  } finally {
    restore()
  }
})

test('the view renders a payload produced by the host, not only a hand-written one', async () => {
  const { exported, react } = await loadClient()
  // The host half builds its series with its own fold and pricing; the browser half
  // has to read exactly those field names and units. This is the one test that
  // crosses the boundary: nothing here is hand-written except the session events.
  const { makeSessionCostProjection, makeFallbackResolver, seriesPayload } = await import('../src/session-cost.js')
  const unit = makeSessionCostProjection(() => ({ currency: 'CNY' }))
  const time = Date.parse('2026-09-24T02:00:00Z') // 10:00 Beijing, inside a peak window
  const events = [
    { type: 'step/start', seq: 1, time, data: { turn: 1, step: 1 } },
    { type: 'request/header', seq: 2, time, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'assistant/message', seq: 3, time, data: { turn: 1, step: 1, usage: { inputTokens: 1e6, outputTokens: 1e6 } } },
    { type: 'step/end', seq: 4, time: time + 1000, data: { turn: 1, step: 1 } },
  ]
  const state = events.reduce((folded, event) => unit.apply(folded, event), unit.init())
  const nodes = seriesPayload(state, { currency: 'CNY', holidays: [], fallback: makeFallbackResolver({}) })
  const series = {
    ok: true,
    sessionId: 'session-7',
    seq: state.seq,
    currency: 'CNY',
    nodes,
    rule: { sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing', verifiedOn: '2026-09-27', holidays: [], rates: [] },
    peakIntervals: [],
    calibration: null,
    prefs: {},
  }
  const restore = stubSeriesAndWrites(series, [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: state.seq, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    // 1M uncached input at 2 CNY plus 1M output at 8 CNY, as the host priced it.
    assert.match(text, /¥10\.00/, 'the headline is the host’s figure')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_mark').length, 0)
    assert.match(text, /cost\.inspector\.empty/, 'and the inspector waits for a selection')
    const row = find(tree, (element) => String(element.props?.className).includes('dshb_topk_row'))[0]
    assert.match(textOf(row), /¥10\.00/, 'the list reads the same node')
    react.stop()
  } finally {
    restore()
  }
})

test('zooming recomputes the list and the headline for the visible range', async () => {
  const { exported, react } = await loadClient()
  const nodes = [
    costNode({ turn: 1, step: 1, tStart: NOW - 3 * HOUR, tEnd: NOW - 3 * HOUR + MINUTE, cost: 10 }),
    costNode({ turn: 2, step: 1, tStart: NOW - 2 * HOUR, tEnd: NOW - 2 * HOUR + MINUTE, cost: 5 }),
    costNode({ turn: 3, step: 1, tStart: NOW - MINUTE, tEnd: NOW, cost: 40 }),
  ]
  const restore = stubSeriesAndWrites(costPayload(nodes), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    let text = textOf(tree)
    assert.match(text, /¥55\.00/, 'the whole session first')
    const rowTexts = () => find(tree, (element) => String(element.props?.className).includes('dshb_topk_row')).map(textOf)
    assert.equal(rowTexts().length, 3)
    assert.match(rowTexts()[0], /¥40\.00/, 'the biggest Step leads')

    // Zoom hard onto the left edge: only the earliest Steps are then on screen.
    const plot = find(tree, (element) => element.props?.className === 'dshb_cost_plot')[0]
    for (let index = 0; index < 6; index += 1) {
      plot.props.onWheel({ deltaY: -1, clientX: 2, preventDefault: () => {} })
      react.beginRender()
      tree = react.createElement(exported.__internals.CostView, props)
      textOf(tree)
    }
    const zoomedPlot = find(tree, (element) => element.props?.className === 'dshb_cost_plot')[0]
    zoomedPlot.props.onWheel({ deltaY: -1, clientX: 2, preventDefault: () => {} })
    react.beginRender()
    tree = react.createElement(exported.__internals.CostView, props)
    text = textOf(tree)
    assert.match(text, /cost\.zoom\.reset/, 'a window is in force')
    const zoomedRows = find(tree, (element) => String(element.props?.className).includes('dshb_topk_row')).map(textOf)
    assert.equal(zoomedRows.some((row) => /¥40\.00/.test(row)), false, 'the Step outside the window left the list')
    assert.equal(zoomedRows.length, 1, 'only the Step the window covers is left to rank')
    assert.match(zoomedRows[0], /¥5\.00/)
    assert.match(zoomedRows[0], /9\.1%/, 'while the share still speaks for the whole session, as the spec says')
    assert.match(text, /¥5\.00/, 'and the headline speaks for the visible range')
    react.stop()
  } finally {
    restore()
  }
})

test('the inspector prompt is the newest user message at or before the Step', async () => {
  const { exported } = await loadClient()
  const { promptForNode } = exported.__internals
  const previous = globalThis.fetch
  const urls = []
  globalThis.fetch = async (url) => {
    urls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        records: [
          { seq: 1, t: 100, turn: null, step: null, type: 'user_message', text: 'first question' },
          { seq: 2, t: 200, turn: 1, step: 1, type: 'assistant_message', text: 'an answer' },
          { seq: 3, t: 300, turn: null, step: null, type: 'user_message', text: 'second question' },
          { seq: 4, t: 400, turn: null, step: null, type: 'user_message', text: '   ' },
        ],
      }),
    }
  }
  try {
    assert.equal(await promptForNode('session-prompt', { turn: 1, step: 1, tStart: 250 }), 'first question')
    assert.equal(await promptForNode('session-prompt', { turn: 2, step: 1, tStart: 350 }), 'second question', 'the newest one wins')
    assert.equal(await promptForNode('session-prompt', { turn: 1, step: 1, tStart: 50 }), null, 'a Step before the first message has no prompt')
    assert.equal(urls.length, 1, 'the words of a session are read once, however many Steps ask')
    assert.match(urls[0], /sessionId=session-prompt/)
  } finally {
    globalThis.fetch = previous
  }
})

test('the prompt cache holds the last few sessions and reads an evicted one again', async () => {
  const { exported } = await loadClient()
  const { promptForNode, sessionPrompts, MAX_PROMPT_SESSIONS } = exported.__internals
  const previous = globalThis.fetch
  const reads = []
  globalThis.fetch = async (url) => {
    const url2 = String(url)
    reads.push(url2)
    // Each session's words are its own, so a refetched session must answer the same
    // and a different one must not be able to answer for it.
    const sessionId = new URL(url2, 'http://local').searchParams.get('sessionId')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        records: [{ seq: 1, t: 100, turn: null, step: null, type: 'user_message', text: `question of ${sessionId}` }],
      }),
    }
  }
  /** How many times the words of a session were read. */
  const timesRead = (sessionId) => reads.filter((url) => url.includes(`sessionId=${sessionId}`)).length
  try {
    assert.equal(MAX_PROMPT_SESSIONS, 4, 'the bound is four sessions of words')
    const sessions = Array.from({ length: MAX_PROMPT_SESSIONS }, (_, index) => `session-old-${index}`)
    for (const sessionId of sessions) {
      assert.equal(await promptForNode(sessionId, { turn: 1, step: 1, tStart: 250 }), `question of ${sessionId}`)
    }
    assert.equal(sessionPrompts.size, MAX_PROMPT_SESSIONS, 'every session read is held')
    assert.equal(timesRead(sessions[0]), 1)

    // One session past the bound: the oldest is dropped, and the ones that are still
    // held are not read a second time.
    const newest = 'session-newest'
    assert.equal(await promptForNode(newest, { turn: 1, step: 1, tStart: 250 }), `question of ${newest}`)
    assert.equal(sessionPrompts.size, MAX_PROMPT_SESSIONS, 'the cache never grows past its bound')
    assert.equal(sessionPrompts.has(sessions[0]), false, 'the oldest session is the one that went')
    assert.equal(sessionPrompts.has(sessions[1]), true, 'and only the oldest')
    assert.equal(sessionPrompts.has(newest), true, 'the session just read is in it')
    assert.equal(timesRead(sessions[1]), 1, 'a session still held is not read again')

    // The reader-visible path after an eviction: the prompt is refetched, and it is
    // the words of that session, not of whichever session was read last.
    assert.equal(await promptForNode(sessions[0], { turn: 1, step: 1, tStart: 250 }), `question of ${sessions[0]}`)
    assert.equal(timesRead(sessions[0]), 2, 'an evicted session is read again, once')
    assert.equal(sessionPrompts.has(sessions[1]), false, 'and that read is what pushed the previous oldest out')
    assert.equal(sessionPrompts.size, MAX_PROMPT_SESSIONS, 'still at the bound')
    assert.equal(sessionPrompts.has(newest), true, 'the sessions read after the oldest are untouched')
    // A session the reader keeps coming back to stays held, however many others pass.
    for (const sessionId of sessions.slice(2).concat(newest)) {
      assert.equal(await promptForNode(sessionId, { turn: 1, step: 1, tStart: 250 }), `question of ${sessionId}`)
      assert.equal(timesRead(sessionId), 1, 'a held session is not read again by asking twice')
    }
    assert.equal(sessionPrompts.has(sessions[0]), true, 'and re-reading the recovered one is what kept it')
  } finally {
    globalThis.fetch = previous
  }
})

test('the marked Step survives a round trip for a recent session and is dropped for an old one', async () => {
  const { exported, react } = await loadClient()
  const { lastStep, MAX_STEP_SESSIONS } = exported.__internals
  const nodes = [
    costNode({ turn: 1, step: 1, cost: 10, calls: [{ name: 'bash', callId: 'call-1', preview: 'ls' }] }),
    costNode({ turn: 2, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE, cost: 4 }),
  ]
  const restore = stubSeriesAndWrites(costPayload(nodes), [])
  try {
    assert.equal(MAX_STEP_SESSIONS, 16, 'the bound is sixteen marked sessions')
    /** Mount the Cost view, open the first Step, and unmount it the way Trajectory does. */
    const markFirstStepOf = async (sessionId) => {
      react.beginRender()
      textOf(react.createElement(exported.__internals.CostView, { t: (key) => key, sessionId, useProjection: () => undefined, inspectCall: () => {} }))
      await new Promise((resolve) => setTimeout(resolve, 10))
      react.beginRender()
      const tree = react.createElement(exported.__internals.CostView, { t: (key) => key, sessionId, useProjection: () => undefined, inspectCall: () => {} })
      textOf(tree)
      const row = find(tree, (element) => element.props?.className?.includes?.('dshb_topk_row') === true)[0]
      row.props.onClick()
      react.unmount()
    }
    /** Mount again and say whether the Step the reader marked is still the marked one. */
    const stillMarked = async (sessionId) => {
      react.beginRender()
      textOf(react.createElement(exported.__internals.CostView, { t: (key) => key, sessionId, useProjection: () => undefined, inspectCall: () => {} }))
      await new Promise((resolve) => setTimeout(resolve, 10))
      react.beginRender()
      const tree = react.createElement(exported.__internals.CostView, { t: (key) => key, sessionId, useProjection: () => undefined, inspectCall: () => {} })
      textOf(tree)
      const marked = find(tree, (element) => element.props?.className?.includes?.('dshb_topk_row_on') === true)
      react.unmount()
      return marked.length === 1
    }

    const held = Array.from({ length: MAX_STEP_SESSIONS }, (_, index) => `session-marked-${index}`)
    for (const sessionId of held) await markFirstStepOf(sessionId)
    assert.equal(lastStep.size, MAX_STEP_SESSIONS, 'the marked sessions are held')
    assert.deepEqual(lastStep.get(held[0]), { turn: 1, step: 1 })
    assert.equal(await stillMarked(held[0]), true, 'a session still held comes back with its Step marked')

    // One session past the bound: the oldest mark is gone, the recent ones are not.
    await markFirstStepOf('session-marked-newest')
    assert.equal(lastStep.size, MAX_STEP_SESSIONS, 'the map never grows past its bound')
    assert.equal(lastStep.has(held[0]), false, 'the oldest marked session is the one that went')
    assert.equal(lastStep.has(held[1]), true, 'and only the oldest')
    assert.equal(await stillMarked('session-marked-newest'), true, 'the session just marked still comes back marked')
    // What the eviction costs is exactly this: the session comes back as a session the
    // reader never marked in, with every Step still on screen and no error.
    assert.equal(await stillMarked(held[0]), false, 'an evicted session comes back unmarked, which is a state the view already has')
  } finally {
    react.stop()
    restore()
  }
})

test('an overlapping subtree read still resolves to the newest answer, and its counter is released', async () => {
  const { exported, react } = await loadClient()
  const { subtreeReads } = exported.__internals
  const answer = (label) => ({
    ok: true,
    sessionId: 'session-7',
    full: label === 'everything below',
    currency: 'CNY',
    children: [{
      id: 'child-1', parentId: 'session-7', depth: 1, mode: 'continuable', label, createdAt: NOW, turn: 1, step: 1,
      steps: 4, models: ['deepseek-flash'], unpriced: false, tStart: NOW - HOUR, tEnd: NOW,
      cost: 12.5, costByBucket: { uncachedInput: 2, cacheHit: 0, cacheWrite: 0, output: 10 },
      offPeak: { cost: 6.25, costByBucket: {} }, peak: { cost: 12.5, costByBucket: {} }, tokens: { uncachedInput: 1e6, cacheHit: 1e6, cacheWrite: 1e6, output: 1e6 },
    }],
    diagnostics: [],
    total: { cost: 12.5, steps: 4 },
  })
  const previousFetch = globalThis.fetch
  let asked = 0
  globalThis.fetch = async (url) => {
    // The first read of the two is the slow one and answers with what the reader has
    // moved on from, the second is fast and answers with the newest reading — so a
    // counter released too early would land the stale answer on top of the fresh one.
    if (String(url).startsWith('/dsh-balance/session-cost/children')) {
      const stale = asked++ === 0
      await new Promise((resolve) => setTimeout(resolve, stale ? 40 : 1))
      return { ok: true, status: 200, json: async () => answer(stale ? 'the direct children' : 'everything below') }
    }
    if (String(url).startsWith('/dsh-balance/session-cost')) {
      return { ok: true, status: 200, json: async () => costPayload([costNode({ turn: 1, step: 1, children: [{ id: 'child-1', mode: 'continuable', label: 'Survey the tree', createdAt: NOW, turn: 1, step: 1 }] })]) }
    }
    return { ok: true, status: 200, json: async () => payload }
  }
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    // Two reads in flight at once, the slow one started first: the reader asked twice
    // before the first answer came back. The panel replaces its button with "reading"
    // only on the next render, so both clicks leave from the same tree.
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    const tab = find(tree, (element) => element.props?.className === 'dshb_cost_tab' && textOf(element) === 'cost.tab.subagents')[0]
    tab.props.onClick()
    react.beginRender()
    const open = react.createElement(exported.__internals.CostView, props)
    const include = find(open, (element) => element.type === 'button' && textOf(element) === 'cost.subagents.include')[0]
    assert.ok(include !== undefined, 'the subtree is an explicit action')
    include.props.onClick()
    include.props.onClick()
    assert.equal(subtreeReads.size, 1, 'both reads belong to the one session being read')
    await new Promise((resolve) => setTimeout(resolve, 80))
    react.beginRender()
    const settled = react.createElement(exported.__internals.CostView, props)
    const text = textOf(settled)
    assert.match(text, /everything below/, 'the newer read is the answer on screen')
    assert.doesNotMatch(text, /the direct children/, 'and the slower older one did not land on top of it')
    // The counter only ever ordered the reads that were in flight; an idle session
    // holds nothing, which is what keeps this map from growing with the page.
    assert.equal(subtreeReads.size, 0, 'the counter is released once its read has landed')
    assert.equal(subtreeReads.has('session-7'), false)

    // A later read of the same session still works after the release: the counter is
    // taken again from where the map no longer holds it, so nothing needs it to have
    // survived. A remount gives an idle panel, the button with it, and a read of the
    // series of its own to wait for.
    react.unmount()
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const later = react.createElement(exported.__internals.CostView, props)
    const laterTab = find(later, (element) => element.props?.className === 'dshb_cost_tab' && textOf(element) === 'cost.tab.subagents')[0]
    assert.ok(laterTab !== undefined, 'the Cost view is back with its tabs')
    laterTab.props.onClick()
    react.beginRender()
    const again = react.createElement(exported.__internals.CostView, props)
    const readAgain = find(again, (element) => element.type === 'button' && textOf(element) === 'cost.subagents.include')[0]
    assert.ok(readAgain !== undefined, 'the read is offered again')
    readAgain.props.onClick()
    assert.equal(subtreeReads.size, 1, 'a read in flight holds its counter again')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(subtreeReads.size, 0, 'and releases it when it lands')
    react.stop()
  } finally {
    globalThis.fetch = previousFetch
  }
})

/** One Finding as the Host serves it, with only what a test cares about spelled out. */
const finding = (kind, refs, over = {}) => ({
  kind,
  refs: { from: refs[0], to: refs[1] ?? refs[0], turnFrom: 2, stepFrom: 3, turnTo: 2, stepTo: 3 },
  severity: 'warn',
  confidence: 60,
  evidence: { metric: 'cost', value: 12, threshold: 5, median: 2, mad: 0.1, share: 0.3, z: 9 },
  ...over,
})

/** The payload of a series with Findings, in the shape the route serves. */
const findingsPayload = (nodes, findings, over = {}) => costPayload(nodes, {
  findings,
  anomalies: { preset: 'balanced', thresholds: { spike: { madMultiple: 6, floor: 0.25 } } },
  ...over,
})

test('the badge of a Step names its worst Finding and counts the rest', async () => {
  const { exported } = await loadClient()
  const { overlayOf, findingRank, MAX_BADGES } = exported.__internals
  const nodes = Array.from({ length: 6 }, (_, index) => costNode({
    turn: 1, step: index + 1, tStart: NOW - 2 * HOUR + index * MINUTE, tEnd: NOW - 2 * HOUR + index * MINUTE + 1000,
  }))
  const findings = [
    finding('spike', [0], { severity: 'alert', confidence: 80 }),
    finding('retry-storm', [0], { severity: 'warn', confidence: 40 }),
    finding('verbose-output', [1], { severity: 'info', confidence: 90 }),
    finding('context-growth', [3, 5], { severity: 'warn', confidence: 60 }),
  ]
  const full = overlayOf(nodes, nodes, findings)
  assert.deepEqual(full.rows.map((row) => row.kind), ['spike', 'retry-storm', 'verbose-output', 'context-growth'], 'payload order is kept')
  assert.equal(full.rows.every((row) => row.partial === false), true, 'nothing reaches beyond the whole series')
  const badge = full.marks.find((mark) => mark.index === 0)
  assert.equal(badge.kind, 'spike', 'the most severe Finding on the Step names the badge')
  assert.equal(badge.severity, 'alert')
  assert.equal(badge.count, 2, 'and the count holds every Finding on it')
  assert.equal(full.marks.some((mark) => mark.index === 1), false, 'an info-only Step draws no badge at all')
  assert.deepEqual(full.marks.filter((mark) => mark.index === 3).map((mark) => mark.count), [1], 'a run leaves a badge on each Step it blames')

  const many = Array.from({ length: 60 }, (_, index) => finding('spike', [index % 40], { confidence: index, severity: index % 3 === 0 ? 'alert' : 'warn' }))
  const wide = nodes.concat(Array.from({ length: 34 }, (_, index) => costNode({ turn: 1, step: 10 + index })))
  const crowded = overlayOf(wide, wide, many)
  assert.equal(crowded.marks.length, MAX_BADGES, 'a crowded chart draws only the best badges')
  for (let index = 1; index < crowded.marks.length; index += 1) {
    assert.ok(findingRank(crowded.marks[index - 1]) >= findingRank(crowded.marks[index]), 'ordered by severity × confidence')
  }
})

test('a Finding that reaches beyond the visible range is listed and marked', async () => {
  const { exported } = await loadClient()
  const { overlayOf } = exported.__internals
  const nodes = Array.from({ length: 5 }, (_, index) => costNode({ turn: 1, step: index + 1 }))
  const findings = [finding('context-growth', [0, 3]), finding('spike', [0])]
  const part = overlayOf(nodes, nodes.slice(0, 2), findings)
  assert.deepEqual(part.rows.map((row) => row.kind), ['context-growth', 'spike'])
  assert.equal(part.rows[0].partial, true, 'the run continues past the window')
  assert.equal(part.rows[0].at, 0, 'and it still selects the Step it starts at')
  assert.equal(part.rows[1].partial, false)
  assert.deepEqual(part.marks.map((mark) => mark.index), [0, 1], 'a badge is drawn only on the visible Steps it blames')
  const beyond = overlayOf(nodes, [nodes[4]], findings)
  assert.deepEqual(beyond.rows, [], 'a Finding whose Steps are all outside the window is not listed')
})

test('the visible-range filter is memoised on the window and stays inside its budget', async () => {
  const { exported } = await loadClient()
  const { overlayOf, overlayMemo } = exported.__internals
  const nodes = Array.from({ length: 8 }, (_, index) => costNode({ turn: 1, step: index + 1 }))
  const findings = [finding('spike', [0])]
  let computed = 0
  const compute = () => {
    computed += 1
    return overlayOf(nodes, nodes, findings)
  }
  const first = overlayMemo('session-7:5:balanced:time:0:1:1:8', compute)
  assert.equal(computed, 1)
  assert.equal(overlayMemo('session-7:5:balanced:time:0:1:1:8', () => { throw new Error('recomputed') }), first)
  assert.equal(computed, 1, 'the same window is never filtered twice')
  const moved = overlayMemo('session-7:5:balanced:time:0.2:1:1:8', compute)
  assert.equal(computed, 2, 'a new window is a new filter')
  assert.notEqual(moved, first)

  const wide = Array.from({ length: 10_000 }, (_, index) => costNode({ turn: 1, step: index + 1 }))
  const lots = Array.from({ length: 200 }, (_, index) => finding('spike', [index * 4, index * 4 + 3]))
  const started = process.hrtime.bigint()
  const overlay = overlayOf(wide, wide, lots)
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(overlay.rows.length, 200)
  // The design budget is 4 ms for the client filter; the assertion carries CI headroom.
  assert.ok(elapsed < 50, `filtering 10⁴ Steps took ${elapsed.toFixed(1)} ms, over the budget`)
})

test('the findings card lists its rows, marks a partial one and says when nothing fired', async () => {
  const { exported, react } = await loadClient()
  const Findings = exported.__internals.Findings
  const rows = [{ ...finding('spike', [0]), at: 2, partial: true }]
  const picked = []
  const said = (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)
  const tree = react.createElement(Findings, {
    t: said,
    rows,
    anomalies: { preset: 'strict' },
    currency: 'CNY',
    steps: 40,
    onSelect: (at) => picked.push(at),
  })
  const text = textOf(tree)
  assert.match(text, /cost\.finding\.kind\.spike/)
  assert.match(text, /cost\.finding\.at\.step/)
  assert.match(text, /cost\.findings\.confidence/)
  assert.match(text, /cost\.findings\.partial/)
  const row = find(tree, (element) => (element.props?.className ?? '').split(' ').includes('dshb_finding'))[0]
  assert.match(row.props.title, /cost\.finding\.detect\.spike/, 'the explanation is one hover away')
  assert.match(row.props.title, /cost\.finding\.ranking/)
  // The explanation names the numbers that cleared the gate, not just the kind: the
  // value and its multiple, the session median, the MAD z and the share of the session.
  for (const named of ['12', '2', '9', 'cost\.finding\.spike\.text']) {
    assert.match(row.props.title, new RegExp(named), `the explanation names ${named}`)
  }
  assert.match(text, /12/, 'and so does the row itself')
  assert.match(text, /cost\.finding\.spike\.text/, 'the sentence is the row body')
  const sentence = find(tree, (element) => (element.props?.className ?? '').split(' ').includes('dshb_finding_text'))[0]
  const body = textOf(sentence)
  for (const number of ['12', '2', '5', '9', '30%']) {
    assert.match(body, new RegExp(number), `the rendered sentence carries ${number}`)
  }
  assert.match(row.props.title, /cost\.finding\.preset/)
  assert.match(text, /¥12\.00/, 'and the row names the numbers, not only the kind')
  row.props.onClick()
  assert.deepEqual(picked, [2], 'a row selects the Step the Finding starts at')

  const empty = textOf(react.createElement(Findings, {
    t: (key) => key, rows: [], anomalies: null, currency: 'CNY', steps: 5, onSelect: () => {},
  }))
  assert.match(empty, /cost\.findings\.empty/)
  assert.match(empty, /cost\.findings\.norm/, 'a session below the floor says its norm is not established')
  const quiet = textOf(react.createElement(Findings, {
    t: (key) => key, rows: [], anomalies: null, currency: 'CNY', steps: 40, onSelect: () => {},
  }))
  assert.doesNotMatch(quiet, /cost\.findings\.norm/)
})

test('the chart draws one badge per Step and a Compaction mark of its own', async () => {
  const { exported, react } = await loadClient()
  const { CostChart, overlayOf } = exported.__internals
  const nodes = [
    // The Step that carries the badge also spawned a subagent and reported no price: a
    // badge must not hide either mark (I19).
    costNode({
      turn: 1,
      step: 1,
      tStart: NOW - HOUR,
      tEnd: NOW - HOUR + MINUTE,
      children: [{ id: 'child-1', mode: 'continuable', label: 'Survey the tree', createdAt: NOW - HOUR, turn: 1, step: 1 }],
    }),
    costNode({ turn: 1, step: 2, tStart: NOW - 30 * MINUTE, tEnd: NOW, unpriced: true }),
  ]
  const overlay = overlayOf(nodes, nodes, [
    finding('spike', [0], { severity: 'alert', confidence: 80 }),
    finding('retry-storm', [0], { severity: 'warn', confidence: 10 }),
    finding('verbose-output', [1], { severity: 'info', confidence: 90 }),
  ])
  const compactionNode = costNode({
    kind: 'compaction',
    turn: null,
    step: null,
    tStart: NOW - 45 * MINUTE,
    tEnd: NOW - 45 * MINUTE + 1000,
    compaction: { id: 'cmp-1', model: 'deepseek-flash', shadowedTokenCount: 5e5 },
  })
  const picked = []
  const tree = react.createElement(CostChart, {
    t: (key) => key,
    nodes,
    payload: findingsPayload(nodes, []),
    clip: true,
    axis: 'time',
    metric: 'cost',
    projection: 'fact',
    currency: 'CNY',
    total: 20,
    range: null,
    topk: 'steps',
    onWindow: () => {},
    selected: -1,
    onSelect: (index) => picked.push(index),
    overlay,
    anomalies: { preset: 'balanced' },
    compactions: [compactionNode],
  })
  textOf(tree)
  const badges = find(tree, (element) => (element.props?.className ?? '').split(' ').includes('dshb_cost_badge'))
  assert.equal(badges.length, 1, 'an info Finding draws none, and the two on the first Step draw one')
  assert.match(badges[0].props.title, /cost\.finding\.detect\.spike/)
  assert.match(textOf(badges[0]), /2/, 'the badge counts the others')
  badges[0].props.onClick({ stopPropagation: () => {} })
  assert.deepEqual(picked, [0], 'activating a badge selects that Step')
  const marks = find(tree, (element) => element.props?.className === 'dshb_cost_compaction')
  assert.equal(marks.length, 1, 'a Compaction step gets a mark of its own')
  assert.equal(marks[0].props.style.left, '180px', 'at its own instant, a quarter into the window')
  assert.match(marks[0].props.title, /cost\.compaction\.mark/)
  // The badge sits beside the marks the chart already draws, not on top of them.
  const spawn = find(tree, (element) => element.props?.className === 'dshb_cost_spawn')
  assert.equal(spawn.length, 1, 'the Step that spawned a subagent keeps its spawn mark')
  assert.equal(spawn[0].props.style.left, badges[0].props.style.left, 'on the same Step as the badge')
  // The canvas keeps drawing the point marks — the unpriced and clipped Steps among
  // them; what a badge must not do is replace the DOM marks that share its Step.
  assert.equal(
    find(tree, (element) => element.props?.className === 'dshb_cost_mark').length, 0,
    'nothing is selected, so the selection marker is absent',
  )
})

/** Walk an element tree without executing components, so a component's own props are reachable. */
const elementOf = (node, predicate) => {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = elementOf(child, predicate)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  return elementOf(node.children, predicate)
}

test('a Compaction step counts in the session total without joining the Step line', async () => {
  const { exported, react } = await loadClient()
  const step = costNode({ turn: 1, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE })
  const compactionNode = costNode({
    kind: 'compaction',
    turn: null,
    step: null,
    tStart: NOW - 30 * MINUTE,
    tEnd: NOW - 30 * MINUTE + 1000,
    cost: 4,
    costByBucket: { uncachedInput: 4, cacheRead: 0, cacheWrite: 0, output: 0 },
    offPeak: { cost: 2, costByBucket: { uncachedInput: 2, cacheRead: 0, cacheWrite: 0, output: 0 } },
    compaction: { id: 'cmp-1', model: 'deepseek-flash', shadowedTokenCount: 5e5 },
  })
  const restore = stubSeriesAndWrites(findingsPayload([step, compactionNode], [finding('spike', [0])]), [])
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    assert.match(text, /¥14\.00/, 'the session estimate counts the compaction')
    react.beginRender()
    const chart = elementOf(exported.__internals.CostView(props), (element) => element.type === exported.__internals.CostChart)
    assert.deepEqual(chart.props.nodes.map((node) => node.kind ?? 'step'), ['step'], 'the cost line holds Steps only')
    assert.equal(chart.props.compactions.length, 1, 'the compaction travels beside the line')
    assert.match(text, /cost\.compaction\.row/, 'the top list ranks it as a compaction')
    const row = find(tree, (element) => (element.props?.className ?? '').includes('dshb_topk_row_off'))
    assert.equal(row.length, 1, 'its row is marked as not-a-Step')
    assert.equal(row[0].props.role, undefined, 'and it offers no focus target')
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_finding_detail').length, 0, 'the compaction opens no inspector of its own')
  } finally {
    react.stop()
    restore()
  }
})

test('brushing, zooming and panning never re-read the series', async () => {
  const { exported, react } = await loadClient()
  const nodes = [
    costNode({ turn: 1, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE }),
    costNode({ turn: 1, step: 2, tStart: NOW - 30 * MINUTE, tEnd: NOW - 30 * MINUTE + MINUTE }),
    costNode({ turn: 1, step: 3, tStart: NOW - 10 * MINUTE, tEnd: NOW }),
  ]
  const calls = []
  const restore = stubCostFetch(findingsPayload(nodes, [finding('context-growth', [0, 2])]), { calls })
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    textOf(tree)
    const read = calls.length
    assert.ok(read >= 1, 'the view reads the series once')
    assert.match(textOf(tree), /cost\.finding\.kind\.context-growth/)

    // A wheel zoom, a right-drag pan and a left-drag brush all end in one call to the
    // window setter (D34); what the chart does with the pointer is covered above, and
    // what matters here is that moving the window never re-reads the series.
    const chartOf = () => {
      react.beginRender()
      return elementOf(exported.__internals.CostView(props), (element) => element.type === exported.__internals.CostChart)
    }
    const setWindow = chartOf().props.onWindow
    const settled = calls.length
    for (const next of [{ from: 0.2, to: 0.8 }, { from: 0.3, to: 0.7 }, { from: 0.45, to: 1 }]) {
      setWindow(next)
    }
    assert.equal(calls.length, settled, 'a wheel zoom, a pan and a brush perform no read of their own')
    // The stub re-runs effects on every traversal instead of tracking mount and update, so
    // the next render reads once — the point is that only a render does.
    tree = react.createElement(exported.__internals.CostView, props)
    textOf(tree)
    assert.equal(calls.length, settled + 1, 'only the render that follows reads the series, and only once')
    assert.match(textOf(tree), /cost\.finding\.kind\.context-growth/, 'the Finding is filtered, not forgotten')
    assert.match(textOf(tree), /cost\.findings\.partial/, 'and a window that covers part of its range says so')
    const range = find(tree, (element) => element.props?.className === 'dshb_cost_panes')
    assert.equal(range.length, 1, 'and the view still renders its three cards')
  } finally {
    react.stop()
    restore()
  }
})

test('both locales carry every Indicator sentence the view can ask for', async () => {
  const { exported } = await loadClient()
  const ctx = clientContext()
  exported.apply(ctx)
  const copy = ctx.dictionary()
  assert.ok(copy !== null, 'the dictionaries are registered under the plugin namespace')
  assert.deepEqual(
    Object.keys(copy.ru).sort(),
    Object.keys(copy.en).sort(),
    'a reader gets the same keys in either language',
  )
  for (const [locale, table] of Object.entries(copy)) {
    for (const [key, value] of Object.entries(table)) {
      assert.equal(typeof value, 'string', `${locale}.${key} is a string`)
    }
  }
  // The list is read from the catalogue, not written out here: a hard-coded one drifts the
  // moment an Indicator is added or dropped, and the view would fall back to a placeholder.
  const kinds = CATALOGUE.map((entry) => entry.id)
  const metrics = { spike: 'spike.text', 'verbose-output': 'verbose.text', 'context-growth': 'growth.text',
    'retry-storm': 'retry.step', 'cache-miss': 'cache.text',
    'tool-output-inflation': 'tool.text', 'post-compaction-spike': 'compaction.text',
    'expensive-subtree': 'subtree.text', 'tariff-attributable': 'tariff.text', 'pricing-gap': 'gap.text' }
  for (const locale of ['en', 'ru']) {
    for (const kind of kinds) {
      assert.ok(copy[locale][`cost.finding.kind.${kind}`], `${locale} names ${kind}`)
      assert.ok(copy[locale][`cost.finding.detect.${kind}`], `${locale} explains ${kind}`)
      assert.ok(copy[locale][`cost.finding.${metrics[kind]}`], `${locale} spells out the numbers of ${kind}`)
      assert.ok(exported.__internals.FINDING_GLYPH[kind], `${locale} has a glyph for ${kind}`)
    }
    for (const key of ['cost.findings.title', 'cost.findings.empty', 'cost.findings.norm', 'cost.findings.partial',
      'cost.findings.legend', 'cost.findings.confidence', 'cost.finding.ranking', 'cost.finding.preset',
      'cost.compaction.mark', 'cost.compaction.row', 'cost.compaction.body']) {
      assert.ok(copy[locale][key], `${locale} has ${key}`)
      assert.notEqual(copy[locale][key].trim(), '', `${locale}.${key} is not empty`)
    }
  }
  // Every catalogue id has a sentence and a glyph of its own: neither map may silently drop
  // one, and neither may keep a dead entry for an Indicator that no longer exists.
  assert.deepEqual(Object.keys(metrics).sort(), [...kinds].sort(), 'the sentence map is the catalogue')
  assert.deepEqual(Object.keys(exported.__internals.FINDING_GLYPH).sort(), [...kinds].sort(), 'so is the glyph map')
})

test('the projection and the metric never move the Findings, only the money they are drawn over', async () => {
  const { exported, react } = await loadClient()
  const nodes = [costNode(), costNode({ turn: 1, step: 2, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE })]
  const findings = [finding('spike', [0], { severity: 'alert', confidence: 71 })]
  const restore = stubCostFetch(costPayload(nodes, {
    findings,
    anomalies: { preset: 'balanced', thresholds: { spike: { madMultiple: 6, floor: 0.25 } } },
  }))
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    const rowsOf = (element) => textOf(find(element, (each) => String(each.props?.className).split(' ').includes('dshb_findings_list'))[0])
    const badges = (element) => find(element, (each) => String(each.props?.className).split(' ').includes('dshb_cost_badge')).length
    const before = rowsOf(tree)
    assert.match(before, /cost\.finding\.kind\.spike/)
    assert.equal(badges(tree), 1)

    // The same series under another projection and another metric: the Host detected on
    // `fact` and the client only filters, so nothing about the verdict may change.
    for (const button of ['cost.proj.peak', 'cost.metric.tokens']) {
      const control = find(tree, (element) => element.type === 'button' && element.children?.join('') === button)[0]
      assert.ok(control !== undefined, `${button} is on screen`)
      control.props.onClick()
      react.beginRender()
      tree = react.createElement(exported.__internals.CostView, props)
      assert.match(textOf(tree), new RegExp(button.replace('.', '\\.')), 'the control switched')
    }
    assert.equal(rowsOf(tree), before, 'the findings list is byte for byte the same')
    assert.equal(badges(tree), 1, 'and so is the badge')
  } finally {
    react.stop()
    restore()
  }
})

test('a badge names the top-ranked kind and counts every Finding behind it', async () => {
  const { exported, react } = await loadClient()
  const nodes = [costNode({ turn: 1, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE })]
  // Three Findings on one Step: an alert, a warn and an info. The badge names the
  // top-ranked one — severity first — and counts all three; the info one draws nothing
  // of its own but still has a row.
  const findings = [
    // An alert whose margin was barely past its floor can rank below a confident warn.
    finding('spike', [0], { severity: 'alert', confidence: 40 }),
    finding('cache-miss', [0], { severity: 'warn', confidence: 95 }),
    finding('verbose-output', [0], { severity: 'info', confidence: 90 }),
  ]
  const restore = stubCostFetch(costPayload(nodes, {
    findings,
    anomalies: { preset: 'balanced', thresholds: { spike: { madMultiple: 6, floor: 0.25 } } },
  }))
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => ({ seq: 5, currency: 'CNY' }) }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    const tree = react.createElement(exported.__internals.CostView, props)
    const text = textOf(tree)
    const badges = find(tree, (element) => String(element.props?.className).split(' ').includes('dshb_cost_badge'))
    assert.equal(badges.length, 1, 'one badge for the one Step that carries loud Findings')
    // One ranking everywhere: severity × confidence. The warn with 95 outranks the alert
    // with 40, exactly as it would in the list.
    assert.match(textOf(badges[0]), /⊘/, 'the glyph is the highest-ranked Finding, not the earliest')
    // `info` draws no badge of its own, so it is not part of the badge's count either:
    // it lives in the list, where all three are.
    assert.match(textOf(badges[0]), /2/, 'and the count is the Findings the badge stands for')
    const rows = find(tree, (element) => String(element.props?.className).split(' ').includes('dshb_findings_list'))[0]
    assert.equal(find(rows, (element) => String(element.props?.className).split(' ').includes('dshb_finding')).length, 3, 'all three are listed')
  } finally {
    react.stop()
    restore()
  }
})

test('a window that holds no Finding says so instead of showing a stale one', async () => {
  const { exported, react } = await loadClient()
  const nodes = [
    costNode({ turn: 1, step: 1, tStart: NOW - HOUR, tEnd: NOW - HOUR + MINUTE }),
    costNode({ turn: 1, step: 2, tStart: NOW - 30 * MINUTE, tEnd: NOW - 30 * MINUTE + MINUTE }),
    costNode({ turn: 1, step: 3, tStart: NOW - 10 * MINUTE, tEnd: NOW }),
  ]
  const restore = stubCostFetch(findingsPayload(nodes, [finding('spike', [2], { severity: 'alert', confidence: 88 })]))
  try {
    const props = { t: (key) => key, sessionId: 'session-7', useProjection: () => undefined }
    react.beginRender()
    textOf(react.createElement(exported.__internals.CostView, props))
    await new Promise((resolve) => setTimeout(resolve, 10))
    react.beginRender()
    let tree = react.createElement(exported.__internals.CostView, props)
    assert.match(textOf(tree), /cost\.finding\.kind\.spike/, 'the Finding is listed over the whole session')

    const chartOf = () => {
      react.beginRender()
      return elementOf(exported.__internals.CostView(props), (element) => element.type === exported.__internals.CostChart)
    }
    chartOf().props.onWindow({ from: 0, to: 0.2 })
    tree = react.createElement(exported.__internals.CostView, props)
    textOf(tree)
    assert.doesNotMatch(textOf(tree), /cost\.finding\.kind\.spike/, 'the Step it blames is out of the window')
    assert.match(textOf(tree), /cost\.findings\.empty/, 'and the card says the range holds nothing')
    assert.match(textOf(tree), /cost\.findings\.legend/, 'while still explaining what the card is for')
    react.stop()
  } finally {
    restore()
  }
})

test('the findings card states the preset it read and the thresholds behind it', async () => {
  const { exported, react } = await loadClient()
  const Findings = exported.__internals.Findings
  const { thresholdLines } = exported.__internals
  const anomalies = {
    preset: 'strict',
    thresholds: {
      spike: { id: 'spike', madMultiple: 9, p95Factor: 7.5, reference: 3, floor: 0.375, statistical: true, sampleFactor: true, completeness: 1 },
      'pricing-gap': { id: 'pricing-gap', share: 0.3, floor: 0.5, statistical: false, sampleFactor: false, completeness: 1 },
    },
  }
  const lines = thresholdLines(anomalies)
  assert.deepEqual(lines, ['spike: madMultiple=9 p95Factor=7.5 reference=3 floor=0.375', 'pricing-gap: share=0.3 floor=0.5'], 'every gate is named, bookkeeping fields are not')
  assert.deepEqual(thresholdLines(null), [])
  const tree = react.createElement(Findings, {
    t: (key, params) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`),
    rows: [],
    anomalies,
    currency: 'CNY',
    steps: 40,
    onSelect: () => {},
  })
  const text = textOf(tree)
  assert.match(text, /cost\.findings\.preset/, 'the card says which preset the verdicts came from')
  assert.match(text, /cost\.finding\.preset\.strict/, 'by name')
  const preset = find(tree, (element) => (element.props?.className ?? '').split(' ').includes('dshb_cost_note') && String(element.props?.title ?? '').includes('madMultiple'))[0]
  assert.ok(preset !== undefined, 'and offers the effective thresholds on hover')
  assert.match(preset.props.title, /pricing-gap: share=0\.3/, 'all of them, in catalogue order')
})
