// Finds where a command line really runs a given program. The same file sits in terraform-guard, aws-guard, model-guard, merged-branch-guard, secret-read-guard and supply-chain-guard: keep the copies identical.

// A command that runs another: its target can sit anywhere after it.
const WRAPPER =
  /^(bash|sh|zsh|dash|ksh|fish|busybox|eval|env|xargs|find|nice|ionice|stdbuf|doas|watch|parallel|chroot|setsid|unbuffer|script|flock|firejail|systemd-run|cmd|powershell|pwsh|wsl|sudo|time|timeout|nohup|winpty|exec|command|call|start|start-process|saps|invoke-expression|iex|invoke-command|icm|coproc|trap|su|runuser|pkexec|runas|sg|unshare|nsenter|taskset|chrt|numactl|strace|ltrace|torsocks|proxychains4?|caffeinate|xvfb-run|dbus-run-session|ssh-agent|fakeroot|tmux|screen|aws-vault|op|doppler|direnv|mise|asdf|dotenv|envchain|nix-shell)(\.exe)?$/i
// What can stand before a command's first word: VAR=x, !, a keyword, a redirection.
const LEAD = /^(\w+=.*|!|if|then|else|elif|do|while|until|\d*[<>].*)$/
const OPERATOR = /^[;|&(){}`\n]$/
// A heredoc: its quote (a quoted tag keeps $( ) in the body unexpanded), tag, and the rest of the opening line with the body.
// <<< is a here-string, not one. A tag that goes on past its quote (<<"EO"F) ends at another line than \2 finds: not taken as one.
export const HEREDOC = /(?<!<)<<(?!<)-?\s*(["']?)(\w+)\1(?![\w"'\\])([\s\S]*?)\n\s*\2\b/g
// A shell named on a heredoc's opening line, or piped the heredoc after its end, reads the body as its script: bash <<EOF,
// cat <<EOF | sh, and cat <<EOF | ... EOF sh.
const SHELL = /(^|[\s;|&(\\/"'])(bash|sh|zsh|dash|ksh|fish|pwsh|powershell)(\.exe)?(?=[\s;|&)"']|$)/i
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`\n]*)`/
// A word (quoted runs and ${VAR} kept whole), or one operator that ends a command. A brace is one: a group, or a PowerShell script block.
const TOKEN = /(?:"(?:\\.|[^"\\])*"|'[^']*'|>&|\$\{[^}]*\}|[^\s"';|&(){}`])+|[;|&(){}`\n]/g

// PowerShell drops a backtick inside a word (terraf`orm is terraform) where bash would start a substitution.
const ESCAPE = /(?<=\w)`(?=[a-z])/gi

// bash's $'...' and $"..." quote too: $'terraform' is terraform.
// shortcut: escapes inside $'...' ($'\x74erraform') are not decoded; decode them if one is seen in use.
const unquote = (word: string) => word.replace(/\$(?=["'])/g, '').replace(/["']/g, '')

// bash drops a backslash in a program's name (\terraform, terr\aform); only the name, as a C:\ path or a pattern argument keeps its own.
const isNamed = (word: string, binary: RegExp) => binary.test(word) || binary.test(word.replace(/\\(?=[\w-])/g, ''))

// A wrapper counts by its name wherever it is installed: /bin/bash, /usr/bin/env, C:\...\pwsh.exe.
const WRAPPER_NAME = new RegExp(String.raw`^(.*[\\/])?${WRAPPER.source.slice(1)}`, 'i')

// Redirections (2>&1, >file, > file) are not arguments of the program.
const withoutRedirections = (words: readonly string[]) =>
  words.filter(
    (word, i) => !/^\d*[<>]/.test(word) && !/^\d*[<>]+&?$/.test(words[i - 1] ?? ''),
  )

// shortcut: no variable or alias expansion, and a heredoc body is read only for its substitutions, unless a shell on its opening line or
// piped to after its end reads it all; a body saved to a file and run later is not followed; it errs toward finding a call, so `echo '$(prog …)'` and `bash -c echo prog …` count as calls; cost grows with the square of the number of substitutions. Upgrade to a real shell parser if any of these bites.
/** The argument list of every call to `binary` in `source`, wrappers, subshells and substitutions included. */
export const invocations = (source: string, binary: RegExp, depth = 0): string[][] => {
  const found: string[][] = []

  if (depth > 4) {
    return found
  }

  // Read it every way a shell could, so any shell's call is found: PowerShell drops a backtick in a word, bash expands a brace
  // list where a command starts ({terraform,apply}), and a comment ends at its line even when a \ or ` ends it.
  const variants = [
    source.replace(ESCAPE, ''),
    source.replace(/(^|[;|&(\n])(\s*)\{([^\s{}]*,[^\s{}]*)\}(?=[\s;|&)]|$)/g, (_, op: string, space: string, list: string) => `${op}${space}${list.replace(/,/g, ' ')}`),
    source.replace(/[\\`]\r?\n/g, '\n'),
  ]

  for (const variant of new Set(variants)) {
    if (variant !== source) {
      found.push(...invocations(variant, binary, depth + 1))
    }
  }

  // Line continuations join (bash's \ leaves nothing behind, so a split word is whole again); heredoc bodies are data unless a shell runs them.
  let text = source
    .replace(/\\\r?\n/g, '')
    .replace(/`\r?\n/g, ' ')
    .replace(HEREDOC, (match: string, quote: string, _tag: string, rest: string, at: number, whole: string) => {
      const before = whole.slice(whole.lastIndexOf('\n', at) + 1, at)

      // A << inside quotes, a comment or arithmetic (echo '<<EOF', ;# <<EOF, $((1<<2))) starts no heredoc: the lines after it run.
      // shortcut: a quote opened on an earlier line is not seen; track quotes across lines if one is used that way.
      if ((before.match(/'/g) ?? []).length % 2 === 1 || (before.match(/"/g) ?? []).length % 2 === 1 || /(^|[\s;|&(])#|\(\([^)]*$/.test(before)) {
        return match
      }

      // A comment on the opening line (cat > x.sh <<EOF # bash script) names no shell.
      const opening = `${before} ${rest.split('\n')[0]}`.replace(/(^|\s)#.*$/, '')
      // The whole line after the end, so a wrapped shell (env sh) counts too.
      const pipedTo = /\|\s*$/.test(opening) ? (whole.slice(at + match.length).trim().split('\n')[0] ?? '') : ''
      const body = rest.includes('\n') ? rest.slice(rest.indexOf('\n') + 1) : ''

      if (SHELL.test(opening) || SHELL.test(pipedTo)) {
        found.push(...invocations(body, binary, depth + 1))
      } else if (!quote) {
        // An unquoted body runs its substitutions wherever it goes, innermost first as below: cat <<EOF $(terraform apply) EOF.
        let left = body

        for (let one = SUBSTITUTION.exec(left); one !== null; one = SUBSTITUTION.exec(left)) {
          found.push(...invocations(one[1] ?? one[2] ?? '', binary, depth + 1))
          left = left.replace(one[0], ' ')
        }
      }

      // The body goes, but the rest of the opening line stays: cat <<EOF | terraform apply runs terraform.
      return rest.split('\n')[0] ?? ''
    })

  // A substitution runs its body wherever it sits, inside double quotes too.
  for (let body = SUBSTITUTION.exec(text); body !== null; body = SUBSTITUTION.exec(text)) {
    found.push(...invocations(body[1] ?? body[2] ?? '', binary, depth + 1))
    text = text.replace(body[0], ' ')
  }

  const commands: string[][] = [[]]
  let isComment = false

  for (const token of text.match(TOKEN) ?? []) {
    // A word that starts with # starts a comment to the end of its line: `terraform apply # deploy` passes no plan.
    if (isComment && token !== '\n') {
      continue
    }

    isComment = token.startsWith('#')

    if (isComment) {
      continue
    }

    if (OPERATOR.test(token)) {
      commands.push([])
    } else {
      commands.at(-1)?.push(token)
    }
  }

  for (const raw of commands) {
    let from = 0

    while (from < raw.length && LEAD.test(raw[from] ?? '')) {
      // A bare redirection takes the next word as its target.
      from += /^\d*[<>]+&?$/.test(raw[from] ?? '') ? 2 : 1
    }

    const words = withoutRedirections(raw.slice(from)).map(unquote)

    if (isNamed(words[0] ?? '', WRAPPER_NAME)) {
      // A quoted argument of a wrapper is a command line of its own, an option's attached one too (su --command="...").
      for (const word of words.slice(1).filter(one => /\s/.test(one))) {
        found.push(...invocations(word.replace(/^--?[\w-]+=/, ''), binary, depth + 1))
      }

      const at = words.findIndex((word, i) => i > 0 && isNamed(word, binary))

      if (at > 0) {
        found.push(words.slice(at + 1).flatMap(word => word.split(/[\s,]+/)).filter(Boolean))
      }
    } else if (isNamed(words[0] ?? '', binary)) {
      found.push(words.slice(1))
    }
  }

  return found
}
