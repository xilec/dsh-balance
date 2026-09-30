/**
 * Release notes draft for dsh-balance.
 *
 * The repository keeps no changelog: release notes live in the GitHub Release
 * and nowhere else. That is fine as long as the text of a release can be
 * assembled without a human re-reading the whole history, and the history
 * already contains the prose in a structured form — every shipped change was
 * archived under `openspec/changes/archive/<YYYY-MM-DD>-<name>/` with a
 * `proposal.md` holding a `## Why` paragraph and a `## What Changes` bullet
 * list. This script turns those proposals plus the remaining commits of the
 * range into a markdown draft in `tmp/`, which the maintainer edits and
 * publishes with `scripts/release.mjs publish`.
 *
 * The output is a *draft*. Nothing here reaches GitHub: the script writes a
 * file and prints its path, and the header of that file says so.
 *
 * The range is `lastTag..HEAD` (design D3). With no tag at all — the state
 * before the first release — the range is the whole history, so the first
 * release notes cover 0.1.0 too. The range is printed and written into the
 * draft header, because notes covering the wrong commits are the failure mode
 * that costs the most to notice.
 *
 * Everything below the `main()` guard is pure and takes strings, so
 * `test/release.test.js` needs no repository to exercise it.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Where the archived changes live, relative to the repository root. */
const ARCHIVE_DIR = 'openspec/changes/archive'

/** Conventional-commit prefixes stripped from the commit subjects. */
const PREFIX = /^(?:feat|fix|docs|chore|refactor|test|perf|build|ci|revert)(?:\([^)]*\))?!?:\s*/

/** Width the draft's prose is wrapped to. */
const WIDTH = 80

/** Run a command and return its stdout, trimmed. Throws with git's own message. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The same, but a command that fails or is absent yields null instead of throwing. */
function tryGit(...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

/** The repository root, so the pathspecs and the file reads work from anywhere. */
function repoRoot() {
  return git('rev-parse', '--show-toplevel')
}

/** A single version string, or null when it is not `x.y.z`. */
export function parseVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : null
}

/** Standard semver comparison of two `x.y.z` strings: -1, 0 or 1. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  const x = left.split('.').map(Number)
  const y = right.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  }
  return 0
}

/**
 * A readable title for an archive directory.
 *
 * `2026-09-29-cost-anomaly-indicators` → `Cost anomaly indicators`: the date
 * prefix carries ordering, not meaning, and the notes already have a date.
 */
export function humanizeChangeName(dirName) {
  const bare = dirName.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  const words = bare.split('-').filter(Boolean)
  if (words.length === 0) return dirName
  return words[0][0].toUpperCase() + words[0].slice(1) + (words.length > 1 ? ` ${words.slice(1).join(' ')}` : '')
}

/** The body of a `## <heading>` section of a proposal, as an array of lines. */
function section(markdown, heading) {
  const lines = String(markdown).split('\n')
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`)
  if (start === -1) return []
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
}

/** Collapse a paragraph's line breaks into spaces, dropping comments. */
function paragraph(lines) {
  const kept = []
  let inComment = false
  for (const line of lines) {
    const text = line.trim()
    if (text.startsWith('<!--')) inComment = !text.includes('-->')
    if (inComment) continue
    if (text === '') {
      if (kept.length > 0) break
      continue
    }
    kept.push(text)
  }
  return kept.join(' ')
}

/** The proposal's `## Why` prose: its first real paragraph, unwrapped. */
export function extractWhy(markdown) {
  return paragraph(section(markdown, 'Why'))
}

/**
 * The proposal's `## What Changes` bullets, verbatim.
 *
 * Nested bullets and their continuation lines are kept with their indentation,
 * because a proposal's bullets are already a readable list; only the blank
 * lines and the heading that follows the section are dropped.
 */
export function extractWhatChanges(markdown) {
  const bullets = []
  let inBullet = false
  for (const line of section(markdown, 'What Changes')) {
    if (/^\s*-\s+/.test(line)) {
      bullets.push(line.replace(/\s+$/, ''))
      inBullet = true
      continue
    }
    if (inBullet && /^\s+\S/.test(line)) {
      bullets.push(line.replace(/\s+$/, ''))
      continue
    }
    if (line.trim() !== '') inBullet = false
  }
  return bullets
}

/** Hard-wrap prose at `width` columns on word boundaries. */
export function wrap(text, width = WIDTH) {
  const words = String(text).split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const lines = []
  let line = words[0]
  for (const word of words.slice(1)) {
    if (line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else line += ` ${word}`
  }
  lines.push(line)
  return lines.join('\n')
}

/** Strip a conventional-commit prefix and leave the rest of the subject. */
export function subjectOf(commitSubject) {
  return String(commitSubject).replace(PREFIX, '').trim()
}

/** Whether a change's bullet list marks anything as breaking. */
const isBreaking = (bullets) => bullets.some((bullet) => bullet.includes('**BREAKING**'))

/**
 * The release notes draft.
 *
 * Shape (design D5): a header naming the version, the date and the range; one
 * `### <Title>` section per archived change, oldest first, each carrying the
 * proposal's `Why` prose and its `What Changes` bullets; then `## Other changes`
 * with the subjects of the commits in the range that touched no archive
 * directory. A commit that archived a change is not repeated in that list.
 *
 * @param input.version - the version being released.
 * @param input.date - the release date, `YYYY-MM-DD`.
 * @param input.range - the git range the notes cover, for the reader's benefit.
 * @param input.changes - `{name, why, bullets}` per archived change, in order.
 * @param input.commits - commit subjects; their conventional prefixes are stripped here.
 * @returns the markdown of the draft.
 */
export function renderNotes({ version, date, range, changes, commits }) {
  const out = [
    `<!-- DRAFT release notes for dsh-balance ${version} — edit before publishing. -->`,
    '',
    `# dsh-balance ${version}`,
    '',
    `Released ${date}. Covers \`${range}\`.`,
  ]
  if (changes.length === 0 && commits.length === 0) {
    out.push('', 'No changes recorded in this range.')
    return `${out.join('\n')}\n`
  }
  if (changes.length > 0) {
    out.push('', '## What changed', '')
    for (const change of changes) {
      out.push(`### ${humanizeChangeName(change.name)}`, '')
      if (isBreaking(change.bullets ?? [])) out.push('**Breaking change.**', '')
      if (change.why) out.push(wrap(change.why), '')
      if (change.bullets?.length) out.push(...change.bullets, '')
    }
  }
  if (commits.length > 0) {
    out.push('## Other changes', '')
    for (const commit of commits) out.push(`- ${subjectOf(commit)}`)
    out.push('')
  }
  return `${out.join('\n')}\n`
}

/**
 * The last tag, or null when the repository has none.
 *
 * A repository with no tags and a git that failed are told apart: a shallow
 * clone, or one cloned without tags, would otherwise be reported as "the whole
 * history" with a confidence the notes do not deserve. `warn` carries the
 * complaint to whoever is reading the output.
 */
export function lastTag({ warn = null } = {}) {
  const described = tryGit('describe', '--tags', '--abbrev=0')
  if (described !== null) return described === '' ? null : described
  const listed = tryGit('tag', '--list')
  if (listed === null) {
    if (warn) warn('git could not be read, so the range below may be wrong')
    return null
  }
  if (listed === '' && warn) warn('this clone carries no tags, so the range below is the whole history')
  return null
}

/**
 * The range the next release covers, and a label for it.
 *
 * With a tag it is `lastTag..HEAD`; without one there is no revision that
 * starts the range — the root commit has no parent — so git is given `HEAD` and
 * the whole history, and the label says so. The label is what the reader of the
 * draft sees, so the first release cannot look like it covered a range.
 */
export function releaseRange({ warn = null } = {}) {
  const tag = lastTag({ warn })
  if (tag) return { gitRange: `${tag}..HEAD`, label: `${tag}..HEAD`, tag }
  return { gitRange: 'HEAD', label: 'the whole history (no tag yet)', tag: null }
}

/**
 * Archive directory names touched anywhere in the range, oldest first.
 *
 * Found through `git log --name-only` rather than by comparing the date in the
 * directory name with the last tag's date (design D4): a change archived in a
 * commit dated after its directory name — a rebase, an archive written after
 * midnight — and a change whose archived files were only touched afterwards are
 * both in range, and both are the release's business.
 *
 * The names come back sorted by name; {@link buildDraft} is what orders them by the
 * commit that added each one.
 */
export function archivesInRange(gitRange) {
  const names = new Set()
  for (const line of gitLogNames(gitRange, 'AM', ARCHIVE_DIR).split('\n')) {
    const match = line.trim().match(new RegExp(`^${ARCHIVE_DIR}/([^/]+)/`))
    if (match) names.add(match[1])
  }
  return [...names].sort()
}

/**
 * The order the changes were archived in, read from the whole history.
 *
 * The directory name starts with a date, and several changes are archived on
 * the same day, so the name cannot order them; the commit that added the
 * directory can, and that is the order they were built in (design D5). Read
 * from all of history rather than from the range, so a change archived in an
 * earlier release and touched in this one still lands in the right place.
 *
 * `git log` walks history backwards, so index 0 is the *newest* change; the caller
 * sorts on this map descending to get the oldest-first order the notes use.
 */
export function archiveOrder() {
  const order = new Map()
  gitLogNames('HEAD', 'AM', ARCHIVE_DIR)
    .split('\n')
    .map((line) => line.trim().match(new RegExp(`^${ARCHIVE_DIR}/([^/]+)/`)))
    .filter((match) => match !== null)
    .forEach((match) => {
      if (!order.has(match[1])) order.set(match[1], order.size)
    })
  return order
}

/** The paths under `path` that a diff filter reports, in commit order. */
function gitLogNames(gitRange, diffFilter, path) {
  return git('log', gitRange, '--name-only', `-M`, `--diff-filter=${diffFilter}`, '--format=', '--', `:/${path}`)
}

/**
 * Commit subjects in the range that touched no OpenSpec planning file — the
 * work a reader of the release cares about, with the archiving of a change
 * itself left to that change's section above.
 */
export function commitsInRange(gitRange) {
  const output = git('log', gitRange, '--no-merges', '--format=%s', '--', ':/', ':(exclude)openspec')
  return output.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** The change's version, read from the manifest rather than from a constant. */
function currentVersion() {
  const manifest = JSON.parse(readFileSync(join(repoRoot(), 'package.json'), 'utf8'))
  const version = parseVersion(manifest.version)
  if (version === null) throw new Error(`package.json carries no x.y.z version: ${manifest.version}`)
  return version
}

/** A draft assembled from the repository as it stands. */
export function buildDraft({ version, date }) {
  const { gitRange, label } = releaseRange({ warn: (message) => process.stderr.write(`release-notes: ${message}\n`) })
  const root = repoRoot()
  const order = archiveOrder()
  // `archiveOrder` indexes from `git log`, which walks history backwards, so index 0 is
  // the *newest* change. Sorting on it descending is what puts the oldest first, which is
  // the order the sections are documented in and the one a release covering the whole
  // history reads as: the change the release is about comes first, not the last amendment
  // to it.
  const changes = archivesInRange(gitRange)
    .sort((a, b) => (order.get(b) ?? -1) - (order.get(a) ?? -1))
  const sections = []
  for (const name of changes) {
    const proposal = join(root, ARCHIVE_DIR, name, 'proposal.md')
    let markdown
    try {
      markdown = readFileSync(proposal, 'utf8')
    } catch {
      continue
    }
    sections.push({ name, why: extractWhy(markdown), bullets: extractWhatChanges(markdown) })
  }
  const commits = commitsInRange(gitRange)
  return {
    version,
    date,
    label,
    changes: sections,
    commits,
    notes: renderNotes({ version, date, range: label, changes: sections, commits }),
  }
}

/** `--out <file>` / `--stdout` / `--version <v>`, nothing else accepted. */
function parseArgs(argv) {
  const options = { out: null, stdout: false, version: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--stdout') options.stdout = true
    else if (arg === '--out') options.out = argv[++i] ?? fail('--out needs a file')
    else if (arg === '--version') options.version = argv[++i] ?? fail('--version needs a value')
    else return fail(`unknown argument: ${arg}`)
  }
  return options
}

function fail(message) {
  process.stderr.write(`release-notes: ${message}\n`)
  process.exit(1)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const version = options.version ?? currentVersion()
  if (parseVersion(version) === null) fail(`not a version: ${version}`)
  const draft = buildDraft({ version, date: new Date().toISOString().slice(0, 10) })
  if (options.stdout) {
    process.stdout.write(draft.notes)
  } else {
    const target = options.out === null ? join(repoRoot(), 'tmp', `release-notes-${version}.md`) : resolve(options.out)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, draft.notes)
    process.stdout.write(`${target}\n`)
  }
  const names = draft.changes.length === 0 ? 'none' : draft.changes.map((change) => humanizeChangeName(change.name)).join(', ')
  // The summary goes to stderr, always: with `--stdout` the markdown is being
  // piped somewhere that would publish the summary with it.
  process.stderr.write([
    `version ${version}, range ${draft.label}`,
    `archived changes: ${names}`,
    `other commits: ${draft.commits.length}`,
    'the file is a draft — read it, edit it, then publish it with release:publish',
  ].join('\n') + '\n')
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) main()
