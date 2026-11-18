// Runs every mod's tests, checks that the copies of the shared shell parser are identical,
// and that every mod's plugin.json carries the fields a marketplace listing needs.
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
