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
    locale: { register: () => () => {} },
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

test('apply registers the readout before the stats entry, plus both peak surfaces', async () => {
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
  assert.equal(ctx.registered.length, 3)
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

test('a day row saves and clears a manual correction through the Host', async () => {
  const { exported, react } = await loadClient()
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
