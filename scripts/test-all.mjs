// Runs every mod's tests, checks that the copies of the shared shell parser are identical,
// that every mod's plugin.json carries the fields a marketplace listing needs,
// and that examples/managed-settings.json enables only mods the marketplace lists.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const mods = readdirSync('mods', { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join('mods', entry.name))

const shells = mods.map(mod => join(mod, 'hooks', 'shell.ts')).filter(file => existsSync(file))

if (new Set(shells.map(file => readFileSync(file, 'utf8'))).size > 1) {
  console.error(`hooks/shell.ts differs between: ${shells.join(', ')}. Keep the copies identical.`)
  process.exit(1)
}

const required = ['name', 'version', 'description', 'author', 'license']
const badManifests = mods.flatMap(mod => {
  const file = join(mod, '.claude-plugin', 'plugin.json')
  if (!existsSync(file)) return [`${file}: missing`]
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const missing = required.filter(key => !manifest[key])
  if (manifest.name && manifest.name !== basename(mod)) missing.push(`name (is "${manifest.name}", folder is "${basename(mod)}")`)
  if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) missing.push(`version (not x.y.z: "${manifest.version}")`)

  return missing.length > 0 ? [`${file}: ${missing.join(', ')}`] : []
})

const listed = JSON.parse(readFileSync(join('.claude-plugin', 'marketplace.json'), 'utf8')).plugins
  .map(entry => `${entry.name} ${entry.source}`).sort().join('\n')
const expected = mods.map(mod => `${basename(mod)} ./mods/${basename(mod)}`).sort().join('\n')
if (listed !== expected) badManifests.push(`.claude-plugin/marketplace.json must list each mod once as { "name": "<folder>", "source": "./mods/<folder>" }`)

// The managed-settings example must parse and may only lock on mods this marketplace ships.
const example = JSON.parse(readFileSync(join('examples', 'managed-settings.json'), 'utf8'))
const enabled = Object.keys(example.enabledPlugins)
const pinned = Object.values(example.extraKnownMarketplaces).map(entry => JSON.stringify(entry.source))
const unknown = [
  ...enabled.filter(id => example.enabledPlugins[id] !== true).map(id => `${id} (not true)`),
  // The allowlist matches a source exactly, ref included, so the two must be written the same.
  ...(JSON.stringify(example.strictKnownMarketplaces.map(source => JSON.stringify(source))) === JSON.stringify(pinned) ? [] : ['strictKnownMarketplaces (differs from the extraKnownMarketplaces sources)']),
  ...enabled.filter(id => !mods.some(mod => id === `${basename(mod)}@claude-code-guardrails`)),
  // A mod left out of prependPlugins does not load under allowManagedHooksOnly, and the built-in guard must stay listed.
  ...enabled.filter(id => !example.prependPlugins.includes(id)),
  ...example.prependPlugins.filter(id => id !== 'sec-default@builtin' && !enabled.includes(id)),
  ...(example.prependPlugins.includes('sec-default@builtin') ? [] : ['sec-default@builtin (missing from prependPlugins)']),
]
if (unknown.length > 0) {
  console.error(`examples/managed-settings.json: enabledPlugins and prependPlugins must name the same mods from .claude-plugin/marketplace.json, each set to true, and the marketplace pins must match: ${unknown.join(', ')}`)
  process.exit(1)
}

if (badManifests.length > 0) {
  console.error(`Manifests need ${required.join(', ')}:\n${badManifests.join('\n')}`)
  process.exit(1)
}

const failed = mods.filter(mod => {
  try {
    // On Windows, claude is a .cmd shim, which only runs through a shell.
    execFileSync('claude', ['plugin', 'test', mod], { stdio: 'inherit', shell: process.platform === 'win32' })

    return false
  } catch {
    return true
  }
})

if (failed.length > 0) {
  console.error(`Tests failed in: ${failed.join(', ')}`)
  process.exit(1)
}

console.log(`All ${mods.length} mods passed; ${shells.length} shell.ts copies match.`)
