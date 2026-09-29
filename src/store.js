/**
 * On-disk state of the plugin: balance samples and the user's manual overrides.
 *
 * Layout under the DeepSeek Harness home (`$DSH_HOME/dsh-balance/`):
 *
 *   samples.ndjson  one balance sample per line, appended on every successful
 *                   fetch; append-only so a crash costs at most a torn tail line
 *   state.json      manual per-day overrides and the account currency the ledger
 *                   is read in
 *
 * Writes to `state.json` go through a same-directory temp file plus rename, so a
 * reader never sees a half-written document; samples are appended, which is
 * atomic enough for a single writer. Both are written concurrently by design —
 * the browser half heartbeats on every poll while a settings write awaits its own
 * — so the temp name is unique per write and the mutations of the sample log run
 * one at a time.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { compactSamples, parseSamples, serializeSamples } from './history.js'

/** File name of the append-only sample log. */
const SAMPLES_FILE = 'samples.ndjson'

/** File name of the JSON state document. */
const STATE_FILE = 'state.json'

/** How long full-resolution samples are kept before hourly thinning (days). */
const DEFAULT_KEEP_DAYS = 120

/**
 * How many samples the Host keeps in memory, and therefore how many it is willing
 * to read out of a log: the cap on the loaded list and the trim on every appended
 * sample have to be the same number, or one of them would be pointless.
 *
 * Roughly a year at the default 5 minute cadence, and — for the thinned older
 * part — a sample per hour for two decades.
 */
export const MAX_SAMPLES = 200_000

/**
 * Monotonic counter that makes every temp file name unique inside this process.
 *
 * The pid already separates two processes; what was missing was the write inside
 * one process. Two concurrent writes shared `${path}.${pid}.tmp`, so the first
 * rename moved the temp away and the second failed `ENOENT` — the document it
 * carried was silently lost while its caller was told the write had landed.
 */
let tempCounter = 0

/** The queue every mutation of the sample log runs on, in order. */
let samplesQueue = Promise.resolve()

/**
 * Run one sample-log mutation after the ones already queued.
 *
 * Compaction reads the whole log and rewrites it, so an append landing in between
 * would be swallowed by that rewrite; one chained promise is all a single-writer
 * plugin needs. Both the stored chain and the returned promise matter: the caller
 * sees the real error, while the chain stays clean so the next mutation is never
 * chained onto a rejection.
 *
 * @param job - the mutation to run.
 * @returns what the job resolved with.
 */
function enqueueSampleJob(job) {
  const run = samplesQueue.then(job, job)
  samplesQueue = run.then(() => undefined, () => undefined)
  return run
}

/** Read a text file, returning `fallback` when it does not exist yet. */
async function readTextIfPresent(path, fallback = '') {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return fallback
    throw error
  }
}

/**
 * Read the sample log and rewrite it when thinning actually dropped samples.
 *
 * @param dir - the plugin's state directory.
 * @param options.keepDays - full-resolution retention window.
 * @param options.maxSamples - how many of the newest samples to materialise
 * (default {@link MAX_SAMPLES}); the head of a longer log is dropped, on disk as
 * well as in memory, because a restart would drop it anyway.
 * @param options.zone - the ledger's day boundary; the thinned hours are its clock hours.
 * Thinning cannot be undone, so every caller has to pass the same zone: the ledger's,
 * not the host's, or the two passes would bucket the old samples differently.
 * @returns the retained samples ascending by time.
 */
export function readSamplesCompacting(dir, options = {}) {
  return enqueueSampleJob(async () => {
    const text = await readTextIfPresent(join(dir, SAMPLES_FILE))
    const all = parseSamples(text, { limit: options.maxSamples ?? MAX_SAMPLES })
    const kept = compactSamples(all, { keepDays: options.keepDays ?? DEFAULT_KEEP_DAYS, zone: options.zone })
    if (kept.length !== all.length) {
      try {
        await writeSamples(dir, kept)
      } catch {
        /* a failed compaction must not stop the plugin from reading its history */
      }
    }
    return kept
  })
}

/**
 * Append one sample to the log.
 *
 * @param dir - the plugin's state directory.
 * @param sample - `{ t, currency, total, granted, toppedUp }`.
 * @returns when the line is on disk.
 */
export function appendSample(dir, sample) {
  return enqueueSampleJob(async () => {
    await mkdir(dir, { recursive: true })
    await appendFile(join(dir, SAMPLES_FILE), `${JSON.stringify(sample)}\n`, 'utf8')
  })
}

/**
 * Replace the whole sample log, e.g. after retention thinning.
 *
 * @param dir - the plugin's state directory.
 * @param samples - the samples to persist.
 */
async function writeSamples(dir, samples) {
  await writeAtomic(join(dir, SAMPLES_FILE), serializeSamples(samples))
}

/**
 * Read the JSON state document.
 *
 * @param dir - the plugin's state directory.
 * @returns the stored object, or an empty object when absent or damaged.
 */
export async function readState(dir) {
  const text = await readTextIfPresent(join(dir, STATE_FILE))
  if (text.trim() === '') return {}
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/**
 * Replace the JSON state document atomically.
 *
 * @param dir - the plugin's state directory.
 * @param state - the document to persist.
 */
export async function writeState(dir, state) {
  await writeAtomic(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
}

/** Write a file through a temp sibling plus rename, so readers never see a partial document. */
async function writeAtomic(path, data) {
  const temp = `${path}.${process.pid}.${tempCounter++}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, data, 'utf8')
  await rename(temp, path)
}
