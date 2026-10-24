import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ENV = { USERPROFILE: 'C:\\Users\\me', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' }

const world = (on: On, cwd = 'C:\\repos\\app') => {
  mock.env(on, ENV)
  on('session.cwd', () => ({ value: cwd }))
}

// Commands that destroy work for good, run in the project C:\repos\app.
const DENIED = [
  'rm -rf /',
  'rm -rf ~',
  'rm -rf ~/Documents',
  'rm -rf $HOME/.config',
  'rm -rf "$BUILD_DIR"',
  'rm -rf *',
  'rm -rf .',
  'rm -rf ..',
  'rm -rf ../other-repo',
  'rm -fr /c/Users/me/Projects',
  'rm -r -f C:\\repos\\other',
  'sudo rm -rf /var/lib',
  'cd ~ && rm -rf Documents',
  'Remove-Item -Recurse -Force C:\\Users\\me\\Documents',
  'Remove-Item C:\\repos -Recurse',
  'rm -r -Force $env:USERPROFILE\\.aws',
  'cmd /c rd /s /q C:\\repos',
  'git push --force',
  'git push -f origin main',
  'git push origin +main',
  'git -C repo push --force origin main',
  'git reset --hard',
  'git reset --hard origin/main',
  'git clean -fdx',
  'git clean --force',
  'git checkout -- .',
  'git restore .',
  'git stash clear',
  'git re\\set --hard',
  `psql -c "DROP TABLE users"`,
  `psql -c 'TRUNCATE orders'`,
  `sqlite3 app.db "DELETE FROM sessions;"`,
  "mysql -e 'DROP DATABASE prod'",
  "psql <<'SQL'\nDROP SCHEMA public CASCADE;\nSQL",
  'redis-cli FLUSHALL',
  `mongosh --eval "db.dropDatabase()"`,
  'mkfs.ext4 /dev/sdb1',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'Format-Volume -DriveLetter D',
  // Found in review.
  'Remove-Item -Recurse .\\dist,C:\\Users\\me\\Documents',
  'Remove-Item -Recurse:$true C:\\Users\\me\\Documents',
  'Remove-Item -Recurse -Path:C:\\Users\\me\\Documents',
  'Remove-Item -Recurse C:..\\other',
  'cd "$BUILD_DIR" && rm -rf dist',
  'cd && rm -rf Documents',
  'rm -rf */',
  'rm -rf ./*/',
  'rm -rf {dist,../other-repo}',
  'git restore ./',
  'git checkout -- ./',
  'git checkout -f main',
  'git switch --discard-changes main',
  'git push --mirror origin',
  'git restore --staged -qW .',
  `psql -c "DELETE FROM users RETURNING *;"`,
  `psql -c "DELETE FROM ONLY users;"`,
] as const

// Ordinary work: runs.
const ALLOWED = [
  'rm -rf node_modules',
  'rm -rf dist build/*',
  'rm -rf ./coverage',
  'rm -rf C:\\repos\\app\\.terraform',
  'rm -rf /c/repos/app/tmp',
  'rm -rf C:\\Users\\me\\AppData\\Local\\Temp\\claude\\scratch',
  'rm -rf /tmp/build',
  'rm -f ~/notes.txt',
  'rm file.txt',
  'cd sub && rm -rf out',
  'Remove-Item -Recurse -Force .\\bin',
  'Remove-Item C:\\Users\\me\\Documents\\x.txt -Force',
  'Remove-Item -Recurse C:\\Users\\me\\Documents -WhatIf',
  'Get-ChildItem -Recurse -Filter *.log',
  'git push',
  'git push --force-with-lease',
  'git push -u origin feat/x',
  'git push origin --delete feat/x',
  'git reset --soft HEAD~1',
  'git reset HEAD file.txt',
  'git clean -n',
  'git clean -fdn',
  'git checkout -b feat/x',
  'git checkout main',
  'git restore --staged .',
  'git stash push -m wip',
  'git commit -m "rm -rf the old build; git reset --hard was wrong"',
  'echo "DROP TABLE users"',
  `psql -c "SELECT * FROM users"`,
  `sqlite3 app.db "DELETE FROM sessions WHERE expires < now();"`,
  'dd if=/dev/zero of=disk.img bs=1M count=10',
  'ls -la',
  'Remove-Item -Recurse:$false C:\\Users\\me\\Documents\\x.txt',
  'Remove-Item -Recurse .\\dist,.\\build',
  'rm -rf {dist,build}',
  'cd sub && rm -rf build/*/',
  'git restore -S .',
  'git switch main',
  'git push --dry-run --force origin main',
  'git push -fn origin main',
  'dd if=/dev/zero of=/dev/null bs=1M count=1',
  'Clear-Disk -Number 2 -WhatIf',
] as const

for (const tool of ['Bash', 'PowerShell'] as const) {
  for (const [command, isAllowed] of [...DENIED.map(c => [c, false] as const), ...ALLOWED.map(c => [c, true] as const)]) {
    test(`${tool} ${isAllowed ? 'runs' : 'is denied'}: ${command}`, async ($, on) => {
      world(on)
      let hasRun = false

      on('tool.call', { tool: [tool] }, () => {
        hasRun = true

        return { result: { stdout: '', stderr: '', interrupted: false } }
      })

      const ran = await $.tool.call({ tool, command })

      // Backslash escapes and brace expansion are Bash's alone: PowerShell keeps git re\set as written, and {a,b} is a script block.
      expect(hasRun).toBe(isAllowed || (tool === 'PowerShell' && (command.includes('re\\set') || command.includes('{dist,'))))
      expect(/guard failed/.test(JSON.stringify(ran))).toBe(false)
    })
  }
}

test('at home, no folder counts as the project', async ($, on) => {
  world(on, 'C:\\Users\\me')
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'rm -rf Documents' }))).toContain('recursive delete')
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'rm -rf AppData/Local/Temp/x' }))).not.toContain('deny')
})

test('the deny names the loss and the way out', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const ran = JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'git push --force' }))

  expect(ran).toContain('`git push --force`')
  expect(ran).toContain('--force-with-lease')
  expect(ran).toContain('`!` prefix')
})
