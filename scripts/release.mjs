/**
 * Cutting a dsh-balance release.
 *
 * Three subcommands, one job each, in the order they are meant to be run:
 *
 *   check [version]    is the repository ready to be released as <version>?
 *   prepare <version>  write that version into the three places that carry it,
 *                      then run the same lint and tests CI runs
 *   publish <version>  tag the reviewed commit and open the GitHub Release
 *
 * The version of the plugin is written in three files — `package.json`,
 * `src/index.js` and `client/client.js` — because the panel footer reports the
 * Host and client versions separately. A release that bumps only the manifest
 * produces a plugin that claims one version and behaves as another, so every
 * step here reads all three and refuses to act when they disagree.
 *
 * Nothing in this file commits, pushes or publishes by itself. `prepare` stops
 * after printing a draft commit message, and `publish` needs both a reviewed
 * notes file and an explicit `--yes`: the review happens between the two, in a
 * conversation, and a script cannot stand in for it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { compareVersions, lastTag, parseVersion, releaseRange } from './release-notes.mjs'

/** The files that carry the version, and the one line in each that holds it. */
export const VERSION_PLACES = [
  { file: 'package.json', pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/, group: 2 },
  { file: 'src/index.js', pattern: /const VERSION = '(\d+\.\d+\.\d+)'/, group: 1 },
  { file: 'client/client.js', pattern: /const VERSION = '(\d+\.\d+\.\d+)'/, group: 1 },
]

/** Run a command, return its trimmed stdout, and throw with its stderr on failure. */
function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** The same, but a command that fails or is absent yields null instead of throwing. */
function tryRun(command, args) {
  try {
    return run(command, args)
  } catch {
    return null
  }
}

/**
 * The `owner/name` a GitHub remote points at, or null when the URL is not one.
 *
 * Both remote forms count: `git@github.com:owner/name.git` and
 * `https://github.com/owner/name`.
 */
export function slugFromOrigin(url) {
  const match = String(url).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  return match === null ? null : `${match[1]}/${match[2]}`
}

/**
 * The `owner/name` the release goes to: `GH_REPO` when set, otherwise `origin`.
 *
 * Passed to `gh` explicitly rather than left to the working directory, so a
 * release cannot land in a fork because the script ran in the wrong checkout.
 */
export function repoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO
  return slugFromOrigin(tryRun('git', ['remote', 'get-url', 'origin']) ?? '')
}

/** The repository root, so every path here is absolute regardless of the cwd. */
function repoRoot() {
  return run('git', ['rev-parse', '--show-toplevel'])
}

/** Whether a path outside `tmp/` carries uncommitted changes. */
function dirtyPaths() {
  const status = run('git', ['status', '--porcelain'])
  return status
    .split('\n')
    .map((line) => line.replace(/^.{1,2}\s+/, '').trim())
    .filter((path) => path !== '' && !path.startsWith('tmp/'))
}

/** A one-line reason to refuse, or null when the repository may be released. */
export function checkRefusals({ current, lastTag: tag, tagExists, dirty }) {
  const problems = []
  if (current === null) problems.push('the three version places do not all carry the same x.y.z version')
  if (dirty.length > 0) problems.push(`uncommitted changes outside tmp/: ${dirty.join(', ')}`)
  if (tagExists) problems.push(`the tag v${current} already exists`)
  if (current !== null) {
    const order = compareVersions(current, tag === null ? '0.0.0' : tag.replace(/^v/, ''))
    if (order !== null && order <= 0) problems.push(`${current} is not ahead of the last tag ${tag}`)
  }
  return problems
}

/**
 * Everything a release step needs to know, read from the repository.
 *
 * `versions` is the version each place carries, keyed by file, so a mismatch is
 * reported as such instead of being silently normalized.
 */
export function inspect(root) {
  const versions = {}
  for (const place of VERSION_PLACES) {
    const text = readFileSync(join(root, place.file), 'utf8')
    const match = text.match(place.pattern)
    versions[place.file] = match === null ? null : match[place.group]
  }
  const found = [...new Set(Object.values(versions))]
  const tag = lastTag()
  const current = found.length === 1 && found[0] !== null ? found[0] : null
  const manifestVersion = versions['package.json']
  return {
    versions,
    current,
    tag,
    tagExists: manifestVersion !== null && run('git', ['tag', '--list', `v${manifestVersion}`]) !== '',
    dirty: dirtyPaths(),
  }
}

/**
 * Write `version` into one file's version line.
 *
 * Refuses when the line is not there exactly once: a version written twice in
 * one file is a fact this script would have to guess about, and guessing is how
 * a release ends up half-done.
 */
export function rewriteVersionIn(text, version, place) {
  const counted = text.match(new RegExp(place.pattern.source, 'g')) ?? []
  if (counted.length !== 1) {
    throw new Error(`${place.file}: expected one version line, found ${counted.length}`)
  }
  const match = text.match(place.pattern)
  const at = match.index + match[0].lastIndexOf(match[place.group])
  return text.slice(0, at) + version + text.slice(at + match[place.group].length)
}

/**
 * The arguments `gh release create` is called with.
 *
 * Kept apart from the printing and the call so a test can pin the exact list: a
 * `gh gh …` slipped in here once, and the printed command read perfectly right
 * while the executed one did not.
 */
export function ghReleaseArgs({ version, slug, title, notes, sha }) {
  return ['release', 'create', `v${version}`, '--repo', slug, '--title', title, '--notes-file', notes, '--target', sha]
}

/**
 * Report the state on stdout and return the reasons to refuse, if any.
 *
 * The requested version is deliberately not judged here: `check` only answers
 * "is the tree releasable", and whether a version is ahead of the current one
 * (`prepare`) or equal to it (`publish`) is a question each subcommand asks for
 * itself.
 */
function report(state) {
  const { label, tag } = releaseRange()
  const lines = [
    `version: ${state.current ?? `mismatched (${JSON.stringify(state.versions)})`}`,
    `last tag: ${tag ?? 'none'}`,
    `next release would cover: ${label}`,
  ]
  const problems = checkRefusals({
    current: state.current,
    lastTag: tag,
    tagExists: state.tagExists,
    dirty: state.dirty,
  })
  for (const problem of problems) lines.push(`refusing: ${problem}`)
  process.stdout.write(`${lines.join('\n')}\n`)
  return problems
}

/** The reason `version` cannot be prepared, or null when it can. */
export function notAheadReason(version, current) {
  if (parseVersion(version) === null) return `${version} is not an x.y.z version`
  const order = current === null ? 1 : compareVersions(version, current)
  if (order === null) return `${version} cannot be compared with the current version ${current}`
  if (order <= 0) return `${version} is not ahead of the current version ${current}`
  return null
}

/** The reason `version` cannot be published from this tree, or null when it can. */
export function notCurrentReason(version, current) {
  if (parseVersion(version) === null) return `${version} is not an x.y.z version`
  if (current === null) return 'the three version places do not all carry the same x.y.z version'
  if (version !== current) return `the tree is at ${current}, not ${version} — prepare it first`
  return null
}

function fail(message) {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

/** `--notes <file>` / `--yes` / `--dry-run`, nothing else. */
function parseArgs(argv) {
  const options = { yes: false, dryRun: false, notes: null }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--notes') options.notes = argv[++i] ?? fail('--notes needs a file')
    else rest.push(arg)
  }
  return { options, rest }
}

function check(version) {
  if (version !== null && parseVersion(version) === null) fail(`not a version: ${version}`)
  const state = inspect(repoRoot())
  if (report(state).length > 0) process.exit(1)
  return state
}

function prepare(version) {
  if (version === null) fail('prepare needs a version: npm run release:prepare -- 0.2.0')
  const root = repoRoot()
  const state = inspect(root)
  const behind = notAheadReason(version, state.current)
  if (behind !== null) fail(behind)
  if (report(state).length > 0) fail('nothing was written')
  for (const place of VERSION_PLACES) {
    const file = join(root, place.file)
    writeFileSync(file, rewriteVersionIn(readFileSync(file, 'utf8'), version, place))
  }
  process.stdout.write(`wrote ${version} to ${VERSION_PLACES.map((place) => place.file).join(', ')}\n`)
  for (const script of ['lint', 'test']) {
    try {
      process.stdout.write(`\n$ npm run ${script}\n${run('npm', ['run', script])}\n`)
    } catch (error) {
      fail([
        `npm run ${script} failed, so the version is written but the tree is not releasable:`,
        error.stderr ?? error.message,
        'the lint tools are devDependencies: a kernel-linked development tree has no',
        'node_modules of its own, and CI installs them with `npm ci --ignore-scripts`',
      ].join('\n'))
    }
  }
  process.stdout.write([
    '',
    'lint and tests pass. Suggested commit message:',
    '',
    `  Release ${version}`,
    '',
    'Read it, then:',
    `  git commit -am "Release ${version}"`,
    `  git push`,
    `  npm run release:publish -- ${version} --yes   # after the notes have been reviewed`,
  ].join('\n') + '\n')
}

function publish(version, options) {
  if (version === null) fail('publish needs a version: npm run release:publish -- 0.2.0')
  const root = repoRoot()
  const state = inspect(root)
  const mismatch = notCurrentReason(version, state.current)
  if (mismatch !== null) fail(mismatch)
  if (report(state).length > 0) fail('nothing was tagged')
  const notes = resolve(options.notes ?? join('tmp', `release-notes-${version}.md`))
  let body
  try {
    body = readFileSync(notes, 'utf8')
  } catch {
    fail(`no notes file at ${notes} — write one with: npm run release:notes -- --out ${notes}`)
  }
  const slug = repoSlug()
  if (slug === null) fail('no GitHub repository to publish to: set GH_REPO or add an origin remote')
  const title = `dsh-balance ${version}`
  const args = ghReleaseArgs({ version, slug, title, notes, sha: run('git', ['rev-parse', 'HEAD']) })
  process.stdout.write([
    `repository: ${slug}`,
    `notes: ${notes}`,
    '',
    '--- release notes ---',
    body.trimEnd(),
    '--- end of release notes ---',
    '',
    `$ gh ${args.join(' ')}`,
  ].join('\n') + '\n')
  if (options.dryRun) {
    process.stdout.write('\ndry run: nothing was tagged or published\n')
    return
  }
  if (!options.yes) {
    process.stdout.write('\nrefusing to publish without --yes. Review the notes above first.\n')
    process.exit(1)
  }
  if (tryRun('gh', ['auth', 'status']) === null) fail('gh is not authenticated or not installed — run `gh auth login`')
  run('git', ['tag', `v${version}`, '-m', title])
  try {
    process.stdout.write(`${run('gh', args)}\n`)
  } catch (error) {
    process.stdout.write(`gh failed, the tag v${version} exists; delete it with: git tag -d v${version}\n${error.stderr ?? error.message}\n`)
    process.exit(1)
  }
  process.stdout.write(`\nreleased ${version}: push the tag with \`git push origin v${version}\`\n`)
}

function main() {
  const { options, rest } = parseArgs(process.argv.slice(2))
  const command = rest.shift()
  const version = rest[0] ?? null
  if (command === 'check') check(version)
  else if (command === 'prepare') prepare(version)
  else if (command === 'publish') publish(version, options)
  else fail(`unknown command: ${command ?? '(none given)'} — use check, prepare or publish`)
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) main()
