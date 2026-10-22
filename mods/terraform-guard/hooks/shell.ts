// Finds where a command line really runs a given program. The same file sits in terraform-guard, aws-guard and tf-reminder: keep the copies identical.

// A command that runs another: its target can sit anywhere after it.
const WRAPPER =
  /^(bash|sh|zsh|eval|env|xargs|find|cmd|powershell|pwsh|wsl|sudo|time|timeout|nohup|winpty|exec|command|call|start|start-process|saps|invoke-expression|iex|invoke-command|icm)(\.exe)?$/i
// What can stand before a command's first word: VAR=x, !, a keyword, a redirection.
const LEAD = /^(\w+=.*|!|if|then|else|elif|do|while|until|\d*[<>].*)$/
const OPERATOR = /^[;|&(){}`\n]$/
const HEREDOC = /<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1\b/g
const SUBSTITUTION = /\$\(([^()]*)\)|`([^`\n]*)`/
// A word (quoted runs and ${VAR} kept whole), or one operator that ends a command. A brace is one: a group, or a PowerShell script block.
const TOKEN = /(?:"(?:\\.|[^"\\])*"|'[^']*'|>&|\$\{[^}]*\}|[^\s"';|&(){}`])+|[;|&(){}`\n]/g

const unquote = (word: string) => word.replace(/["']/g, '')

// Redirections (2>&1, >file, > file) are not arguments of the program.
const withoutRedirections = (words: readonly string[]) =>
  words.filter(
    (word, i) => !/^\d*[<>]/.test(word) && !/^\d*[<>]+&?$/.test(words[i - 1] ?? ''),
  )

// shortcut: no variable or alias expansion, and heredoc bodies are skipped (a script fed to a shell that way is not read); it errs toward finding a call, so `echo '$(prog …)'` and `bash -c echo prog …` count as calls; cost grows with the square of the number of substitutions. Upgrade to a real shell parser if any of these bites.
/** The argument list of every call to `binary` in `source`, wrappers, subshells and substitutions included. */
export const invocations = (source: string, binary: RegExp, depth = 0): string[][] => {
  const found: string[][] = []

  if (depth > 4) {
    return found
  }

  // Line continuations join (bash's \ leaves nothing behind, so a split word is whole again); heredoc bodies are data.
  let text = source.replace(/\\\r?\n/g, '').replace(/`\r?\n/g, ' ').replace(HEREDOC, '')

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

    // A wrapper counts by its name wherever it is installed: /bin/bash, /usr/bin/env, C:\...\pwsh.exe.
    if (WRAPPER.test((words[0] ?? '').replace(/^.*[\\/]/, ''))) {
      // A quoted argument of a wrapper is a command line of its own.
      for (const word of words.slice(1).filter(one => /\s/.test(one))) {
        found.push(...invocations(word, binary, depth + 1))
      }

      const at = words.findIndex((word, i) => i > 0 && binary.test(word))

      if (at > 0) {
        found.push(words.slice(at + 1).flatMap(word => word.split(/[\s,]+/)).filter(Boolean))
      }
    } else if (binary.test(words[0] ?? '')) {
      found.push(words.slice(1))
    }
  }

  return found
}
