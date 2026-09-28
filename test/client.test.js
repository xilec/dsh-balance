import test from 'node:test'
import assert from 'node:assert/strict'

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
    useRef(initial) {
      const index = state.cursor++
      // The plugin only takes a ref to measure an element, so the stub hands it a
      // stand-in with a readable offsetHeight.
      if (!(index in state.slots)) state.slots[index] = { current: initial ?? { offsetHeight: 321 } }
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
  return {
    registered,
    services,
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
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
  assert.equal(metricOf(nodes[1], 'tokens'), 10)
  assert.equal(metricOf(nodes[0], 'output'), 1e6)
  const { fromMs, toMs } = seriesWindow(nodes)
  assert.equal(fromMs, nodes[0].tStart)
  assert.equal(toMs, nodes[2].tEnd)

  const plot = buildPlot(nodes, { width: 300, height: 100, clip: false })
  assert.equal(plot.points.length, 3)
  assert.deepEqual(plot.points.map((point) => point.x > 0), [false, true, true], 'time is the x axis by default')
  assert.equal(plot.threshold, null, 'clipping off means no threshold')
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
    loadOlder: async () => {
      loaded.push(true)
      return true
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
  assert.deepEqual(loaded, [true])
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
  render(null).plot.props.onWheel({ deltaY: -1, clientX: 360, preventDefault: () => { prevented += 1 } })
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
    assert.equal(children.length, 2, 'exactly the inspector and the top list')
    assert.equal(children[0].props.className, 'dshb_cost_pane', 'inspector first, so it is the left column')
    assert.match(textOf(children[0]), /cost\.inspector\.empty/)
    assert.match(textOf(children[1]), /cost\.topk\.title/)
    assert.equal(find(tree, (element) => element.props?.className === 'dshb_cost_card').length, 1)
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
    // Step has to be remembered outside it: coming back must mark the same one.
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
