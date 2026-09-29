/**
 * Cutting a dsh-balance release.
 *
 * Three subcommands, one job each, in the order they are meant to be run:
 *
 *   check [version]    is the repository ready to be released as <version>?
 *   prepare <version>  write that version into the files that carry it,
 *                      then run the same lint and tests CI runs
 *   publish <version>  tag the reviewed commit and open the GitHub Release
 *
 * The version of the plugin is written in four files — `package.json`,
 * `package-lock.json`, `src/index.js` and `client/client.js`. The first two keep
 * the manifest npm installs, the last two because the panel footer reports the
 * Host and client versions separately. A release that bumps only some of them
 * produces a tree that claims one version and behaves as another, so every step
 * here reads all of them and refuses to act when they disagree.
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

/**
 * The files that carry the version, and the one line in each that holds it.
 *
 * A file may list more than one pattern, and every one of them has to match
 * exactly once: `package-lock.json` holds the root package's version twice — next
 * to `lockfileVersion` at the top, and in the `packages[""]` entry — and npm keeps
 * the two equal, so a rewrite that moved one and not the other would trade a drift
 * between two files for a drift inside one. Every other `version` in that file
 * belongs to a dependency, which is what the two anchors are for.
 */
export const VERSION_PLACES = [
  { file: 'package.json', patterns: [/"version"\s*:\s*"(\d+\.\d+\.\d+)"/] },
  {
    file: 'package-lock.json',
    patterns: [
      // The root manifest's own version, written by npm next to lockfileVersion.
      /"version"\s*:\s*"(\d+\.\d+\.\d+)"\s*,\s*"lockfileVersion"/,
      // The same version again in the root entry of `packages`; the `name` between
      // them is what says this entry is the project and not a dependency.
      /"packages"\s*:\s*\{\s*""\s*:\s*\{[^{}]*?"name"\s*:\s*"[^"]*",\s*"version"\s*:\s*"(\d+\.\d+\.\d+)"/,
    ],
  },
  { file: 'src/index.js', patterns: [/const VERSION = '(\d+\.\d+\.\d+)'/] },
  { file: 'client/client.js', patterns: [/const VERSION = '(\d+\.\d+\.\d+)'/] },
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

/**
 * The uncommitted paths of a `git status --porcelain` dump, minus `tmp/`.
 *
 * Pure, because the `tmp/` exemption is the one thing keeping a notes draft
 * from blocking a release, and that has to be testable. The status is read with
 * paths relative to the repository root (`-z`, no quoting, no cwd sensitivity),
 * so the `tmp/` test here is the same test a caller from any directory gets.
 */
export function dirtyFromStatus(status) {
  return status
    .split('\0')
    .map((entry) => entry.replace(/^.{1,2}\s+/, '').trim())
    .filter((path) => path !== '' && !path.startsWith('tmp/'))
}

/** Whether a path outside `tmp/` carries uncommitted changes. */
function dirtyPaths(root) {
  return dirtyFromStatus(run('git', ['-C', root, 'status', '--porcelain', '-z']))
}

/**
 * A one-line reason to refuse, or null when the repository may be released.
 *
 * `tagExists` carries the version it was looked up for, so the message names
 * the version that is actually tagged rather than the one the tree happens to
 * carry.
 */
export function checkRefusals({ current, lastTag: tag, tagExists, dirty }) {
  const problems = []
  if (current === null) problems.push('the version files do not all carry the same x.y.z version')
  if (dirty.length > 0) problems.push(`uncommitted changes outside tmp/: ${dirty.join(', ')}`)
  if (tagExists !== null && tagExists !== false) problems.push(`the tag v${tagExists} already exists`)
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
 * reported as such instead of being silently normalized. `tagExists` is the
 * version whose tag exists — the one being released when the caller names it,
 * otherwise the version in the tree, because that is the one a release would
 * otherwise duplicate.
 */
export function inspect(root, requested = null) {
  const versions = {}
  for (const place of VERSION_PLACES) {
    versions[place.file] = oneVersion(placeVersions(readFileSync(join(root, place.file), 'utf8'), place))
  }
  const found = [...new Set(Object.values(versions))]
  const current = found.length === 1 && found[0] !== null ? found[0] : null
  const tag = lastTag()
  const tagged = requested ?? versions['package.json']
  return {
    versions,
    current,
    tag,
    tagExists: tagged !== null && run('git', ['-C', root, 'tag', '--list', `v${tagged}`]) !== '' ? tagged : null,
    dirty: dirtyPaths(root),
  }
}

/**
 * The version each of a place's patterns finds, in order, or null for a pattern
 * that does not match.
 *
 * Every pattern ends on its version, which is what lets {@link rewriteVersionIn}
 * place the new one without reformatting the line around it.
 */
export function placeVersions(text, place) {
  return place.patterns.map((pattern) => {
    const match = text.match(pattern)
    return match === null ? null : match[1]
  })
}

/**
 * The single version a place carries, or null when its patterns disagree or are
 * missing — the two ways a file can carry no usable version at all.
 */
function oneVersion(found) {
  const distinct = new Set(found)
  return distinct.size === 1 && !distinct.has(null) ? found[0] : null
}

/**
 * Write `version` into one file's version lines, one per pattern.
 *
 * Refuses unless every pattern matches exactly once: a version written twice in
 * one file, or a line this script cannot find, is a fact it would have to guess
 * about, and guessing is how a release ends up half-done.
 */
export function rewriteVersionIn(text, version, place) {
  const counted = place.patterns.reduce((sum, pattern) => sum + (text.match(new RegExp(pattern.source, 'g')) ?? []).length, 0)
  if (counted !== place.patterns.length) {
    throw new Error(`${place.file}: expected one version line per pattern (${place.patterns.length}), found ${counted}`)
  }
  return place.patterns.reduce((current, pattern) => {
    const match = current.match(pattern)
    const at = match.index + match[0].lastIndexOf(match[1])
    return current.slice(0, at) + version + current.slice(at + match[1].length)
  }, text)
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
 * The requested version is not judged here beyond the tag lookup `inspect`
 * already made for it: whether a version is ahead of the current one (`prepare`)
 * or equal to it and on `origin/main` (`publish`) is a question each subcommand
 * asks for itself.
 */
function report(state) {
  const { label, tag } = releaseRange({ warn: (message) => process.stderr.write(`release: ${message}\n`) })
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

/**
 * The reason `version` cannot be published from this tree, or null when it can.
 *
 * A commit is publishable when `origin/main` contains it: publishing an
 * unreviewed or unpushed commit would put it in front of everyone at once, and
 * `gh` pushes the tag itself.
 */
export function notCurrentReason(version, current, onOriginMain = true) {
  if (parseVersion(version) === null) return `${version} is not an x.y.z version`
  if (current === null) return 'the version files do not all carry the same x.y.z version'
  if (version !== current) return `the tree is at ${current}, not ${version} — prepare it first`
  if (!onOriginMain) return 'HEAD is not on origin/main — push it and let CI review it before releasing'
  return null
}

/**
 * Whether the repository has a remote `main`, and whether HEAD is in it.
 *
 * A clone without `origin/main` (a fresh local repository, a detached checkout)
 * cannot answer the question, and the answer `true` there is the permissive one:
 * the absence of evidence is not a reason to refuse a release.
 */
function onOriginMain(root) {
  if (tryRun('git', ['-C', root, 'rev-parse', '--verify', 'origin/main']) === null) return true
  return tryRun('git', ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main']) !== null
}

function fail(message) {
  process.stderr.write(`release: ${message}\n`)
  process.exit(1)
}

/** `--notes <file>` / `--yes` / `--dry-run`, nothing else — an unknown flag is a typo, not a no-op. */
function parseArgs(argv) {
  const options = { yes: false, dryRun: false, notes: null }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--yes') options.yes = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--notes') options.notes = argv[++i] ?? fail('--notes needs a file')
    else if (arg.startsWith('-')) fail(`unknown option: ${arg} — check, prepare and publish take --notes, --yes and --dry-run only`)
    else rest.push(arg)
  }
  return { options, rest }
}

function check(version) {
  if (version !== null && parseVersion(version) === null) fail(`not a version: ${version}`)
  const state = inspect(repoRoot(), version)
  if (report(state).length > 0) process.exit(1)
  return state
}

function prepare(version) {
  if (version === null) fail('prepare needs a version: npm run release:prepare -- 0.2.0')
  const root = repoRoot()
  const state = inspect(root, version)
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
  const state = inspect(root, version)
  const mismatch = notCurrentReason(version, state.current, onOriginMain(root))
  if (mismatch !== null) fail(mismatch)
  if (report(state).length > 0) fail('nothing was published')
  const notes = options.notes === null ? join(root, 'tmp', `release-notes-${version}.md`) : resolve(options.notes)
  let body
  try {
    body = readFileSync(notes, 'utf8')
  } catch {
    fail(`no notes file at ${notes} — write one with: npm run release:notes -- --out ${notes}`)
  }
  if (body.trim() === '') fail(`the notes file ${notes} is empty`)
  if (body.includes('<!-- DRAFT')) {
    fail(`the notes file ${notes} still carries its DRAFT marker — it is a draft, not a release`)
  }
  const slug = repoSlug()
  if (slug === null) fail('no GitHub repository to publish to: set GH_REPO or add an origin remote')
  const title = `dsh-balance ${version}`
  const sha = run('git', ['-C', root, 'rev-parse', 'HEAD'])
  const args = ghReleaseArgs({ version, slug, title, notes, sha })
  process.stdout.write([
    `repository: ${slug}`,
    `commit: ${sha}`,
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
  // No local `git tag` first: `gh release create` creates the tag on the remote
  // and pushes it, so a local tag made first only ever leaves a half-release
  // behind when gh then fails.
  try {
    process.stdout.write(`${run('gh', args)}\n`)
  } catch (error) {
    process.stdout.write(`gh failed, nothing was tagged: ${error.stderr ?? error.message}\n`)
    process.exit(1)
  }
  process.stdout.write(`\nreleased ${version}: the tag is on the remote; fetch it with \`git fetch --tags\`\n`)
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
