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
 * atomic enough for a single writer.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { compactSamples, parseSamples, serializeSamples } from './history.js'

/** File name of the append-only sample log. */
export const SAMPLES_FILE = 'samples.ndjson'

/** File name of the JSON state document. */
export const STATE_FILE = 'state.json'

/** How long full-resolution samples are kept before hourly thinning (days). */
export const DEFAULT_KEEP_DAYS = 120

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
 * Read and thin the sample log.
 *
 * @param dir - the plugin's state directory.
 * @param options.keepDays - full-resolution retention window.
 * @returns samples ascending by time; damaged lines are dropped.
 */
export async function readSamples(dir, options = {}) {
  const text = await readTextIfPresent(join(dir, SAMPLES_FILE))
  const samples = parseSamples(text)
  return compactSamples(samples, { keepDays: options.keepDays ?? DEFAULT_KEEP_DAYS })
}

/**
 * Read the sample log and rewrite it when thinning actually dropped samples.
 *
 * @param dir - the plugin's state directory.
 * @param options.keepDays - full-resolution retention window.
 * @returns the retained samples ascending by time.
 */
export async function readSamplesCompacting(dir, options = {}) {
  const text = await readTextIfPresent(join(dir, SAMPLES_FILE))
  const all = parseSamples(text)
  const kept = compactSamples(all, { keepDays: options.keepDays ?? DEFAULT_KEEP_DAYS })
  if (kept.length !== all.length) {
    try {
      await writeSamples(dir, kept)
    } catch {
      /* a failed compaction must not stop the plugin from reading its history */
    }
  }
  return kept
}

/**
 * Append one sample to the log.
 *
 * @param dir - the plugin's state directory.
 * @param sample - `{ t, currency, total, granted, toppedUp }`.
 */
export async function appendSample(dir, sample) {
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, SAMPLES_FILE), `${JSON.stringify(sample)}\n`, 'utf8')
}

/**
 * Replace the whole sample log, e.g. after retention thinning.
 *
 * @param dir - the plugin's state directory.
 * @param samples - the samples to persist.
 */
export async function writeSamples(dir, samples) {
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
  const temp = `${path}.${process.pid}.tmp`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(temp, data, 'utf8')
  await rename(temp, path)
}
