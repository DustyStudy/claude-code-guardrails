import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ENV = {
  USERPROFILE: 'C:\\Users\\me',
  CLAUDE_CODE_PLUGIN_DIRS: 'C:/repos/guards-live/mods/self-guard;C:/repos/guards-live/mods/aws-guard',
}

const world = (on: On, cwd = 'C:\\repos\\app') => {
  mock.env(on, ENV)
  on('session.cwd', () => ({ value: cwd }))
}

// Shell commands that change Claude Code's own config or code, run in the project C:\repos\app.
const DENIED = [
  'echo "{}" > ~/.claude/settings.json',
  'echo x >> C:\\Users\\me\\.claude\\CLAUDE.md',
  'rm ~/.claude/settings.local.json',
  'cp evil.json $HOME/.claude/settings.json',
  'mv /c/Users/me/.claude/statusline.js /tmp/x',
  'sed -i s/deny/allow/ ~/.claude/settings.json',
  'Set-Content $env:USERPROFILE\\.claude\\settings.json "{}"',
  'Remove-Item -Recurse C:\\Users\\me\\.claude\\scheduled-tasks',
  'Copy-Item x.json -Destination:C:\\Users\\me\\.claude.json',
  'cat x | tee ~/.claude/CLAUDE.md',
  'node -e "require(\'fs\').writeFileSync(\'C:/Users/me/.claude/settings.json\', \'{}\')"',
  'bash -c "rm ~/.claude/settings.json"',
  'cd ~/.claude && rm settings.json',
  'rm C:\\repos\\guards-live\\mods\\aws-guard\\hooks\\register.ts',
  'git -C C:/repos/guards-live/mods/self-guard pull',
  'cd C:/repos/guards-live/mods/self-guard && git checkout -- .',
  'rm -rf ../guards-live/mods/self-guard',
  'echo {} > .claude/settings.json',
  'echo {} > C:\\repos\\other\\.claude\\settings.local.json',
  'rm ~/.claude/projects/../settings.json',
  'claude plugin install evil@market',
  'claude plugin marketplace add evil/repo',
  'claude mcp add evil -- npx evil',
  'claude config set -g autoUpdates false',
  // Found in review.
  'claude plugins disable self-guard',
  'claude --model sonnet plugin disable self-guard',
  'git diff --no-index --output ~/.claude/CLAUDE.md /dev/null README.md',
  'rm "${HOME}/.claude/CLAUDE.md"',
  'Set-Content "C:/Users/me/.claude/CLAUDE.md." x',
  'Remove-Item -Recurse .claude',
  'rm -rf ~/.claude/..',
  'rm -rf C:/repos/guards-live',
  // A plugin script run excuses only its own path.
  'node ~/.claude/plugins/cache/codex/x.mjs ~/.claude/settings.json',
  'cp evil.mjs ~/.claude/plugins/cache/codex/x.mjs && node ~/.claude/plugins/cache/codex/x.mjs',
  'node -e "require(\'fs\').rmSync(process.argv[1])" ~/.claude/plugins/cache/codex/x.mjs',
  'node ~/.claude/plugins/cache/../settings.json',
  // Found in Codex review.
  "echo '$(node ~/.claude/plugins/cache/codex/x.mjs)' > ~/.claude/plugins/cache/codex/x.mjs",
  "echo '`node ~/.claude/plugins/cache/codex/x.mjs`' > ~/.claude/plugins/cache/codex/x.mjs",
  "echo '$(node ~/.claude/plugins/cache/codex/x.mjs)'; rm ~/.claude/plugins/cache/codex/x.mjs",
  "echo '$(node ~/.claude/plugins/cache/codex/x.mjs)'; mv ~/.claude/plugins/cache/codex/x.mjs /tmp/stolen.mjs",
  "bash -c 'node ~/.claude/plugins/cache/codex/x.mjs' > ~/.claude/plugins/cache/codex/x.mjs",
  "Set-Content ~/.claude/plugins/cache/codex/x.mjs '$(node ~/.claude/plugins/cache/codex/x.mjs)'",
  "NODE_OPTIONS='--import=data:text/javascript,x' node ~/.claude/plugins/cache/codex/x.mjs",
  "$env:NODE_OPTIONS='--require=evil.js'; node ~/.claude/plugins/cache/codex/x.mjs",
  'node ~/.claude/plugins/cache/ponytail/ponytail/5.3.3/scripts/uninstall.js',
  // A heredoc a program can run is still searched; so is the line that opens it.
  'bash <<EOF\nrm ~/.claude/settings.json\nEOF',
  'cat <<EOF | sh\nrm ~/.claude/settings.json\nEOF',
  'cat <<EOF | xargs rm\n~/.claude/settings.json\nEOF',
  'cat <<EOF | pwsh.exe\nRemove-Item ~/.claude/settings.json\nEOF',
  'node <<EOF\nrequire("fs").rmSync("C:/Users/me/.claude/settings.json")\nEOF',
  'git apply <<EOF\n--- a/C:/Users/me/.claude/settings.json\nEOF',
  'cat <<EOF > ~/.claude/settings.json\n{}\nEOF',
  // Found in Codex review.
  "cat <<EOF\n$(printf '{}' > ~/.claude/settings.json)\nEOF",
  "cat > /tmp/guard-script <<'EOF'\nprintf '{}' > ~/.claude/settings.json\nEOF\nsh /tmp/guard-script",
  "cat <<'EOF' |\nprintf '{}' > ~/.claude/settings.json\nEOF\nsh",
  "cat <<<EOF\nprintf '{}' > ~/.claude/settings.json\nEOF",
  "git -c core.editor=s'h' commit --allow-empty -t /dev/stdin <<'EOF'\nprintf '{}' > ~/.claude/settings.json\nEOF",
  "git commit -F - -e <<'EOF'\nnote ~/.claude/settings.json\nEOF",
  // Found in the Codex confirmation pass.
  "cat <<'EOF' | # comment\nprintf '{}' > ~/.claude/settings.json\nEOF\nsh",
  "git commit --allow-empty -F - -ae <<'EOF'\nprintf '{}' > ~/.claude/settings.json\nEOF",
  "cat <<'EOF' |\nprintf '{}' > ~/.claude/settings.json\nEOF\nenv sh",
  'node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs setup --disable-review-gate',
  'node ~/.claude/plugins/cache/openai-codex/codex/1.0.6/../../../ponytail/ponytail/5.3.3/scripts/codex-companion.mjs',
] as const

// Ordinary work: runs.
const ALLOWED = [
  'cat ~/.claude/settings.json',
  'Get-Content C:\\Users\\me\\.claude\\CLAUDE.md',
  'ls -la ~/.claude',
  'grep -rn deny ~/.claude/settings.json 2>&1',
  'cat ~/.claude/settings.json | jq .permissions > /dev/null',
  'cd C:/repos/guards-live/mods/self-guard && git status && git log --oneline -1',
  'echo hi > notes.txt',
  'rm -rf dist',
  'git pull',
  'echo x > ~/.claude/projects/app/memory/note.md',
  'claude plugin list',
  'claude mcp list',
  'claude plugin marketplace list',
  'claude --version',
  'npm test',
  'cat ~/.claude/settings.json | grep "a>b"',
  'rm -rf .claude-cache',
  'claude -p "plugin install tips"',
  'node "C:/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs" setup --json',
  'cat <<\'EOF\' | node "C:/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs" task --model gpt-6-astra\nreview it\nEOF',
  'grep -n deny ~/.claude/settings.json | cut -c1-80',
  // A heredoc read as data names no path to change.
  "git commit -F - <<'EOF'\ndocs: note that ~/.claude/settings.json is guarded\nEOF",
  "cat <<'EOF' | node \"C:/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs\" task --model gpt-6-astra\nreview what writes ~/.claude/settings.json\nEOF",
  'which codex',
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

      expect(hasRun).toBe(isAllowed)
      expect(/guard failed/.test(JSON.stringify(ran))).toBe(false)
    })
  }
}

test('NODE_OPTIONS in the session environment stops the Codex companion counting as a reader', async ($, on) => {
  mock.env(on, { ...ENV, NODE_OPTIONS: '--require=evil.js' })
  on('session.cwd', () => ({ value: 'C:\\repos\\app' }))
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const command = 'node "C:/Users/me/.claude/plugins/cache/openai-codex/codex/1.0.6/scripts/codex-companion.mjs" setup --json'

  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command }))).toContain('self-guard')
})

test('a writing command run from inside ~/.claude is denied', async ($, on) => {
  world(on, 'C:\\Users\\me\\.claude')
  on('tool.call', { tool: ['Bash'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'echo {} > settings.json' }))).toContain('self-guard')
})

const FILES = [
  ['C:\\Users\\me\\.claude\\settings.json', false],
  ['C:/Users/me/.claude/CLAUDE.md', false],
  ['C:\\Users\\me\\.claude.json', false],
  ['C:\\Users\\me\\.claude\\hooks\\x.ps1', false],
  ['C:\\repos\\guards-live\\mods\\taint-guard-not-loaded\\x.ts', true],
  ['C:\\repos\\guards-live\\mods\\aws-guard\\hooks\\register.ts', false],
  ['.claude\\settings.local.json', false],
  ['C:\\Users\\me\\.claude\\projects\\app\\memory\\MEMORY.md', true],
  ['C:\\Users\\me\\.claude\\plans\\plan.md', true],
  ['C:\\Users\\me\\.claude-notes.md', true],
  ['C:\\repos\\app\\src\\index.ts', true],
  ['C:\\repos\\app\\.claude\\commands\\x.md', true],
  ['\\\\?\\C:\\Users\\me\\.claude\\CLAUDE.md', false],
  ['C:/repos/app/.claude/settings.json.', false],
  ['C:/repos/app/.claude/settings.json::$DATA', false],
] as const

test('a mod folder whose path holds a space is still guarded', async ($, on) => {
  mock.env(on, { ...ENV, CLAUDE_CODE_PLUGIN_DIRS: 'C:/Program Files/guards' })
  on('session.cwd', () => ({ value: 'C:\\repos\\app' }))
  on('tool.call', { tool: ['PowerShell'] }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  const ran = await $.tool.call({ tool: 'PowerShell', command: 'Set-Content "C:/Program Files/guards/hooks/register.ts" x' })

  expect(JSON.stringify(ran)).toContain('self-guard')
})

for (const [file_path, isAllowed] of FILES) {
  test(`Write ${isAllowed ? 'runs' : 'is denied'}: ${file_path}`, async ($, on) => {
    world(on)
    let hasRun = false

    on('tool.call', { tool: ['Write'] }, () => {
      hasRun = true

      return { result: { type: 'create', filePath: file_path } }
    })

    await $.tool.call({ tool: 'Write', file_path, content: '{}' })

    expect(hasRun).toBe(isAllowed)
  })
}
