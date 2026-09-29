/**
 * Cost anomaly Indicators: deterministic detectors over a session's priced series.
 *
 * An Indicator reads the per-Step series the Host already built — the same records the
 * Cost view draws — and reports a **Finding**: `{kind, refs, severity, confidence,
 * evidence}`. Nothing here calls a model, touches the network or reads a clock, so the
 * same series and the same thresholds always yield the same Findings.
 *
 * Three rules shape the catalogue:
 *
 * - **The baseline is the whole session.** Median, MAD, p95 and the session's own norm
 *   are computed over every Step with usage, so zooming into a Step never redefines
 *   what is normal.
 * - **A margin, not a probability.** Every detector measures how far past its threshold
 *   a value sits (`m ∈ [0,1]`), and `severity` restates that margin while `confidence`
 *   multiplies it by the size of the sample and the completeness of the evidence.
 *   Below its reporting floor an Indicator says nothing at all.
 * - **Money where money is known.** A money-based Indicator skips Unpriced Steps, whose
 *   cost is unknown rather than zero; token-based ones still read them. A Compaction
 *   step is money without a conversation, so only `post-compaction-spike` reads it.
 *
 * @module dsh-balance/indicators
 */

/** The Sensitivity presets, as the factor they move every gate and floor by. */
export const PRESETS = Object.freeze({ strict: 1.5, balanced: 1, loose: 0.6 })

/** The preset in force when the configuration names none. */
export const DEFAULT_PRESET = 'balanced'

/**
 * The catalogue: what each Indicator detects, the thresholds of the `balanced` preset,
 * which of those the presets move (`scaled`) and how completely it can know its inputs
 * (`completeness`, which discounts a verdict built on a proxy).
 *
 * `statistical` marks the Indicators that stay silent on a session too short to have a
 * norm; `sampleFactor` marks the ones whose confidence grows with that sample.
 */
export const CATALOGUE = Object.freeze([
  {
    id: 'spike',
    statistical: true,
    sampleFactor: true,
    completeness: 1,
    floor: 0.25,
    scaled: ['madMultiple', 'p95Factor'],
    thresholds: { madMultiple: 6, p95Factor: 5, reference: 3 },
  },
  {
    id: 'retry-storm',
    statistical: false,
    sampleFactor: false,
    completeness: 1,
    floor: 0.25,
    scaled: ['stepRetries', 'turnRetriedSteps'],
    thresholds: { stepRetries: 2, turnRetriedSteps: 3, reference: 4 },
  },
  {
    id: 'context-growth',
    statistical: true,
    sampleFactor: true,
    completeness: 0.85,
    floor: 0.25,
    scaled: ['minRise'],
    thresholds: { minSteps: 8, minR2: 0.7, minRise: 1, reference: 3 },
  },
  {
    id: 'post-compaction-spike',
    statistical: false,
    sampleFactor: true,
    // The rebuild is read from the Step's own tokens; the summary call is explicit.
    completeness: 0.85,
    floor: 0.25,
    scaled: ['rebuildRatio'],
    thresholds: { rebuildRatio: 2, reference: 4 },
  },
  {
    id: 'cache-miss',
    statistical: true,
    sampleFactor: true,
    completeness: 1,
    floor: 0.25,
    scaled: ['minRun'],
    thresholds: { minRun: 2, uncachedShare: 0.8, cacheReadShare: 0.05, reference: 5 },
  },
  {
    id: 'tool-output-inflation',
    statistical: true,
    sampleFactor: true,
    // The size of a tool result is not in the series: the next Step's input growth is
    // the proxy for it, which is why this verdict is discounted.
    completeness: 0.7,
    floor: 0.25,
    scaled: ['minDelta'],
    thresholds: { minDelta: 20000, reference: 2 },
  },
  {
    id: 'verbose-output',
    statistical: true,
    sampleFactor: true,
    completeness: 1,
    floor: 0.25,
    scaled: ['minTokens', 'medianFactor'],
    thresholds: { minTokens: 2000, medianFactor: 3, reference: 2 },
  },
  {
    id: 'expensive-subtree',
    statistical: false,
    sampleFactor: false,
    completeness: 0.85,
    floor: 0.25,
    scaled: ['share'],
    thresholds: { share: 0.3, reference: 0.6 },
  },
  {
    id: 'tariff-attributable',
    statistical: false,
    sampleFactor: false,
    completeness: 1,
    // Every peak-window session loses money to the clock, so this Finding explains
    // rather than accuses: it is never worth a badge on the chart.
    maxSeverity: 'info',
    floor: 0.25,
    scaled: ['share'],
    thresholds: { share: 0.25, reference: 0.5 },
  },
  {
    id: 'pricing-gap',
    statistical: false,
    sampleFactor: false,
    completeness: 1,
    // A reader must be told when the totals understate reality; the floor stays put
    // whatever the preset, so a strict reader is not left with a silent gap.
    scaleFloor: false,
    floor: 0.5,
    scaled: [],
    thresholds: { share: 0.3 },
  },
])

const SEVERITY_WEIGHT = Object.freeze({ info: 1, warn: 2, alert: 3 })
const SEVERITY_ORDER = Object.freeze(['info', 'warn', 'alert'])
const BUCKET_KEYS = ['uncachedInput', 'cacheRead', 'cacheWrite', 'output']

const clamp01 = (value) => Math.min(1, Math.max(0, value))
const round6 = (value) => Math.round(value * 1e6) / 1e6

/** The value in the middle of a sorted list (mean of the two middles when even). */
export function median(sorted) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The median absolute deviation: a baseline an outlier cannot drag along. */
export function madOf(values, center = median([...values].sort((a, b) => a - b))) {
  if (!Array.isArray(values) || values.length === 0) return 0
  return median(values.map((value) => Math.abs(value - center)).sort((a, b) => a - b))
}

/** The value below which `share` of a sorted list falls. */
export function quantile(sorted, share) {
  if (!Array.isArray(sorted) || sorted.length === 0) return 0
  const position = clamp01(share) * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/** How far past a threshold that scales with the value a measurement sits, in 0..1. */
export function ratioMargin(value, threshold, reference) {
  if (!(threshold > 0) || !(reference > 1)) return 0
  return clamp01((value / threshold - 1) / (reference - 1))
}

/** How far past a counted threshold a count sits: reaching it is already a signal. */
export function countMargin(value, threshold, reference) {
  if (!(reference > threshold)) return value >= threshold ? 1 : 0
  return clamp01((value - threshold + 1) / (reference - threshold + 1))
}

/** How far past a threshold a measurement in the threshold's own units sits. */
export function absoluteMargin(value, threshold, reference) {
  if (!(reference > threshold)) return value >= threshold ? 1 : 0
  return clamp01((value - threshold) / (reference - threshold))
}

/** The discrete restatement of a margin: no second judgement, just the same number. */
export function severityOf(margin, cap) {
  const grade = margin >= 0.85 ? 'alert' : margin >= 0.5 ? 'warn' : 'info'
  if (cap === undefined) return grade
  return SEVERITY_ORDER.indexOf(grade) > SEVERITY_ORDER.indexOf(cap) ? cap : grade
}

/** Confidence on 0..100: the margin, discounted by the sample and the evidence. */
export function confidenceOf(margin, { sample = 1, sampleFactor = true, completeness = 1 } = {}) {
  const size = sampleFactor ? clamp01(sample / 20) : 1
  return Math.max(0, Math.min(100, Math.round(100 * margin * size * completeness)))
}

/**
 * The thresholds in force, from the plugin configuration.
 *
 * A preset moves the gates listed in `scaled` and the floor of every Indicator that
 * scales it; rates such as `minR2` or `uncachedShare` are calibrated, not gated, and
 * moving them by a preset could push them out of reach. An unknown Indicator id, an
 * unknown field or a value that is not a positive finite number is dropped with one
 * warning instead of failing the plugin.
 *
 * @param raw - the `anomalies` configuration block, as written.
 * @param warn - one line per rejected value.
 * @returns `{ preset, byId }`, the effective thresholds per Indicator.
 */
export function normalizeAnomalies(raw = {}, warn = () => {}) {
  const asked = raw?.preset
  if (asked !== undefined && !Object.prototype.hasOwnProperty.call(PRESETS, asked)) {
    warn(`unknown Indicator preset ${JSON.stringify(asked)}; using ${DEFAULT_PRESET}`)
  }
  const preset = Object.prototype.hasOwnProperty.call(PRESETS, asked) ? asked : DEFAULT_PRESET
  const factor = PRESETS[preset]
  const overrides = raw?.thresholds ?? {}
  if (overrides !== null && typeof overrides !== 'object') {
    warn('Indicator thresholds must be an object; using the defaults')
  }
  if (overrides !== null && typeof overrides === 'object') {
    const known = new Set(CATALOGUE.map((entry) => entry.id))
    for (const id of Object.keys(overrides)) {
      if (!known.has(id)) warn(`unknown Indicator ${id} in the thresholds; ignored`)
    }
  }
  const byId = {}
  for (const entry of CATALOGUE) {
    const own = { ...entry.thresholds, floor: entry.floor }
    // A field the reader set by hand is theirs as written: the preset moves the table
    // it ships, not the numbers someone pinned beside it.
    const pinned = new Set()
    const given = overrides !== null && typeof overrides === 'object' ? overrides[entry.id] : undefined
    if (given !== undefined) {
      if (given === null || typeof given !== 'object') {
        warn(`Indicator thresholds for ${entry.id} must be an object; using the defaults`)
      } else {
        for (const [field, value] of Object.entries(given)) {
          if (!Object.prototype.hasOwnProperty.call(own, field)) {
            warn(`unknown threshold ${entry.id}.${field}; ignored`)
            continue
          }
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            warn(`threshold ${entry.id}.${field} must be a positive number; ignored`)
            continue
          }
          own[field] = value
          pinned.add(field)
        }
      }
    }
    for (const field of entry.scaled) {
      if (!pinned.has(field)) own[field] = round6(own[field] * factor)
    }
    if (entry.scaleFloor !== false && !pinned.has('floor')) own.floor = clamp01(own.floor * factor)
    own.id = entry.id
    own.statistical = entry.statistical
    own.sampleFactor = entry.sampleFactor
    own.completeness = entry.completeness
    own.maxSeverity = entry.maxSeverity
    byId[entry.id] = own
  }
  return { preset, byId }
}

/** The four token buckets of one node summed into the input the model had to read. */
const inputTokensOf = (node) => (node.buckets?.uncachedInput ?? 0)
  + (node.buckets?.cacheRead ?? 0) + (node.buckets?.cacheWrite ?? 0)

/**
 * A one-entry memo for the Host: the same series under the same rules is detected once.
 *
 * The Cost view re-reads the series on every live tail, and detection is a pure
 * function of the priced series and the thresholds, so the last verdict is worth
 * keeping. The caller owns the key, because only it knows what moved: a new `seq`,
 * a repriced history or a new set of thresholds all invalidate the entry.
 *
 * @returns `{ read(key, compute) }` — the memoised Findings of the last key.
 */
export function createFindingsMemo() {
  let cached = null
  return {
    read(key, compute) {
      if (cached !== null && cached.key === key) return cached.findings
      const findings = compute()
      cached = { key, findings }
      return findings
    },
  }
}

const tokensOf = (node) => BUCKET_KEYS.reduce((total, key) => total + (node.buckets?.[key] ?? 0), 0)

/**
 * Detect every Finding of one session's series.
 *
 * @param nodes - the priced series the series route returns.
 * @param options - `anomalies` (from `normalizeAnomalies`) and the already-read
 * `subtree` (`{ cost }`) that only the subtree reading can supply.
 * @returns Findings, most worth reading first.
 */
export function detectFindings(nodes, options = {}) {
  const list = Array.isArray(nodes) ? nodes : []
  const anomalies = options.anomalies ?? normalizeAnomalies()
  const thresholds = (id) => anomalies.byId[id]

  const steps = []
  const used = []
  const priced = []
  const compactions = []
  list.forEach((node, index) => {
    if ((node.kind ?? 'step') === 'compaction') {
      compactions.push({ i: index, node })
      return
    }
    const entry = { i: index, node }
    steps.push(entry)
    if (node.hasUsage === true) {
      used.push(entry)
      if (node.unpriced !== true) priced.push(entry)
    }
  })

  const costs = priced.map(({ node }) => node.cost)
  const sortedCosts = [...costs].sort((a, b) => a - b)
  const medianCost = median(sortedCosts)
  const madCost = madOf(costs, medianCost)
  const p95Cost = quantile(sortedCosts, 0.95)
  const totalCost = list.reduce((total, node) => total + (node.cost ?? 0), 0)
  const shareOf = (value) => (totalCost > 0 ? value / totalCost : 0)
  /**
   * The population the statistical Indicators need before they may speak: eight Steps
   * with usage. Below it a median or a MAD is a guess about noise, so the rule-based
   * Indicators keep working and the statistical ones stay silent.
   */
  const sampled = used.length >= 8
  const outputs = used.map(({ node }) => node.buckets?.output ?? 0)
  const meanOutput = outputs.length === 0 ? 0 : outputs.reduce((a, b) => a + b, 0) / outputs.length
  const deviance = outputs.length === 0
    ? 0
    : Math.sqrt(outputs.reduce((total, value) => total + (value - meanOutput) ** 2, 0) / outputs.length)

  /** The reference the Finding carries: the series positions it blames. */
  const refsOf = (from, to = from) => ({
    from,
    to,
    turnFrom: list[from]?.turn ?? null,
    stepFrom: list[from]?.step ?? null,
    turnTo: list[to]?.turn ?? null,
    stepTo: list[to]?.step ?? null,
  })

  const findings = []
  // `money` is the amount the Finding blames, and it alone becomes `share`: the
  // evidence may measure tokens or a count, but a share of the session can only be
  // money, or the ranking would compare unlike numbers.
  const report = (kind, values, refs, evidence, money = 0) => {
    if (values === null) return
    const margin = values.margin
    if (!(margin >= values.floor)) return
    findings.push({
      kind,
      refs,
      severity: severityOf(margin, values.maxSeverity),
      confidence: confidenceOf(margin, {
        sample: values.sample ?? 1,
        sampleFactor: values.sampleFactor,
        completeness: values.completeness,
      }),
      evidence: { ...evidence, share: round6(shareOf(money)), sample: values.sample ?? 1 },
    })
  }

  // spike — one Step that dominates the session.
  {
    const values = thresholds('spike')
    if (sampled) {
      const thresholdA = medianCost + values.madMultiple * madCost
      const thresholdB = Math.max(p95Cost, values.p95Factor * medianCost)
      for (const { i, node } of priced) {
        const cost = node.cost
        let margin = 0
        let threshold = thresholdA
        let via = 'median+mad'
        if (madCost > 0 && cost > thresholdA) margin = ratioMargin(cost, thresholdA, values.reference)
        if (thresholdB > 0 && cost > thresholdB) {
          const other = ratioMargin(cost, thresholdB, values.reference)
          // On a tie the wider gate is the one worth naming: it is the harder of the
          // two conditions the Step actually cleared.
          if (other > margin || (other === margin && thresholdB > threshold)) {
            margin = other
            threshold = thresholdB
            via = 'p95'
          }
        }
        if (margin <= 0) continue
        report('spike', { ...values, margin, sample: priced.length }, refsOf(i), {
          metric: 'cost',
          value: cost,
          threshold: round6(threshold),
          via,
          median: round6(medianCost),
          mad: round6(madCost),
          z: madCost > 0 ? round6((cost - medianCost) / madCost) : null,
          p95: round6(p95Cost),
        }, cost)
      }
    }
  }

  // verbose-output — a generation far longer than this session's own norm.
  {
    const values = thresholds('verbose-output')
    if (sampled) {
      const medianOutput = median([...outputs].sort((a, b) => a - b))
      const threshold = Math.max(values.minTokens, values.medianFactor * medianOutput)
      for (const { i, node } of used) {
        const value = node.buckets?.output ?? 0
        if (value <= threshold) continue
        report('verbose-output', {
          ...values, margin: ratioMargin(value, threshold, values.reference), sample: used.length,
        }, refsOf(i), {
          metric: 'outputTokens',
          value,
          threshold: round6(threshold),
          median: round6(medianOutput),
          z: deviance > 0 ? round6((value - meanOutput) / deviance) : null,
        }, node.cost ?? 0)
      }
    }
  }

  // context-growth — cost climbing with the context over a run of Steps.
  {
    const values = thresholds('context-growth')
    if (sampled) {
      let run = [priced[0]]
      const flush = () => {
        if (run.length >= values.minSteps) {
          const runCost = run.reduce((total, entry) => total + (entry.node.cost ?? 0), 0)
          const fit = linearFit(run.map(({ node }) => node.cost))
          const rise = fit.slope * (run.length - 1)
          const threshold = values.minRise * medianCost
          if (fit.slope > 0 && fit.r2 >= values.minR2 && threshold > 0 && rise > threshold) {
            const first = run[0]
            const last = run[run.length - 1]
            report('context-growth', {
              ...values, margin: ratioMargin(rise, threshold, values.reference), sample: priced.length,
            }, refsOf(first.i, last.i), {
              metric: 'fittedRise',
              value: round6(rise),
              threshold: round6(threshold),
              r2: round6(fit.r2),
              slope: round6(fit.slope),
              steps: run.length,
              median: round6(medianCost),
            }, runCost)
          }
        }
        run = []
      }
      for (let index = 1; index < priced.length; index += 1) {
        if (priced[index].i !== priced[index - 1].i + 1) flush()
        run.push(priced[index])
      }
      flush()
    }
  }

  // retry-storm — a Step fighting retries, or a Turn full of retried Steps.
  {
    const values = thresholds('retry-storm')
    for (const entry of steps) {
      if ((entry.node.retries ?? 0) < values.stepRetries) continue
      report('retry-storm', {
        ...values,
        margin: countMargin(entry.node.retries, values.stepRetries, values.reference),
        sample: steps.length,
      }, refsOf(entry.i), {
        metric: 'retries',
        value: entry.node.retries,
        threshold: values.stepRetries,
        cost: round6(entry.node.cost),
      }, entry.node.cost ?? 0)
    }
    for (const turn of turnsOf(steps)) {
      const retried = turn.entries.filter((entry) => (entry.node.retries ?? 0) > 0)
      if (retried.length < values.turnRetriedSteps) continue
      const cost = retried.reduce((total, entry) => total + entry.node.cost, 0)
      report('retry-storm', {
        ...values,
        margin: countMargin(retried.length, values.turnRetriedSteps, values.reference * values.turnRetriedSteps / values.stepRetries),
        sample: steps.length,
      }, refsOf(turn.entries[0].i, turn.entries[turn.entries.length - 1].i), {
        metric: 'retriedSteps',
        value: retried.length,
        threshold: values.turnRetriedSteps,
        turn: turn.turn,
        cost: round6(cost),
      }, cost)
    }
  }

  // cache-miss — the context resent instead of reused, after a cache was in use.
  {
    const values = thresholds('cache-miss')
    const firstReuse = sampled ? used.findIndex(({ node }) => (node.buckets?.cacheRead ?? 0) > 0) : -1
    if (firstReuse >= 0) {
      let run = []
      const flush = () => {
        if (run.length >= values.minRun) {
          const first = run[0]
          const last = run[run.length - 1]
          const uncached = run.reduce((total, entry) => total + (entry.node.buckets?.uncachedInput ?? 0), 0)
          const input = run.reduce((total, entry) => total + inputTokensOf(entry.node), 0)
          const runCost = run.reduce((total, entry) => total + (entry.node.cost ?? 0), 0)
          report('cache-miss', {
            ...values, margin: countMargin(run.length, values.minRun, values.reference), sample: used.length,
          }, refsOf(first.i, last.i), {
            metric: 'uncachedShare',
            value: input > 0 ? round6(uncached / input) : 0,
            threshold: values.uncachedShare,
            steps: run.length,
            uncachedInput: uncached,
          }, runCost)
        }
        run = []
      }
      for (let index = firstReuse; index < used.length; index += 1) {
        const entry = used[index]
        const input = inputTokensOf(entry.node)
        const reuse = entry.node.buckets?.cacheRead ?? 0
        const misses = input > 0 && (entry.node.buckets?.uncachedInput ?? 0) / input >= values.uncachedShare
          && reuse / input <= values.cacheReadShare
        if (misses && (run.length === 0 || entry.i === run[run.length - 1].i + 1)) run.push(entry)
        else {
          flush()
          if (misses) run.push(entry)
        }
      }
      flush()
    }
  }

  // tool-output-inflation — a large tool result the next Step pays for as input.
  {
    const values = thresholds('tool-output-inflation')
    const pairs = sampled ? used : []
    for (let index = 0; index + 1 < pairs.length; index += 1) {
      const before = pairs[index]
      const after = pairs[index + 1]
      if (after.i !== before.i + 1) continue
      if ((before.node.calls ?? []).length === 0) continue
      const delta = inputTokensOf(after.node) - inputTokensOf(before.node)
      if (delta < values.minDelta) continue
      report('tool-output-inflation', {
        ...values, margin: ratioMargin(delta, values.minDelta, values.reference), sample: used.length,
      }, refsOf(before.i, after.i), {
        metric: 'inputDelta',
        value: delta,
        threshold: values.minDelta,
        tools: (before.node.calls ?? []).map((call) => call.name),
        before: inputTokensOf(before.node),
        after: inputTokensOf(after.node),
      }, after.node.cost ?? 0)
    }
  }

  // post-compaction-spike — what the compaction cost, and what it cost the next Step.
  {
    const values = thresholds('post-compaction-spike')
    if (medianCost > 0) {
      let cursor = 0
      for (const { i, node } of compactions) {
        while (cursor < steps.length && steps[cursor].i < i) cursor += 1
        const next = steps[cursor]
        if (next === undefined || next.node.hasUsage !== true) continue
        // An Unpriced Step has no rebuild cost to compare: the compaction is judged on
        // its own bill, and the rebuild is reported as unknown rather than as zero.
        const unpricedAnchor = next.node.unpriced === true
        const bill = node.cost / medianCost
        const rebuild = unpricedAnchor ? null : next.node.cost / medianCost
        const strongest = Math.max(bill, rebuild ?? 0)
        if (strongest <= values.rebuildRatio) continue
        report('post-compaction-spike', {
          ...values, margin: ratioMargin(strongest, values.rebuildRatio, values.reference), sample: priced.length,
        }, refsOf(i, next.i), {
          metric: 'costVsMedian',
          value: round6(strongest),
          threshold: values.rebuildRatio,
          compactionCost: round6(node.cost),
          rebuild: rebuild === null ? null : round6(rebuild),
          shadowedTokenCount: node.compaction?.shadowedTokenCount ?? 0,
          median: round6(medianCost),
        }, (node.cost ?? 0) + (next.node.cost ?? 0))
      }
    }
  }

  // tariff-attributable — money the tariff window added, not the work.
  {
    const values = thresholds('tariff-attributable')
    let delta = 0
    const affected = []
    for (const entry of steps) {
      const gone = Math.max(0, (entry.node.cost ?? 0) - (entry.node.offPeak?.cost ?? 0))
      if (gone <= 0) continue
      delta += gone
      affected.push(entry.i)
    }
    if (affected.length > 0 && totalCost > 0) {
      const share = delta / totalCost
      if (share > values.share) {
        report('tariff-attributable', {
          ...values, margin: absoluteMargin(share, values.share, values.reference), sample: priced.length,
        }, refsOf(affected[0], affected[affected.length - 1]), {
          metric: 'offPeakDeltaShare',
          value: round6(share),
          threshold: values.share,
          delta: round6(delta),
          total: round6(totalCost),
          steps: affected.length,
        }, delta)
      }
    }
  }

  // pricing-gap — the totals understate reality because a model has no rate.
  {
    const values = thresholds('pricing-gap')
    const unpriced = steps.filter(({ node }) => node.unpriced === true)
    if (unpriced.length > 0) {
      const unpricedTokens = unpriced.reduce((total, entry) => total + tokensOf(entry.node), 0)
      const allTokens = steps.reduce((total, entry) => total + tokensOf(entry.node), 0)
      const share = allTokens > 0 ? unpricedTokens / allTokens : 1
      report('pricing-gap', {
        ...values, margin: clamp01(0.5 + share), sample: steps.length,
      }, refsOf(unpriced[0].i, unpriced[unpriced.length - 1].i), {
        metric: 'unpricedShare',
        value: round6(share),
        threshold: 0,
        steps: unpriced.length,
        unpricedTokens,
        totalTokens: allTokens,
      }, 0)
    }
  }

  // expensive-subtree — a subtree the reader asked for outweighing the session.
  {
    const values = thresholds('expensive-subtree')
    const subtreeCost = options.subtree?.cost ?? 0
    if (subtreeCost > 0 && totalCost > 0) {
      const share = subtreeCost / totalCost
      if (share > values.share) {
        const spawns = steps.filter(({ node }) => (node.children ?? []).length > 0)
        const from = spawns.length > 0 ? spawns[0].i : (steps[0]?.i ?? 0)
        const to = spawns.length > 0 ? spawns[spawns.length - 1].i : (steps[steps.length - 1]?.i ?? from)
        report('expensive-subtree', {
          ...values, margin: absoluteMargin(share, values.share, values.reference), sample: steps.length,
        }, refsOf(from, to), {
          metric: 'subtreeShare',
          value: round6(share),
          threshold: values.share,
          subtreeCost: round6(subtreeCost),
          sessionCost: round6(totalCost),
          // The Steps that spawned the subtree, not the sessions in it: the sessions are
          // counted where they are read, on the subtree reading itself.
          spawningSteps: spawns.length,
        }, subtreeCost)
      }
    }
  }

  return findings.sort(compareFindings)
}

/**
 * The order Findings are read in: `severity × confidence`, then the money blamed, then the
 * position in the series, then the kind.
 *
 * The chart, the list and the crowding cap all use this one order, so exporting it keeps the
 * rule testable on its own instead of only through whichever fixtures happen to tie.
 */
export function compareFindings(a, b) {
  const left = SEVERITY_WEIGHT[b.severity] * b.confidence - SEVERITY_WEIGHT[a.severity] * a.confidence
  if (left !== 0) return left
  const share = (b.evidence?.share ?? 0) - (a.evidence?.share ?? 0)
  if (share !== 0) return share
  if (a.refs.from !== b.refs.from) return a.refs.from - b.refs.from
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0
}

/** The Steps of one Turn, in series order. */
function turnsOf(steps) {
  const turns = []
  for (const entry of steps) {
    const last = turns[turns.length - 1]
    if (last === undefined || last.turn !== entry.node.turn) turns.push({ turn: entry.node.turn, entries: [entry] })
    else last.entries.push(entry)
  }
  return turns
}

/** Least squares of `values` against their own position, with the fit's R². */
function linearFit(values) {
  const count = values.length
  if (count < 2) return { slope: 0, intercept: values[0] ?? 0, r2: 0 }
  const meanX = (count - 1) / 2
  const meanY = values.reduce((total, value) => total + value, 0) / count
  let covariance = 0
  let varianceX = 0
  for (let index = 0; index < count; index += 1) {
    covariance += (index - meanX) * (values[index] - meanY)
    varianceX += (index - meanX) ** 2
  }
  const slope = varianceX === 0 ? 0 : covariance / varianceX
  const intercept = meanY - slope * meanX
  let residual = 0
  let total = 0
  for (let index = 0; index < count; index += 1) {
    residual += (values[index] - (intercept + slope * index)) ** 2
    total += (values[index] - meanY) ** 2
  }
  return { slope, intercept, r2: total === 0 ? 1 : 1 - residual / total }
}
