import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkRefusals, dirtyFromStatus, ghReleaseArgs, notAheadReason, notCurrentReason, placeVersions, rewriteVersionIn,
  slugFromOrigin, VERSION_PLACES,
} from '../scripts/release.mjs'
import {
  compareVersions, extractWhatChanges, extractWhy, humanizeChangeName, parseVersion, releaseTree, renderNotes,
  subjectOf, wrap,
} from '../scripts/release-notes.mjs'

const MANIFEST = '{\n  "name": "dsh-balance",\n  "version": "0.1.0",\n  "private": true\n}\n'
const HOST = "import { z } from 'zod'\n\nconst VERSION = '0.1.0'\n"
const CLIENT = "const VERSION = '0.1.0'\nexport { VERSION }\n"
const place = (file) => VERSION_PLACES.find((known) => known.file === file)

const LOCKFILE = `{
  "name": "dsh-balance",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "dsh-balance",
      "version": "0.1.0",
      "license": "MIT"
    },
    "node_modules/zod": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz"
    }
  }
}
`

const PROPOSAL = `# Proposal

## Why

The Cost view shows the shape of a session but names nothing, and the expensive patterns
are exactly the ones a human eye misses on a decimated plot.

<!-- an editorial note the notes must not quote -->

## What Changes

- New capability \`cost-anomaly-indicators\`: ten deterministic detectors, each
  reporting a Finding with a threshold it must clear.
- **BREAKING** (data shape): a series node gains a \`kind\`, so the client and the Host
  must ship together.
  - a nested bullet that belongs to the one above it
- New plugin configuration \`anomalies\`.

## Impact

- Nothing under \`src/\`.

## Notes

Text after another heading is not a change.
`

test('a version is three numbers and nothing else', () => {
  assert.equal(parseVersion('0.2.0'), '0.2.0')
  assert.equal(parseVersion('0.20.10'), '0.20.10')
  for (const bad of ['0.2', '0.2.0-rc.1', 'v0.2.0', '0.2.0.1', '', null, 2, undefined]) {
    assert.equal(parseVersion(bad), null, `${bad} is not a version`)
  }
})

test('versions compare the way semver does', () => {
  assert.equal(compareVersions('0.2.0', '0.1.0'), 1)
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0)
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1, 'ten is not less than nine')
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('0.2', '0.1.0'), null, 'a malformed version has no order')
  assert.equal(compareVersions(null, '0.1.0'), null)
})

test('a change name loses its date and reads as a title', () => {
  assert.equal(humanizeChangeName('2026-09-29-cost-anomaly-indicators'), 'Cost anomaly indicators')
  assert.equal(humanizeChangeName('2026-01-01-add-release-tooling'), 'Add release tooling')
  assert.equal(humanizeChangeName('2026-01-01-chore'), 'Chore')
  assert.equal(humanizeChangeName('no-date-here'), 'No date here')
})

test('the Why prose is the first real paragraph, unwrapped', () => {
  assert.equal(
    extractWhy(PROPOSAL),
    'The Cost view shows the shape of a session but names nothing, and the expensive patterns are '
    + 'exactly the ones a human eye misses on a decimated plot.',
  )
})

test('a proposal with no Why section has no Why prose', () => {
  assert.equal(extractWhy('# Proposal\n\n## Impact\n\n- Nothing.\n'), '')
  assert.equal(extractWhy(''), '')
})

test('the What Changes bullets keep their nesting and stop at the next heading', () => {
  const bullets = extractWhatChanges(PROPOSAL)
  assert.equal(bullets.length, 6, 'the wrapped lines and the nested bullet count too')
  assert.match(bullets[0], /^- New capability/)
  assert.match(bullets[1], /^ {2}reporting a Finding/, 'a wrapped continuation line is kept')
  assert.match(bullets[2], /^- \*\*BREAKING\*\*/)
  assert.match(bullets[3], /^ {2}must ship together\.$/)
  assert.match(bullets[4], /^ {2}- a nested bullet/, 'indentation is kept')
  assert.match(bullets[5], /^- New plugin configuration/)
  assert.ok(!bullets.some((bullet) => bullet.includes('## Impact')), 'the next heading ends the list')
})

test('prose wraps on word boundaries and never mid-word', () => {
  const wrapped = wrap('alpha beta gamma delta epsilon', 11)
  assert.deepEqual(wrapped.split('\n'), ['alpha beta', 'gamma delta', 'epsilon'])
  assert.equal(wrap('', 80), '')
  assert.equal(wrap('one', 80), 'one')
  for (const line of wrap(PROPOSAL, 40).split('\n')) assert.ok(line.length <= 40, `"${line}" fits`)
})

test('a conventional-commit prefix is stripped from a subject', () => {
  assert.equal(subjectOf('feat: add the Cost view'), 'add the Cost view')
  assert.equal(subjectOf('fix(core)!: drop the old route'), 'drop the old route')
  assert.equal(subjectOf('chore(deps): bump knip'), 'bump knip')
  assert.equal(subjectOf('Update the CI actions to Node 24 runtimes'), 'Update the CI actions to Node 24 runtimes')
})

const CHANGE = {
  name: '2026-09-29-cost-anomaly-indicators',
  why: 'The chart shows the shape; indicators say what is wrong with it.',
  bullets: ['- **BREAKING** a series node gains a `kind`.', '- Ten detectors.'],
}
const OTHER = { name: '2026-09-29-session-cost-analysis', why: 'A session estimate of $4.12 gives the user nothing.', bullets: ['- A Cost view tab.'] }

test('the draft names its version, its date and the range it covers', () => {
  const notes = renderNotes({ version: '0.2.0', date: '2026-09-29', range: 'the whole history (no tag yet)', changes: [], commits: [] })
  assert.match(notes, /^<!-- DRAFT release notes for dsh-balance 0\.2\.0/)
  assert.match(notes, /^# dsh-balance 0\.2\.0$/m)
  assert.match(notes, /Released 2026-09-29\. Covers `the whole history \(no tag yet\)`\./)
  assert.match(notes, /No changes recorded in this range\./)
})

test('each change is a section in the order given, prose first', () => {
  const notes = renderNotes({ version: '0.2.0', date: '2026-09-29', range: 'v0.1.0..HEAD', changes: [OTHER, CHANGE], commits: [] })
  assert.ok(notes.indexOf('### Session cost analysis') < notes.indexOf('### Cost anomaly indicators'), 'given order is kept')
  const section = notes.slice(notes.indexOf('### Cost anomaly indicators'))
  assert.ok(section.indexOf('The chart shows') < section.indexOf('Ten detectors.'), 'Why precedes the bullets')
})

test('a proposal that marked a breaking change says so above its prose', () => {
  const notes = renderNotes({ version: '0.2.0', date: '2026-09-29', range: 'v0.1.0..HEAD', changes: [CHANGE, OTHER], commits: [] })
  const breaking = notes.slice(notes.indexOf('### Cost anomaly indicators'), notes.indexOf('### Session cost analysis'))
  assert.match(breaking, /\*\*Breaking change\.\*\*/)
  const plain = notes.slice(notes.indexOf('### Session cost analysis'))
  assert.ok(!plain.includes('**Breaking change.**'), 'a change that is not breaking is not marked')
})

test('the commits that are not a change get their own list', () => {
  const notes = renderNotes({ version: '0.2.0', date: '2026-09-29', range: 'v0.1.0..HEAD', changes: [CHANGE], commits: ['feat: add the Cost view', 'Round money on the way out'] })
  const other = notes.slice(notes.indexOf('## Other changes'))
  assert.match(other, /^- add the Cost view$/m)
  assert.match(other, /^- Round money on the way out$/m)
  assert.ok(notes.indexOf('add the Cost view') > notes.indexOf('- Ten detectors.'), 'the list comes after the changes')
})

test('a release with only commits still reads as notes', () => {
  const notes = renderNotes({ version: '0.1.1', date: '2026-10-01', range: 'v0.1.0..HEAD', changes: [], commits: ['fix: a day that never ends'] })
  assert.ok(!notes.includes('## What changed'), 'no section without a change to describe')
  assert.match(notes, /## Other changes\n\n- a day that never ends\n/)
})

test('the version is written in every file that carries it, manifest and lockfile included', () => {
  assert.deepEqual(VERSION_PLACES.map((known) => known.file), [
    'package.json',
    'package-lock.json',
    'src/index.js',
    'client/client.js',
  ])
})

test('a rewrite touches one line and changes nothing else', () => {
  assert.match(rewriteVersionIn(MANIFEST, '0.2.0', place('package.json')), /"version": "0\.2\.0"/)
  assert.match(rewriteVersionIn(HOST, '0.2.0', place('src/index.js')), /const VERSION = '0\.2\.0'/)
  assert.match(rewriteVersionIn(CLIENT, '0.2.0', place('client/client.js')), /const VERSION = '0\.2\.0'/)
  assert.equal(rewriteVersionIn(HOST, '0.2.0', place('src/index.js')), HOST.replace('0.1.0', '0.2.0'))
  assert.equal(rewriteVersionIn(MANIFEST, '0.2.0', place('package.json')), MANIFEST.replace('0.1.0', '0.2.0'))
})

test('a rewrite refuses a file that does not carry the version once', () => {
  assert.throws(() => rewriteVersionIn(MANIFEST, '0.2.0', place('src/index.js')), /expected one version line per pattern \(1\), found 0/)
  const twice = `const VERSION = '0.1.0'\nconst VERSION = '0.1.0'\n`
  assert.throws(() => rewriteVersionIn(twice, '0.2.0', place('src/index.js')), /expected one version line per pattern \(1\), found 2/)
})

test('the lockfile root version comes along with the manifest', () => {
  assert.deepEqual(placeVersions(LOCKFILE, place('package-lock.json')), ['0.1.0', '0.1.0'])
  const rewritten = rewriteVersionIn(LOCKFILE, '0.2.0', place('package-lock.json'))
  assert.deepEqual(placeVersions(rewritten, place('package-lock.json')), ['0.2.0', '0.2.0'])
})

test('the lockfile rewrite leaves every dependency version where it is', () => {
  const rewritten = rewriteVersionIn(LOCKFILE, '0.2.0', place('package-lock.json'))
  assert.match(rewritten, /"node_modules\/zod": \{\n      "version": "4\.4\.3"/)
  assert.equal(
    rewritten,
    LOCKFILE.replace('"version": "0.1.0"', '"version": "0.2.0"').replace('"version": "0.1.0"', '"version": "0.2.0"'),
  )
})

test('a lockfile whose root version cannot be found is refused, not guessed at', () => {
  const noRootEntry = LOCKFILE.replace(/    "": \{[^}]*"version": "0\.1\.0",\n/, '')
  assert.throws(
    () => rewriteVersionIn(noRootEntry, '0.2.0', place('package-lock.json')),
    /expected one version line per pattern \(2\), found 1/,
  )
  const noTopVersion = LOCKFILE.replace('  "version": "0.1.0",\n  "lockfileVersion"', '  "lockfileVersion"')
  assert.throws(
    () => rewriteVersionIn(noTopVersion, '0.2.0', place('package-lock.json')),
    /expected one version line per pattern \(2\), found 1/,
  )
})

test('a lockfile whose root version is found twice is refused, not half rewritten', () => {
  // Two matches for the first pattern and none for the second still add up to
  // the number of patterns, so a total-only count would let this through.
  const doubled = LOCKFILE
    .replace(/    "": \{[^}]*"version": "0\.1\.0",\n/, '')
    .replace('  "lockfileVersion": 3,', '  "lockfileVersion": 3,\n  "copy": { "version": "9.9.9", "lockfileVersion": 3 },')
  assert.throws(
    () => rewriteVersionIn(doubled, '0.2.0', place('package-lock.json')),
    /expected one version line per pattern \(2\), found 2/,
  )
})

test('a rewrite writes a longer version without shifting the line around it', () => {
  const rewritten = rewriteVersionIn(HOST, '10.20.30', place('src/index.js'))
  assert.equal(rewritten, "import { z } from 'zod'\n\nconst VERSION = '10.20.30'\n")
})

test('the check refuses a mismatched version, a dirty tree and an old version', () => {
  const ready = { current: '0.2.0', lastTag: 'v0.1.0', tagExists: null, dirty: [] }
  assert.deepEqual(checkRefusals(ready), [])
  assert.deepEqual(
    checkRefusals({ ...ready, current: null }),
    ['the version files do not all carry the same x.y.z version'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, dirty: ['src/index.js'] }),
    ['uncommitted changes outside tmp/: src/index.js'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, tagExists: '0.2.0' }),
    ['the tag v0.2.0 already exists'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, current: '0.1.0' }),
    ['0.1.0 is not ahead of the last tag v0.1.0'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, current: '0.0.1', lastTag: null }),
    [],
    'the first release has no tag to be ahead of',
  )
  assert.deepEqual(
    checkRefusals({ ...ready, current: null, missing: ['package-lock.json', 'src/index.js'] }),
    [
      'the version files do not all carry the same x.y.z version',
      'the tree has no package-lock.json, src/index.js — a release reads the version from all four places',
    ],
    'a tree missing a version place says which one, instead of failing on the read',
  )
  assert.deepEqual(
    checkRefusals({ ...ready, missing: ['client/client.js'] }),
    ['the tree has no client/client.js — a release reads the version from all four places'],
    'and the missing place is named even when the others agree',
  )
  assert.deepEqual(checkRefusals({ ...ready, missing: [] }), [], 'a tree with all four places is not missing any')
})

test('the status dump is parsed into paths, and tmp/ is the one exemption', () => {
  assert.deepEqual(dirtyFromStatus('?? tmp/release-notes-0.2.0.md\0 M src/index.js\0'), ['src/index.js'])
  assert.deepEqual(dirtyFromStatus('?? tmp/x.md\0'), [], 'a notes draft never blocks a release')
  assert.deepEqual(dirtyFromStatus('A  scripts/release.mjs\0M  client/client.js\0'), ['scripts/release.mjs', 'client/client.js'])
  assert.deepEqual(dirtyFromStatus(''), [])
  assert.deepEqual(dirtyFromStatus('?? tmps/x.md\0'), ['tmps/x.md'], 'a directory that only starts with tmp is not tmp')
})

test('a remote URL gives the owner and name, or nothing', () => {
  assert.equal(slugFromOrigin('git@github.com:xilec/dsh-balance.git'), 'xilec/dsh-balance')
  assert.equal(slugFromOrigin('https://github.com/xilec/dsh-balance'), 'xilec/dsh-balance')
  assert.equal(slugFromOrigin('https://github.com/xilec/dsh-balance.git'), 'xilec/dsh-balance')
  assert.equal(slugFromOrigin('/home/evgen/work/github/dsh_balance'), null, 'a local path is not a GitHub remote')
  assert.equal(slugFromOrigin(''), null)
})

test('prepare only moves the version forward', () => {
  assert.equal(notAheadReason('0.2.0', '0.1.0'), null)
  assert.equal(notAheadReason('0.2.0', null), null, 'a mismatched tree has no version to be behind')
  assert.equal(notAheadReason('0.1.0', '0.1.0'), '0.1.0 is not ahead of the current version 0.1.0')
  assert.equal(notAheadReason('0.1.9', '0.2.0'), '0.1.9 is not ahead of the current version 0.2.0')
  assert.equal(notAheadReason('0.2', '0.1.0'), '0.2 is not an x.y.z version')
})

test('publish only tags the version the tree already carries', () => {
  assert.equal(notCurrentReason('0.2.0', '0.2.0'), null)
  assert.equal(notCurrentReason('0.2.0', '0.2.0', false), 'HEAD is not on origin/main — push it and let CI review it before releasing')
  assert.equal(notCurrentReason('0.3.0', '0.2.0'), 'the tree is at 0.2.0, not 0.3.0 — prepare it first')
  assert.equal(notCurrentReason('0.1.0', '0.2.0'), 'the tree is at 0.2.0, not 0.1.0 — prepare it first')
  assert.equal(notCurrentReason('0.2.0', null), 'the version files do not all carry the same x.y.z version')
  assert.equal(notCurrentReason('0.2', '0.2.0'), '0.2 is not an x.y.z version')
})

test('gh is called with the release, the repository and the reviewed notes', () => {
  const args = ghReleaseArgs({ version: '0.2.0', slug: 'xilec/dsh-balance', title: 'dsh-balance 0.2.0', notes: '/tmp/notes.md', sha: 'abc123' })
  assert.deepEqual(args, [
    'release', 'create', 'v0.2.0',
    '--repo', 'xilec/dsh-balance',
    '--title', 'dsh-balance 0.2.0',
    '--notes-file', '/tmp/notes.md',
    '--target', 'abc123',
  ])
  assert.ok(!args.includes('gh'), 'gh is the program, never one of its arguments')
})

// --- which tree a release acts on --------------------------------------------------
//
// The four version files, the notes draft and every `git` call hang off one directory,
// and `AGENTS.md` sends the maintainer to a scratch copy under `tmp/` — a directory
// inside the checkout, with no repository of its own. `git rev-parse --show-toplevel`
// answered with the checkout above the copy, and `release:prepare` in the copy rewrote
// *that* checkout's version files. These cases are filesystem-shaped, so they get
// filesystem-shaped fixtures: a real directory, a real `git init`, no mocked git.

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts')

/**
 * The tests below need a `git` to make a repository with. `nix flake check` runs this
 * suite in a sandbox whose build inputs are `nodejs` alone, so they are skipped there
 * with the reason stated; `npm test` runs them (design D7).
 */
const needsGit = { skip: spawnSync('git', ['--version']).status === 0 ? false : 'git is not installed here' }

/**
 * A throwaway git repository under the system temp directory: one commit, and the
 * plugin's manifest unless `manifest` is null. Removed when the test ends, so a
 * failing assertion cannot leave a repository behind.
 *
 * `realpathSync` because the resolver compares the directory it was given with what
 * git reports, and on a system where the temp directory is a symlink the two would
 * differ for a reason that has nothing to do with the tree. The commit identity is
 * passed on the command line so the developer's own git configuration cannot decide
 * whether a fixture is created.
 */
function tempRepo(t, { manifest = MANIFEST } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-release-tree-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  if (manifest !== null) {
    writeFileSync(join(root, 'package.json'), manifest)
    // Tracked, not just present: a worktree checks the commit out, so a manifest
    // left untracked would leave the worktree without the file under test.
    git('add', '-A')
  }
  git('-c', 'user.email=release@example.com', '-c', 'user.name=release', 'commit', '-q', '--allow-empty', '-m', 'scratch')
  return { root, git }
}

test('the tree is the repository root, and a copy inside one is refused by name', needsGit, (t) => {
  const { root } = tempRepo(t)
  assert.deepEqual(releaseTree(root), { root }, 'the root is the one tree the rule accepts')

  const scratch = join(root, 'tmp', 'scratch')
  mkdirSync(scratch, { recursive: true })
  const found = releaseTree(scratch)
  assert.ok('refusal' in found, 'a directory inside a checkout is not that checkout')
  assert.match(found.refusal, /is not the root of a repository/)
  assert.ok(found.refusal.includes(scratch), 'the refusal names the directory it was run in')
  assert.ok(found.refusal.includes(`rooted at ${root}`), 'and the tree it would have written to')
  assert.match(found.refusal, /git init/, 'and what makes the copy a tree of its own')
})

test('a worktree root is a tree of its own, even inside another repository', needsGit, (t) => {
  const { root, git } = tempRepo(t)
  const worktree = join(root, 'wt')
  git('worktree', 'add', '-q', '--detach', worktree)
  assert.deepEqual(releaseTree(worktree), { root: worktree }, 'the worktree root, not the repository it sits in')

  const inside = join(worktree, 'scripts')
  mkdirSync(inside)
  const found = releaseTree(inside)
  assert.match(found.refusal, /is not the root of a repository/)
  assert.ok(found.refusal.includes(`rooted at ${worktree}`), 'a directory inside a worktree names the worktree')
})

test('a copy with no repository is refused until it has one of its own', needsGit, (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-release-tree-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), MANIFEST)

  const loose = releaseTree(root)
  assert.ok('refusal' in loose, 'a manifest with no repository around it is not a tree to release')
  assert.match(loose.refusal, /is not inside a git repository/)

  execFileSync('git', ['init', '-q'], { cwd: root })
  assert.deepEqual(releaseTree(root), { root }, 'after `git init` the copy is a tree of its own')
})

test('a bare clone has no working tree to write a version into', needsGit, (t) => {
  const { root, git } = tempRepo(t)
  const bare = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-release-bare-')))
  t.after(() => rmSync(bare, { recursive: true, force: true }))
  git('clone', '-q', '--bare', root, bare)

  const found = releaseTree(bare)
  assert.ok('refusal' in found, 'a bare repository is a repository without a tree')
  assert.match(found.refusal, /is a bare repository/)
  assert.match(found.refusal, /without --bare/, 'and the command that gives it one')
})

test('a repository that is not the plugin is refused by its missing manifest', needsGit, (t) => {
  const { root } = tempRepo(t, { manifest: null })
  const found = releaseTree(root)
  assert.ok('refusal' in found, 'a git root is not by itself the plugin checkout')
  assert.match(found.refusal, /holds no package\.json/)
  assert.ok(found.refusal.includes(root), 'the refusal names the tree it found')
})

test('both scripts refuse, by name, a tree they were not run in', needsGit, (t) => {
  const { root } = tempRepo(t)
  const scratch = join(root, 'tmp', 'scratch')
  mkdirSync(scratch, { recursive: true })

  const check = spawnSync(process.execPath, [join(SCRIPTS, 'release.mjs'), 'check', '0.3.0'], { cwd: scratch, encoding: 'utf8' })
  assert.equal(check.status, 1, 'a check that cannot name its tree refuses')
  assert.match(check.stderr, /is not the root of a repository/)
  assert.ok(check.stderr.includes(scratch) && check.stderr.includes(`rooted at ${root}`), 'both trees are named')
  assert.doesNotMatch(check.stdout, /version:/, `no version is read from the tree above: ${check.stdout}`)

  const notes = spawnSync(process.execPath, [join(SCRIPTS, 'release-notes.mjs'), '--stdout'], { cwd: scratch, encoding: 'utf8' })
  assert.equal(notes.status, 1, 'a draft cannot be assembled about a tree that was not named')
  assert.match(notes.stderr, /is not the root of a repository/)
  assert.equal(notes.stdout, '', 'no notes are drafted about the tree above')
})
