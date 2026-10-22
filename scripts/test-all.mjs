// Runs every mod's tests, and checks that the copies of the shared shell parser are identical.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const mods = readdirSync('mods', { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join('mods', entry.name))

const shells = mods.map(mod => join(mod, 'hooks', 'shell.ts')).filter(file => existsSync(file))

if (new Set(shells.map(file => readFileSync(file, 'utf8'))).size > 1) {
  console.error(`hooks/shell.ts differs between: ${shells.join(', ')}. Keep the copies identical.`)
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
