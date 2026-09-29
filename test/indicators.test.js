import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CATALOGUE, DEFAULT_PRESET, PRESETS, absoluteMargin, compareFindings, confidenceOf, countMargin,
  createFindingsMemo, detectFindings, madOf, median, normalizeAnomalies, quantile, ratioMargin,
  severityOf,
} from '../src/indicators.js'
import { PEAK, compaction, scenarios, seriesOf, steadyRun, step } from './fixtures/anomaly-sessions.js'

const kindsOf = (findings) => findings.map((finding) => finding.kind)
/** The same six-decimal rounding the evidence itself uses. */
const round6 = (value) => Math.round(value * 1e6) / 1e6
const detect = (series, options) => detectFindings(series.nodes, options)
const scenario = (name) => scenarios[name]()
const of = (findings, kind) => findings.filter((finding) => finding.kind === kind)

const STATISTICAL = ['spike', 'context-growth', 'cache-miss', 'verbose-output', 'tool-output-inflation']

test('the order statistics read a hand-computed list', () => {
  assert.equal(median([5]), 5)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([]), 0, 'an empty sample has no middle')
  assert.equal(madOf([1, 1, 1, 1]), 0, 'a list with no spread has no deviation')
  assert.equal(madOf([1, 2, 3, 4, 5]), 1, '|1-3|,|2-3|,|3-3|,|4-3|,|5-3| has a median of 1')
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(quantile([1, 2, 3, 4, 5], 0.95), 4.8)
  assert.equal(quantile([], 0.5), 0)
})

test('margins are 0 at the threshold, 1 at the reference and clamped between', () => {
  assert.equal(ratioMargin(3, 3, 3), 0)
  assert.equal(ratioMargin(9, 3, 3), 1)
  assert.equal(ratioMargin(100, 3, 3), 1)
  assert.equal(ratioMargin(1, 3, 3), 0)
  assert.equal(ratioMargin(3, 0, 3), 0, 'a threshold of zero has no margin to measure')
  assert.equal(countMargin(3, 3, 6), 0.25, 'reaching a count is already one step past it')
  assert.equal(countMargin(6, 3, 6), 1)
  assert.equal(countMargin(2, 3, 6), 0)
  assert.equal(absoluteMargin(0.3, 0.3, 0.6), 0)
  assert.equal(absoluteMargin(0.6, 0.3, 0.6), 1)
})

test('severity restates the margin and confidence is monotone in it', () => {
  assert.equal(severityOf(0.1), 'info')
  assert.equal(severityOf(0.5), 'warn')
  assert.equal(severityOf(0.85), 'alert')
  assert.equal(severityOf(1, 'info'), 'info', 'a cap holds the grade down')
  const low = confidenceOf(0.3, { sample: 40 })
  const high = confidenceOf(0.6, { sample: 40 })
  assert.ok(high > low, 'a larger margin never yields a smaller confidence')
  assert.equal(confidenceOf(1, { sample: 1000, completeness: 1 }), 100)
  assert.ok(confidenceOf(0.3, { sample: 4 }) < confidenceOf(0.3, { sample: 20 }), 'the sample discounts it')
  assert.equal(confidenceOf(1, { sampleFactor: false }), 100, 'an exact count does not wait for a sample')
  assert.ok(confidenceOf(1, { sample: 40, completeness: 0.7 }) === 70, 'a proxy is discounted')
})

test('the balanced preset is the catalogue default', () => {
  const effective = normalizeAnomalies()
  assert.equal(effective.preset, DEFAULT_PRESET)
  assert.equal(effective.byId.spike.madMultiple, 6)
  assert.equal(effective.byId.spike.floor, 0.25)
  assert.equal(effective.byId['cache-miss'].uncachedShare, 0.8, 'a calibrated rate is not moved by a preset')
  assert.equal(effective.byId['pricing-gap'].floor, 0.5)
})

test('a preset moves the gates and the floors by one documented factor', () => {
  const strict = normalizeAnomalies({ preset: 'strict' })
  const loose = normalizeAnomalies({ preset: 'loose' })
  assert.equal(strict.byId.spike.madMultiple, 9, '6 × 1.5')
  assert.equal(strict.byId.spike.floor, 0.375)
  assert.equal(strict.byId.spike.reference, 3, 'the reference is calibration, not a gate')
  assert.equal(strict.byId['pricing-gap'].floor, 0.5, 'a correctness gap is not silenced by a preset')
  assert.equal(loose.byId.spike.madMultiple, 3.6, '6 × 0.6')
  assert.equal(loose.byId.spike.floor, 0.15)
  assert.equal(PRESETS.strict, 1.5)
})

test('a threshold override is taken, and nonsense is dropped with a warning', () => {
  const warnings = []
  const effective = normalizeAnomalies({
    preset: 'nonsense',
    thresholds: {
      spike: { madMultiple: 10, nonsense: 3 },
      'no-such-indicator': { share: 5 },
      'verbose-output': { minTokens: -1 },
      calm: 4,
    },
  }, (line) => warnings.push(line))
  assert.equal(effective.preset, 'balanced', 'an unknown preset falls back instead of failing')
  assert.equal(effective.byId.spike.madMultiple, 10)
  assert.equal(effective.byId['verbose-output'].minTokens, 2000, 'a negative threshold is ignored')
  assert.equal(warnings.length, 5, 'one line per rejected value, plus the preset')
  assert.ok(warnings.some((line) => line.includes('madMultiple') === false && line.includes('nonsense')))
  assert.ok(warnings.some((line) => line.includes('no-such-indicator')))
  assert.ok(warnings.some((line) => line.includes('minTokens')))
  assert.ok(warnings.some((line) => line.includes('nonsense') && line.includes('preset')))
  assert.equal(CATALOGUE.length, 10, 'the catalogue of the issue, whole, minus the repeat detector of I29')
})

test('a Step that dominates its session is a spike with its numbers in evidence', () => {
  const findings = detect(scenarios.spike())
  const [finding] = of(findings, 'spike')
  assert.ok(finding, 'the twenty-fold Step is found')
  assert.equal(finding.severity, 'alert')
  assert.equal(finding.refs.from, finding.refs.to, 'a Step Finding blames one Step')
  assert.equal(finding.refs.turnFrom, 2)
  assert.equal(finding.evidence.metric, 'cost')
  assert.ok(finding.evidence.value > finding.evidence.threshold)
  assert.ok(finding.evidence.median > 0 && finding.evidence.mad > 0)
  assert.equal(finding.evidence.via, 'median+mad', 'the MAD gate is the one the Step cleared furthest past')
  assert.equal(finding.evidence.median, 2.1)
  assert.equal(finding.evidence.mad, 0.1)
  assert.equal(finding.evidence.threshold, 2.7, 'median + 6·MAD')
})

test('a Step that is only just past the threshold is not reported at all', () => {
  const series = seriesOf([
    ...Array.from({ length: 9 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: [1e6, 1.05e6, 1.1e6][index % 3] })),
    // 2.9 CNY against a gate of 2.1 + 6·0.1: past the raw threshold, inside the floor.
    ...step({ at: PEAK + 20000, turn: 2, step: 1, input: 1.45e6 }),
  ])
  assert.deepEqual(of(detect(series), 'spike'), [], 'below the floor an Indicator says nothing')
})

test('a runaway generation is verbose-output, and a normal one is not', () => {
  assert.ok(of(detect(scenario('verbose-output')), 'verbose-output').length === 1)
  const quiet = seriesOf(Array.from({ length: 10 }, (_, index) => step({
    at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5, output: 1500 + index,
  })))
  assert.deepEqual(of(detect(quiet), 'verbose-output'), [])
})

test('cost climbing with the context is context-growth over a fitted run', () => {
  const [finding] = of(detect(scenario('context-growth')), 'context-growth')
  assert.ok(finding, 'a linear climb is found')
  assert.equal(finding.evidence.r2, 1)
  assert.ok(finding.refs.to > finding.refs.from, 'the Finding spans the run')
  assert.equal(finding.refs.turnFrom, 1)
  assert.equal(finding.refs.turnTo, 1)
  const noisy = seriesOf(Array.from({ length: 12 }, (_, index) => step({
    at: PEAK + index * 1000, turn: 1, step: index + 1, input: (index % 2 === 0 ? 1e5 : 3e6),
  })))
  assert.deepEqual(of(detect(noisy), 'context-growth'), [], 'a zig-zag has no climb')
  const short = seriesOf([
    ...Array.from({ length: 6 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5 + index * 1e6 })),
    ...Array.from({ length: 4 }, (_, index) => step({ at: PEAK + (index + 6) * 1000, turn: 1, step: index + 7, input: 1e5 })),
  ])
  assert.deepEqual(of(detect(short), 'context-growth'), [], 'a run shorter than the minimum is not fitted')
})

test('no Indicator judges a call by the preview the view shows (I29)', () => {
  // A removed draft matched tool calls on their argument *preview* — three lines, 200
  // characters — which cannot tell a repeated command from two commands that open the
  // same way. Measured on a real session it was wrong every time, so the rule is: nothing
  // here reads `preview`, and a repeated call is not a Finding on its own.
  const source = readFileSync(new URL('../src/indicators.js', import.meta.url), 'utf8')
  assert.equal(/\bpreview\b/.test(source), false, 'the engine never reads the truncated preview')
  const series = seriesOf(Array.from({ length: 9 }, (_, index) => step({
    at: PEAK + index * 1000,
    turn: 1,
    step: index + 1,
    input: 1e6,
    calls: index < 6 ? [{ id: `call-${index}`, name: 'bash', arguments: '{"command":"ls -la"}' }] : [],
  })))
  assert.deepEqual(of(detect(series), 'repeat-tool-call'), [], 'nine identical calls are nobody’s Finding')
})

test('a Step retried twice, or a Turn full of retried Steps, is a retry storm', () => {
  const [finding] = of(detect(scenario('retry-storm')), 'retry-storm')
  assert.ok(finding, 'two retries in one Step are found')
  assert.equal(finding.evidence.metric, 'retries')
  assert.equal(finding.refs.from, finding.refs.to)
  const once = seriesOf([
    ...Array.from({ length: 9 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e6, retries: index < 1 ? 1 : 0 })),
    ...step({ at: PEAK + 10000, turn: 2, step: 1, input: 1e6 }),
  ])
  assert.deepEqual(of(detect(once), 'retry-storm'), [], 'one retry is not a storm')
  const turn = seriesOf([
    ...Array.from({ length: 3 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e6, retries: 1 })),
    ...Array.from({ length: 7 }, (_, index) => step({ at: PEAK + (index + 3) * 1000, turn: 1, step: index + 4, input: 1e6 })),
  ])
  const [wide] = of(detect(turn), 'retry-storm')
  assert.ok(wide, 'three retried Steps in one Turn are found')
  assert.equal(wide.evidence.metric, 'retriedSteps')
  assert.ok(wide.refs.to > wide.refs.from, 'and it spans the Turn')
})

test('three Steps resending their context after a cache was in use are a cache miss', () => {
  const [finding] = of(detect(scenario('cache-miss')), 'cache-miss')
  assert.ok(finding, 'the resent context is found')
  assert.equal(finding.evidence.steps, 3)
  assert.equal(finding.evidence.value, 1, 'nothing of the resent input was a cache read')
  const coldStart = seriesOf(Array.from({ length: 10 }, (_, index) => step({
    at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e6,
  })))
  assert.deepEqual(of(detect(coldStart), 'cache-miss'), [], 'a session that never cached anything has not missed')
  const short = seriesOf([
    ...Array.from({ length: 8 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5, cacheRead: 9e5 })),
    ...step({ at: PEAK + 9000, turn: 2, step: 1, input: 1e6 }),
  ])
  assert.deepEqual(of(detect(short), 'cache-miss'), [], 'one Step alone is not a run')
})

test('a large tool result the next Step pays for is tool-output-inflation', () => {
  const [finding] = of(detect(scenario('tool-output-inflation')), 'tool-output-inflation')
  assert.ok(finding, 'the input jump after a call is found')
  assert.deepEqual(finding.evidence.tools, ['read_file'])
  assert.equal(finding.refs.to, finding.refs.from + 1)
  const small = seriesOf([
    ...Array.from({ length: 8 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e6 })),
    ...step({ at: PEAK + 9000, turn: 2, step: 1, input: 1e6, calls: [{ id: 'call-1', name: 'read_file', arguments: '{}' }] }),
    ...step({ at: PEAK + 10000, turn: 2, step: 2, input: 1.005e6 }),
  ])
  assert.deepEqual(of(detect(small), 'tool-output-inflation'), [], 'a small result is not an inflation')
})

test('a compaction and the Step it made expensive are one Finding over both', () => {
  const series = scenarios['post-compaction-spike']()
  const compactionAt = series.nodes.findIndex((node) => node.kind === 'compaction')
  const [finding] = of(detect(series), 'post-compaction-spike')
  assert.ok(finding, 'the compaction bill is found')
  assert.equal(finding.refs.from, compactionAt)
  assert.equal(finding.refs.to, compactionAt + 1)
  assert.ok(finding.evidence.compactionCost > 0)
  assert.ok(finding.evidence.rebuild > finding.evidence.threshold)
  assert.equal(finding.evidence.shadowedTokenCount, 5e5)
  assert.deepEqual(
    detect(series).filter((other) => other.refs.from === compactionAt && other.refs.to === compactionAt),
    [],
    'no Indicator treats the Compaction step as a Step of its own',
  )
  const cheap = seriesOf([
    ...Array.from({ length: 8 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: [1e6, 1.05e6, 1.1e6][index % 3] })),
    ...compaction({ at: PEAK + 12000, id: 'cmp-1' }),
    ...step({ at: PEAK + 13000, turn: 2, step: 1, input: 1e6 }),
  ])
  assert.deepEqual(of(detect(cheap), 'post-compaction-spike'), [], 'a compaction that cost nothing extra is not a spike')
  const trailing = seriesOf([
    ...Array.from({ length: 8 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e6 })),
    ...compaction({ at: PEAK + 12000, id: 'cmp-1' }),
  ])
  assert.deepEqual(of(detect(trailing), 'post-compaction-spike'), [], 'a compaction with no Step after it proves nothing')
})

test('peak-window money is tariff-attributable, and an off-peak session is not', () => {
  const [finding] = of(detect(scenario('tariff-attributable')), 'tariff-attributable')
  assert.ok(finding, 'half of a peak session disappears off-peak')
  assert.equal(finding.evidence.value, 0.5)
  assert.equal(finding.severity, 'info', 'every daytime session pays the clock: it explains, it does not accuse')
  assert.deepEqual(of(detect(scenario('off-peak')), 'tariff-attributable'), [], 'a weekend session loses nothing to the window')
})

test('an unpriced model is one pricing-gap over its Steps, not a Finding per Step', () => {
  const findings = of(detect(scenario('pricing-gap')), 'pricing-gap')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].refs.turnFrom, 2)
  assert.equal(findings[0].severity, 'warn')
  assert.ok(findings[0].evidence.value > 0)
  assert.deepEqual(of(detect(scenarios.calm), 'pricing-gap'), [])
})

test('a subtree is reported only when it was read and outweighs the session', () => {
  const series = scenarios.calm()
  const big = detect(series, { subtree: { cost: series.view.cost / 2 } })
  const [finding] = of(big, 'expensive-subtree')
  assert.ok(finding, 'half the session is worth naming')
  assert.equal(finding.evidence.spawningSteps, 0)
  assert.ok(finding.refs.to >= finding.refs.from)
  assert.deepEqual(of(detect(series), 'expensive-subtree'), [], 'the session reading never claims a subtree')
  assert.deepEqual(of(detect(series, { subtree: { cost: 1 } }), 'expensive-subtree'), [])
})

test('a session too short to have a norm is left to the rule-based Indicators', () => {
  const findings = detect(scenario('short-session'))
  for (const kind of STATISTICAL) assert.deepEqual(of(findings, kind), [], `${kind} waits for a norm`)
  assert.ok(of(findings, 'tariff-attributable').length === 1, 'a rule-based Indicator still speaks')
})

test('Unpriced Steps are skipped by the money Indicators and still read by the tokens', () => {
  const series = seriesOf([
    ...Array.from({ length: 9 }, (_, index) => step({
      at: PEAK + index * 1000, turn: 1, step: index + 1, model: 'reseller-model', input: 2e6, output: 2e5,
    })),
    ...step({ at: PEAK + 10000, turn: 2, step: 1, model: 'reseller-model', input: 2e7, output: 1e6 }),
  ])
  const findings = detect(series)
  assert.deepEqual(of(findings, 'spike'), [], 'a Step whose cost is unknown is not a cheap Step')
  assert.equal(
    of(findings, 'verbose-output').length, 1,
    'while a token-based Indicator still reads it: the answer is long, whatever the model costs',
  )
  assert.equal(of(findings, 'pricing-gap').length, 1, 'and the gap itself is named once')
})

test('the same series yields the same Findings in the same order', () => {
  const series = scenarios['post-compaction-spike']()
  const once = detect(series)
  const twice = detect(series)
  assert.deepEqual(once, twice)
  const weight = { info: 1, warn: 2, alert: 3 }
  const ranked = once.map((finding) => weight[finding.severity] * finding.confidence)
  for (let index = 1; index < ranked.length; index += 1) {
    assert.ok(ranked[index - 1] >= ranked[index], 'the list is ordered by severity × confidence')
  }
  assert.equal(detectFindings([]).length, 0, 'an empty series has nothing to say')
  assert.equal(detectFindings(undefined).length, 0)
})

test('an Indicator that finds nothing in a quiet session finds nothing at all', () => {
  const findings = detect(scenarios.calm())
  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['tariff-attributable'],
    'only the tariff note, which is a fact about the clock rather than about the work',
  )
})

test('the findings memo answers the same key without recomputing', () => {
  const series = scenario('calm')
  const memo = createFindingsMemo()
  let computed = 0
  const compute = () => {
    computed += 1
    return detectFindings(series.nodes)
  }
  const first = memo.read('session-1:9:rule:balanced', compute)
  assert.equal(computed, 1)
  assert.equal(memo.read('session-1:9:rule:balanced', () => { throw new Error('recomputed') }), first)
  assert.equal(computed, 1, 'the same key is never detected twice')
  const moved = memo.read('session-1:10:rule:balanced', compute)
  assert.equal(computed, 2, 'a new seq is a new verdict')
  assert.notEqual(moved, first)
})

test('detection over ten thousand Steps stays inside the Host budget', () => {
  const nodes = Array.from({ length: 10_000 }, (_, index) => ({
    kind: 'step',
    turn: 1 + Math.floor(index / 10),
    step: (index % 10) + 1,
    ended: true,
    hasUsage: true,
    retries: 0,
    calls: [],
    buckets: { uncachedInput: 1e5 + (index % 7) * 1000, cacheRead: 9e5, cacheWrite: 0, output: 1000 + (index % 11) },
    cost: 0.2 + (index % 13) * 0.01,
    costByBucket: {},
    offPeak: { cost: 0.1, costByBucket: {} },
    peak: { cost: 0.2, costByBucket: {} },
    unpriced: false,
    children: [],
  }))
  const started = process.hrtime.bigint()
  const findings = detectFindings(nodes)
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(findings.length >= 0)
  // The design budget is 50 ms for a 10⁴-Step series; the assertion carries CI headroom,
  // and the local measurement is around a tenth of it.
  assert.ok(elapsed < 150, `detecting a 10⁴-Step series took ${elapsed.toFixed(1)} ms, over the budget`)
})

test('every statistical Indicator stays silent below eight Steps with usage', () => {
  // Each of these sessions would fire its Indicator on a longer run: one enormous answer
  // among short ones, a cache in use followed by misses, and a tool result the next Step
  // pays for.
  const loud = (extra = []) => seriesOf([
    ...Array.from({ length: 3 }, (_, index) => step({
      at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5, output: 1000,
    })),
    ...extra,
    // The enormous answer, always last, whichever session it lands in.
    ...step({ at: PEAK + 60000, turn: 9, step: 1, input: 1e5, output: 400000 }),
  ])
  assert.deepEqual(of(detect(loud()), 'verbose-output'), [], 'four Steps are the session, not the norm')
  assert.equal(of(detect(loud(steadyRun(5, { from: 3 }))), 'verbose-output').length, 1, 'eight Steps make the same answer unusual')

  const cached = (extra = []) => seriesOf([
    ...Array.from({ length: 2 }, (_, index) => step({ at: PEAK + index * 1000, turn: 1, step: index + 1, input: 1e5, cacheRead: 9e5 })),
    ...Array.from({ length: 2 }, (_, index) => step({ at: PEAK + (index + 2) * 1000, turn: 1, step: index + 3, input: 1e6 })),
    ...extra,
  ])
  assert.deepEqual(of(detect(cached()), 'cache-miss'), [], 'two misses in a four-Step session are not a run')
  assert.equal(of(detect(cached(steadyRun(4, { from: 4 }))), 'cache-miss').length, 1, 'eight Steps make the same run a pattern')

  const inflated = (extra = []) => seriesOf([
    ...steadyRun(5, { at: PEAK, turn: 1 }),
    ...step({ at: PEAK + 6000, turn: 2, step: 1, input: 1e5, calls: [{ id: 'call-1', name: 'read_file', arguments: '{"path":"big.log"}' }] }),
    ...step({ at: PEAK + 7000, turn: 2, step: 2, input: 1e6 }),
    ...extra,
  ])
  assert.deepEqual(of(detect(inflated()), 'tool-output-inflation'), [], 'the jump in a seven-Step session is not scored')
  assert.equal(of(detect(inflated(steadyRun(1, { at: PEAK + 8000, turn: 2, from: 2 }))), 'tool-output-inflation').length, 1, 'eight Steps score it')
})

test('an Unpriced Step leaves the rebuild of a compaction unknown, not free', () => {
  const build = (model) => seriesOf([
    ...steadyRun(8, { at: PEAK, turn: 1 }),
    ...compaction({ at: PEAK + 8000, id: 'cmp-1', turn: 1, input: 4e6, output: 1e5 }),
    ...step({ at: PEAK + 9000, turn: 1, step: 9, model, input: 3e7 }),
    ...step({ at: PEAK + 10000, turn: 1, step: 10, input: 1e6 }),
  ])
  const unpriced = build('no-such-model')
  assert.equal(unpriced.nodes.some((node) => node.unpriced === true), true, 'the fixture has an Unpriced Step')
  const [loose] = of(detect(unpriced), 'post-compaction-spike')
  assert.ok(loose, 'the compaction bill alone still clears the gate')
  assert.equal(loose.evidence.rebuild, null, 'and the rebuild it cannot price is unknown')
  assert.ok(loose.evidence.compactionCost > 0)
  const priced = build('deepseek-flash')
  const [scored] = of(detect(priced), 'post-compaction-spike')
  assert.ok(scored.evidence.rebuild > 0, 'a priced Step gives the rebuild its cost')
})

test('detection reads the series and nothing else', () => {
  // "Free" is a property of the module, not a promise: it imports nothing, so it cannot
  // reach the network, the disk or the clock. What a test can pin is that running it
  // performs no I/O even when a global that could serve one is right there.
  const source = readFileSync(new URL('../src/indicators.js', import.meta.url), 'utf8')
  assert.deepEqual(source.match(/^import .*$/gm) ?? [], [], 'the module imports nothing at all')
  const realFetch = globalThis.fetch
  let called = 0
  globalThis.fetch = () => {
    called += 1
    throw new Error('detection must not fetch')
  }
  try {
    const series = scenario('spike')
    assert.ok(detect(series).length > 0, 'detection ran')
    detect(series, { subtree: { cost: 1 } })
  } finally {
    globalThis.fetch = realFetch
  }
  assert.equal(called, 0, 'no network request was made in the process')
})

test('a verdict the grown series no longer supports disappears', () => {
  // A Step that dominated nine cheap ones; the tail then fills up with Steps of the same
  // size, so the same Step is ordinary and the Finding goes with its margin.
  const dominant = step({ at: PEAK + 20000, turn: 2, step: 1, input: 2e7 })
  const short = seriesOf([...steadyRun(9), dominant])
  assert.equal(of(detect(short), 'spike').length, 1, 'the Step dominates the session')
  const tail = Array.from({ length: 20 }, (_, index) => step({
    at: PEAK + 30000 + index * 1000, turn: 2, step: index + 2, input: 2e7,
  }))
  const grown = seriesOf([...steadyRun(9), dominant, ...tail])
  assert.deepEqual(of(detect(grown), 'spike'), [], 'the same money, a session away, is the session')
})

test('the reading order ranks by severity × confidence, then by the money blamed', () => {
  const make = (severity, confidence, share, from, kind = 'spike') => ({
    kind, severity, confidence, evidence: { share }, refs: { from, to: from },
  })
  const sorted = (list) => [...list].sort(compareFindings).map((finding) => finding.kind + finding.refs.from)
  // A confident warn outranks an alert that barely cleared its floor.
  assert.deepEqual(
    sorted([make('alert', 40, 0.9, 5, 'spike'), make('warn', 95, 0.1, 1, 'cache-miss')]),
    ['cache-miss1', 'spike5'],
  )
  // At equal weight the money decides, whatever the position.
  assert.deepEqual(
    sorted([make('warn', 60, 0.01, 1, 'spike'), make('warn', 60, 0.4, 9, 'cache-miss')]),
    ['cache-miss9', 'spike1'],
  )
  // Equal weight and equal share: the earlier position, then the kind, so the order is total.
  assert.deepEqual(
    sorted([make('warn', 60, 0.2, 7, 'spike'), make('warn', 60, 0.2, 2, 'cache-miss'), make('warn', 60, 0.2, 7, 'cache-miss')]),
    ['cache-miss2', 'cache-miss7', 'spike7'],
  )
  assert.equal(compareFindings(make('warn', 60, 0.2, 7), make('warn', 60, 0.2, 7)), 0, 'a Finding ties with itself')
})

test('the share of a Finding is a share of the session money, whatever it measured', () => {
  const totalOf = (series) => series.nodes.reduce((sum, node) => sum + (node.cost ?? 0), 0)
  for (const [name, make] of Object.entries(scenarios)) {
    if (typeof make !== 'function') continue
    const total = totalOf(scenario(name))
    for (const finding of detect(scenario(name))) {
      const share = finding.evidence.share
      assert.ok(share >= 0 && share <= 1, `${name}/${finding.kind} has a share inside [0, 1], got ${share}`)
      // The money a Finding names is the money it shares: a token count or a repeat
      // count divided by the session cost would rank unlike things against each other.
      if (finding.evidence.cost !== undefined && total > 0) {
        assert.equal(share, round6(finding.evidence.cost / total), `${finding.kind} shares the cost it reports`)
      }
    }
  }
  const verbose = of(detect(scenario('verbose-output')), 'verbose-output')[0]
  const verboseTotal = totalOf(scenario('verbose-output'))
  assert.ok(verbose.evidence.share > 0, 'a verbose answer still blames the Step that paid for it')
  assert.ok(verbose.evidence.share <= 1, 'and never more than the session, whatever it measured')
  assert.notEqual(verbose.evidence.share, round6(verbose.evidence.value / verboseTotal), 'tokens are not money')
  const spike = of(detect(scenario('spike')), 'spike')[0]
  assert.equal(spike.evidence.share, round6(spike.evidence.value / totalOf(scenario('spike'))), 'a cost Finding shares the cost it names')
  const tariff = of(detect(scenario('tariff-attributable')), 'tariff-attributable')[0]
  assert.equal(tariff.evidence.share, round6(tariff.evidence.delta / tariff.evidence.total))
  const gap = of(detect(scenario('pricing-gap')), 'pricing-gap')[0]
  assert.equal(gap.evidence.share, 0, 'a missing rate is not a share of what was spent')
  const calm = scenarios.calm()
  const attack = of(detect(calm, { subtree: { cost: calm.view.cost / 2 } }), 'expensive-subtree')[0]
  assert.equal(attack.evidence.share, attack.evidence.value, 'the share the Indicator computed is the share it reports')
  assert.equal(attack.evidence.share, 0.5, 'and it is the share of the session the subtree cost')
})
