/**
 * The fixed input of the export golden test.
 *
 * It is shared with the generator that produced the two committed fixtures, so the
 * stream under test and the stream in the fixture can never drift apart by accident:
 * one input, two levels, two files.
 */

const buckets = (uncachedInput, output, cacheRead = 0, cacheWrite = 0) => ({ uncachedInput, cacheRead, cacheWrite, output })

export const SESSION_ID = 'session-17d677cb-628f-4cd3-aeb6-a3c50a84b19f'
export const CHILD_ID = '392960ac-1111-2222-3333-444455556666'
export const GRANDCHILD_ID = '77aa11bb-5555-6666-7777-888899990000'

/** A long answer, so the fixture pins the 2000-character cut and its flag. */
const LONG_ANSWER = `answer ${'x'.repeat(2100)}`

export const exportInput = () => ({
  sessionId: SESSION_ID,
  title: 'Make the cost view tell the truth',
  version: '0.1.0',
  payload: {
    ok: true,
    sessionId: SESSION_ID,
    seq: 12,
    currency: 'CNY',
    // The exact shape the series route serves, so the fixture's meta cannot drift
    // from the wire it is supposed to record.
    rule: {
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      verifiedOn: '2026-08-23',
      holidays: ['2026-10-01', '2026-10-02'],
      rates: [
        { effectiveFrom: Date.UTC(2026, 7, 23), rates: { flash: { cacheHit: 0.07, cacheMiss: 0.44, output: 1.32 } } },
        { effectiveFrom: Date.UTC(2026, 8, 8), rates: { flash: { cacheHit: 0.014, cacheMiss: 0.3, output: 1.2 } } },
      ],
    },
    nodes: [
      {
        turn: 1,
        step: 1,
        tStart: 1000,
        tEnd: 2000,
        ended: true,
        hasUsage: true,
        interrupted: false,
        retries: 1,
        reports: [{
          model: 'deepseek-flash',
          time: 1200,
          buckets: buckets(1e6, 1e5),
          seq: 5,
          cost: 1.9,
          costByBucket: buckets(1, 0.9),
          offPeak: { cost: 0.95, costByBucket: buckets(0.5, 0.45) },
          peak: { cost: 1.9, costByBucket: buckets(1, 0.9) },
        }],
        evicted: [{
          model: 'deepseek-flash',
          time: 1100,
          buckets: buckets(1e6, 0),
          seq: 4,
          cost: 1,
          costByBucket: buckets(1, 0),
          offPeak: { cost: 0.5, costByBucket: buckets(0.5, 0) },
          peak: { cost: 1, costByBucket: buckets(1, 0) },
        }],
        calls: [{ name: 'bash', callId: 'call-1', preview: '{"command":"ls -la"}', time: 1400, seq: 7 }],
        children: [{ id: CHILD_ID, mode: 'continuable', label: 'Survey the tree', createdAt: 2600, seq: 12 }],
      },
      {
        turn: 2,
        step: 3,
        tStart: 4000,
        tEnd: 5000,
        ended: true,
        hasUsage: true,
        interrupted: true,
        retries: 0,
        reports: [{
          model: 'deepseek-reasoner',
          time: 4200,
          buckets: buckets(2e6, 2e5),
          seq: 11,
          cost: 6,
          costByBucket: buckets(2, 4),
          offPeak: { cost: 3, costByBucket: buckets(1, 2) },
          peak: { cost: 6, costByBucket: buckets(2, 4) },
        }],
        evicted: [],
        calls: [],
        children: [],
      },
    ],
  },
  text: [
    { seq: 2, t: 900, turn: 1, step: 1, type: 'user_message', text: 'where did the money go?' },
    {
      seq: 7, t: 1400, turn: 1, step: 1, type: 'tool_call', name: 'bash', callId: 'call-1', arguments: `{"command":"ls -la","padding":"${'y'.repeat(2100)}"}`,
    },
    { seq: 8, t: 1500, turn: 1, step: 1, type: 'tool_result', callId: 'call-1', isError: false, text: 'total 0' },
    { seq: 9, t: 1600, turn: 1, step: 1, type: 'assistant_message', text: LONG_ANSWER },
    { seq: 10, t: 1601, turn: 1, step: 1, type: 'assistant_thinking', text: 'count the calls first' },
  ],
  children: [{
    id: CHILD_ID,
    parentId: SESSION_ID,
    depth: 1,
    label: 'Survey the tree',
    mode: 'continuable',
    payload: {
      ok: true,
      sessionId: CHILD_ID,
      seq: 4,
      currency: 'CNY',
      nodes: [{
        turn: 1,
        step: 1,
        tStart: 2600,
        tEnd: 3000,
        ended: true,
        hasUsage: true,
        interrupted: false,
        retries: 0,
        reports: [{
          model: 'deepseek-flash',
          time: 2800,
          buckets: buckets(5e5, 0),
          seq: 3,
          cost: 0.5,
          costByBucket: buckets(0.5, 0),
          offPeak: { cost: 0.25, costByBucket: buckets(0.25, 0) },
          peak: { cost: 0.5, costByBucket: buckets(0.5, 0) },
        }],
        evicted: [],
        calls: [],
        children: [],
      }],
    },
    text: [{ seq: 4, t: 2900, turn: 1, step: 1, type: 'assistant_message', text: 'the tree is fine' }],
  }, {
    // A grandchild: its catalog fact lives in CHILD_ID's log, so its markers must
    // name that session rather than the exported one.
    id: GRANDCHILD_ID,
    parentId: CHILD_ID,
    depth: 2,
    label: 'Peer deeper',
    mode: 'one-shot',
    payload: {
      ok: true,
      sessionId: GRANDCHILD_ID,
      seq: 2,
      currency: 'CNY',
      nodes: [{
        turn: 1,
        step: 1,
        tStart: 3100,
        tEnd: 3300,
        ended: true,
        hasUsage: true,
        interrupted: false,
        retries: 0,
        reports: [{
          model: 'deepseek-flash',
          time: 3200,
          buckets: buckets(1e5, 0),
          seq: 2,
          cost: 0.1,
          costByBucket: buckets(0.1, 0),
          offPeak: { cost: 0.05, costByBucket: buckets(0.05, 0) },
          peak: { cost: 0.1, costByBucket: buckets(0.1, 0) },
        }],
        evicted: [],
        calls: [],
        children: [],
      }],
    },
    text: [],
  }],
})
