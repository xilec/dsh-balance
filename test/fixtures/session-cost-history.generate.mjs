/**
 * Regenerate the two export fixtures from the shared input.
 *
 * `npm test` compares against the committed files; this script is what writes them
 * after a deliberate change to the stream, and it is run by hand:
 *
 *   node test/fixtures/session-cost-history.generate.mjs
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { exportInput } from './session-cost-history.input.js'

const here = dirname(fileURLToPath(import.meta.url))
const registrations = []
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
await import('../../client/client.js')
// The module asks for React at load time; the builder never renders, so a stub is
// enough to reach it.
const react = { createElement: () => null, memo: (component) => component, useState: (value) => [value, () => {}] }
const exported = registrations[0].factory((specifier) => {
  if (specifier === 'react') return react
  throw new Error(`unexpected require(${specifier})`)
})

for (const detail of ['costs', 'full']) {
  const stream = exported.__internals.costHistory({ ...exportInput(), detail })
  await writeFile(join(here, `session-cost-history-${detail}.ndjson`), stream)
  console.log(`${detail}: ${stream.trimEnd().split('\n').length} records`)
}
