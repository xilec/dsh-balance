import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkRefusals, notAheadReason, notCurrentReason, rewriteVersionIn, slugFromOrigin, VERSION_PLACES,
} from '../scripts/release.mjs'
import {
  compareVersions, extractWhatChanges, extractWhy, humanizeChangeName, parseVersion, renderNotes,
  subjectOf, wrap,
} from '../scripts/release-notes.mjs'

const MANIFEST = '{\n  "name": "dsh-balance",\n  "version": "0.1.0",\n  "private": true\n}\n'
const HOST = "import { z } from 'zod'\n\nconst VERSION = '0.1.0'\n"
const CLIENT = "const VERSION = '0.1.0'\nexport { VERSION }\n"
const place = (file) => VERSION_PLACES.find((known) => known.file === file)

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

test('the version is written in exactly the three places the panel reads', () => {
  assert.deepEqual(VERSION_PLACES.map((known) => known.file), ['package.json', 'src/index.js', 'client/client.js'])
})

test('a rewrite touches one line and changes nothing else', () => {
  assert.match(rewriteVersionIn(MANIFEST, '0.2.0', place('package.json')), /"version": "0\.2\.0"/)
  assert.match(rewriteVersionIn(HOST, '0.2.0', place('src/index.js')), /const VERSION = '0\.2\.0'/)
  assert.match(rewriteVersionIn(CLIENT, '0.2.0', place('client/client.js')), /const VERSION = '0\.2\.0'/)
  assert.equal(rewriteVersionIn(HOST, '0.2.0', place('src/index.js')), HOST.replace('0.1.0', '0.2.0'))
  assert.equal(rewriteVersionIn(MANIFEST, '0.2.0', place('package.json')), MANIFEST.replace('0.1.0', '0.2.0'))
})

test('a rewrite refuses a file that does not carry the version once', () => {
  assert.throws(() => rewriteVersionIn(MANIFEST, '0.2.0', place('src/index.js')), /no version line|expected one/)
  const twice = `const VERSION = '0.1.0'\nconst VERSION = '0.1.0'\n`
  assert.throws(() => rewriteVersionIn(twice, '0.2.0', place('src/index.js')), /expected one version line, found 2/)
})

test('a rewrite writes a longer version without shifting the line around it', () => {
  const rewritten = rewriteVersionIn(HOST, '10.20.30', place('src/index.js'))
  assert.equal(rewritten, "import { z } from 'zod'\n\nconst VERSION = '10.20.30'\n")
})

test('the check refuses a mismatched version, a dirty tree and an old version', () => {
  const ready = { current: '0.2.0', lastTag: 'v0.1.0', tagExists: false, dirty: [] }
  assert.deepEqual(checkRefusals(ready), [])
  assert.deepEqual(
    checkRefusals({ ...ready, current: null }),
    ['the three version places do not all carry the same x.y.z version'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, dirty: ['src/index.js', 'tmp/'] }),
    ['uncommitted changes outside tmp/: src/index.js, tmp/'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, tagExists: true }),
    ['the tag v0.2.0 already exists'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, current: '0.1.0' }),
    ['0.1.0 is not ahead of the last tag v0.1.0'],
  )
  assert.deepEqual(
    checkRefusals({ ...ready, lastTag: null, current: '0.0.1' }),
    [],
    'the first release has no tag to be ahead of',
  )
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
  assert.equal(notCurrentReason('0.3.0', '0.2.0'), 'the tree is at 0.2.0, not 0.3.0 — prepare it first')
  assert.equal(notCurrentReason('0.1.0', '0.2.0'), 'the tree is at 0.2.0, not 0.1.0 — prepare it first')
  assert.equal(notCurrentReason('0.2.0', null), 'the three version places do not all carry the same x.y.z version')
  assert.equal(notCurrentReason('0.2', '0.2.0'), '0.2 is not an x.y.z version')
})
