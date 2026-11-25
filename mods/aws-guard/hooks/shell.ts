// Finds where a command line really runs a given program. The same file sits in aws-guard, secret-read-guard, supply-chain-guard
// and terraform-guard: keep the copies identical.
//
// What a guard gets:
// - invocations(source, binary): the argument list of every call to `binary`. It THROWS Unreadable when the line cannot be read
//   (over 64 KB, nested too deeply, too costly to read), so a guard that does not catch it denies through its own .catch.
// - unreadable(source): the reason invocations would throw, or undefined; for a guard that wants to say why it denies.
// - DYNAMIC: the last argument of a call whose arguments are not all written out: a $( ), ` `, PowerShell ( ) or brace sequence
//   stood among them, so the shell can add any word there. A guard that reads flags or positions must deny a call it would deny
//   with any word added.
// - invocations(source, binary, true): the same calls with DYNAMIC where each such word stood, not at the end, and a NUL left in a
//   word a quoted substitution is part of ("$(x)" is one word), for a guard that must know what stands before the unread word. A
//   DYNAMIC at the end is one that stood before the program (sudo $(x) prog).
// - namedByShell(source): the argument list of every call whose program the shell names, which invocations cannot match by name:
//   a word with a variable in it ($NPM, ${NPM}, $env:NPM, "$NPM", $NPM.exe, $A$B) or a substitution ($(which npm), "$(x)", ` `),
//   first or as the first such word after a wrapper (sudo $NPM install x, env $(x) prog, env PATH=$P prog). Each list is in invocations(source, binary, true)'s form, the program
//   word itself left out: `$NPM install x` gives ['install', 'x'], `sudo $(x) terraform plan` ['terraform', 'plan']. Throws Unreadable.
//   invocations is unchanged: it still passes over a variable first and takes the next word as the program.

// A command that runs another: its target can sit anywhere after it.
const WRAPPER =
  /^(bash|sh|zsh|dash|ksh|fish|busybox|eval|env|xargs|find|nice|ionice|stdbuf|doas|watch|parallel|chroot|setsid|unbuffer|script|flock|firejail|systemd-run|cmd|powershell|pwsh|wsl|sudo|time|timeout|nohup|winpty|exec|command|call|start|start-process|saps|invoke-expression|iex|invoke-command|icm|coproc|trap|su|runuser|pkexec|runas|sg|unshare|nsenter|taskset|chrt|numactl|strace|ltrace|torsocks|proxychains4?|caffeinate|xvfb-run|dbus-run-session|ssh-agent|fakeroot|tmux|screen|aws-vault|op|doppler|direnv|mise|asdf|dotenv|envchain|nix-shell)(\.exe)?$/i
// What can stand before a command's first word: VAR=x, !, a keyword, a redirection, PowerShell's dot call and `$out =`.
const LEAD = /^(\w+=.*|!|\.|if|then|else|elif|do|while|until|\d*[<>].*|(\[[^\]]*\])*\$[\w:.{}[\]]*|[-+*/%]?=)$/
// PowerShell's assignment written as one word: $out=terraform runs terraform.
const ASSIGNED = /^(?:\[[^\]]*\])*\$[\w:.{}]+[-+*/%]?=(.+)$/s
// A heredoc's opening: its quote (a quoted tag keeps $( ) in the body unexpanded) and tag. <<< is a here-string, not one. A tag
// that goes on past its quote (<<"EO"F) ends at another line than the tag finds: not taken as one.
const OPENER = /<<(?!<)-?[ \t]*(["']?)(\w+)\1(?![\w"'\\])/y
// A shell named on a heredoc's opening line, or piped the heredoc after its end, reads the body as its script: bash <<EOF,
// cat <<EOF | sh, and cat <<EOF | ... EOF sh.
// source and . read it too where they are the program (. /dev/stdin <<EOF, not cp x . <<EOF or cat > source <<EOF), after
// VAR=x, a redirection, builtin, a wrapper (command, eval, exec, sudo, time, coproc), !, {, a keyword (if, then, do, while) and
// their flags, at the line's start or after ; | & ( or ) (case x in x) source, f() { source). Matched against the line as
// written and with its quotes and backslashes gone, as the shell drops them from a name (sou""rce, b\ash).
const SHELL = /(^|[\s;|&(\\/"'])(bash|sh|zsh|dash|ksh|fish|pwsh|powershell)(\.exe)?(?=[\s;|&)"']|$)/i
// A redirection is one word (2>/dev/null, <<<x) or a bare one and its target (2> /dev/null); the target is never a redirection
// itself (2> 2>). Each word is taken once, by the first way that reads it ((?=(...))\2 does not backtrack): a target that also
// reads as a word of its own (2> -x, 2> time) would otherwise double the work for each one.
const SOURCE_LINE = new RegExp(
  String.raw`(^|[;|&()])\s*(?:(?=((?:\w+=\S*|\d*[<>]+&?[ \t]+(?!\d*[<>])[^\s;|&]+|\d*[<>][^\s;|&]*|builtin|${WRAPPER.source.slice(1, -1)}|!|\{|if|then|else|elif|do|while|until|-[\w-]*)\s+))\2)*(source|\.)(?=\s)`,
)
const readsHeredoc = (line: string) => [line, line.replace(/\$?["']|\\/g, '')].some(one => SHELL.test(one) || SOURCE_LINE.test(one))
// A function or alias defined anywhere in the command (f() { source /dev/stdin; }, function f { . x; }, alias s='bash') whose
// call can read its input as a script: then every heredoc, here-string and pipe in the command is read as one. A guess toward
// reading: any definition and any source, ., eval, read, xargs or shell word anywhere count, as the body is not matched to the call.
const DEFINES = /\w\s*\(\s*\)|\bfunction\s|\b(alias|set-alias|new-alias|sal|nal)\s/i
const SOURCE_WORD = /(^|[\s;&|({=])(source|\.|eval|read|xargs|parallel|iex|invoke-expression)(?=[\s;&|)}]|$)/i
const definesReader = (source: string) =>
  [source, source.replace(/\$?["']|\\/g, '')].some(one => DEFINES.test(one) && (SOURCE_WORD.test(one) || SHELL.test(one)))
// A program that reads its input as commands: what is piped to it is a command line (echo "prog ..." | bash).
const READER = /^(.*[\\/])?(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd|iex|invoke-expression)(\.exe)?$/i
// bash's builtins that run a file as a script, piped input too (echo "prog ..." | source /dev/stdin): only as the program word,
// after builtin or command and their flags if any.
const SOURCER = /^(source|\.)$/
const BUILTIN = /^(builtin|command|--|-[a-zA-Z]+)$/
// Wrappers that add words from their input to the call: what they run has arguments the shell fills in (echo apply | xargs prog),
// named on their own or inside a script a wrapper runs (sh -c 'xargs "$@"' sh prog).
const FEEDER = /(^|[\s;&|(`'"\\/])(xargs|parallel)(\.exe)?(?=[\s;&|)`'"]|$)/i
const FEEDER_NAME = /^(.*[\\/])?(xargs|parallel)(\.exe)?$/i
// xargs and parallel options that take the next word as their value when it is not attached (-n 2, -P4), BSD's -J and -R included.
const VALUED = 'adELnPsRSjN'

// Whether `list` runs source or . : first, or after wrappers, builtin, command, their flags, VAR=x, a redirection and its target
// and the like (eval source x, 2> /dev/null source x).
const sources = (list: readonly string[]) => {
  const at = list.findIndex(word => SOURCER.test(word))

  return (
    at >= 0 &&
    list
      .slice(0, at)
      .every((word, i) => BUILTIN.test(word) || WRAPPER_NAME.test(word) || LEAD.test(word) || /^\d*[<>]+[&|]?$/.test(list[i - 1] ?? ''))
  )
}

// More replacement strings than this, or one we cannot read, and every word after the program counts as replaced: it bounds
// the work too.
const MOST_REPLACED = 8

// The strings xargs or parallel replace with their input wherever they stand in what runs after them, read generously so a
// misread marks more, never fewer: -I, -J, -i, any long option naming replace or a prefix of it (--replace, --rep,
// --extensionreplace) and every long option of parallel's give their attached value, its words and the next word, and -i and
// --replace {} too; parallel replaces {} always. Options are read up to the
// program; a long one without = may take the next word as its value, so that word is passed over too.
// shortcut: parallel's other replacement strings ({.}, {/}, {1}) are caught by its { alone.
// Also where the program stands: the words before it are the options' own (-I{} is not the input's).
const replacements = (words: readonly string[]): { found: string[]; program: number } => {
  const found: string[] = []
  let program = words.length
  // A feeder among the words an earlier one's options already read (xargs -a xargs -a ...) is not read again: linear work.
  let read = 0

  words.forEach((feeder, at) => {
    if (at < read || !FEEDER_NAME.test(feeder)) {
      return
    }

    const isParallel = /parallel/i.test(feeder)

    if (isParallel) {
      found.push('{')
    }

    let i = at + 1

    for (; i < words.length; i++) {
      const word = words[i] ?? ''

      if (word === '--') {
        i++
        break
      }

      if (!/^-./.test(word)) {
        break
      }

      if (word.startsWith('--')) {
        const [, name = '', value] = /^--([^=]*)(?:=([\s\S]*))?$/.exec(word) ?? []
        // Both take any unique prefix of a long option (--rep, --r are xargs' --replace); parallel has too many options that set
        // a replacement string (--er, --bnr, --rpl 'tag perl') to tell apart, so every value of its long options counts.
        const isReplace = isParallel || /replace/i.test(name) || 'replace'.startsWith(name.toLowerCase())
        const taken = (one: string) => (isReplace ? [one, ...one.split(/\s+/)] : [])

        if (isReplace) {
          found.push(...taken(value || '{}'))
        }

        if (value === undefined && !/^-/.test(words[i + 1] ?? '-')) {
          found.push(...taken(words[i + 1] ?? ''))
          i++
        }

        continue
      }

      for (let k = 1; k < word.length; k++) {
        const letter = word[k] ?? ''
        const rest = word.slice(k + 1)

        if (letter === 'I' || letter === 'J') {
          found.push(rest || (words[++i] ?? ''))
          break
        }

        // -i takes an attached value in xargs and the next word in parallel: both are taken, the next word left in place.
        if (letter === 'i') {
          found.push(rest || '{}', rest ? '' : (words[i + 1] ?? ''))
          break
        }

        if (VALUED.includes(letter)) {
          i += rest ? 0 : 1
          break
        }

        // -e and -l take an attached value only.
        if (letter === 'e' || letter === 'l') {
          break
        }
      }
    }

    // The first feeder's program: a later feeder's options stand in its arguments, which are marked anyway.
    program = Math.min(program, i)
    read = i
  })

  return { found: found.filter(Boolean), program }
}

// A wrapper counts by its name wherever it is installed: /bin/bash, /usr/bin/env, C:\...\pwsh.exe.
const WRAPPER_NAME = new RegExp(String.raw`^(.*[\\/])?${WRAPPER.source.slice(1)}`, 'i')

/** Thrown for a command line the parser cannot read. A guard must deny it. */
export class Unreadable extends Error {}
export const DYNAMIC = '-\u0000'

const MOST = 65_536
const DEEPEST = 8
// Characters read in all, over every reading and nested command line: what stops a line built to be slow.
const WORK = 1 << 24
// Stand-ins for an unquoted { } and , while a word is put together: Unicode noncharacters, refused in the input.
const OPEN = '\uFDD0'
const CLOSE = '\uFDD1'
const COMMA = '\uFDD2'
const PAIR = new RegExp(`${OPEN}([^${OPEN}${CLOSE}]*)${CLOSE}`)
// bash's {a..c} and {1..9..2}: the words it stands for are not worked out, it is marked like a substitution.
const SEQUENCE = new RegExp(`${OPEN}(?:-?\\d+\\.\\.-?\\d+|[A-Za-z]\\.\\.[A-Za-z])(?:\\.\\.-?\\d+)?${CLOSE}`, 'g')
// The escapes bash decodes inside $'...'.
const ANSI = /\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|c[\s\S]|[\s\S])/g
const NAMED: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }

// The line is read once as each shell would, and a call found by any reading counts. They differ in the character that escapes
// the next one (terraf`orm, terr\aform and terr^aform are terraform to one shell each), and: bash expands a brace list
// (-{auto-approve,x}) and runs ` `; PowerShell drops <# #> and takes ( ) as an argument; cmd has no # comment.
type Shell = 'bash' | 'powershell' | 'cmd'
const ESCAPE: Record<Shell, string> = { bash: '\\', powershell: '`', cmd: '^' }

// isAnsi: whether this reading takes $'...' as bash does. A shell without it (an older dash) reads a $ and plain quotes, and a \'
// closes there what it does not close in bash, so a line that holds one is read both ways.
// isReader: the whole command defines a function or alias that may read its input as a script (definesReader).
type State = { left: number; seen: Map<string, string[][]>; isAnsi: boolean; isReader: boolean }
// dynamic: how many words stood before each substitution, PowerShell ( ) or brace sequence in the command.
type Command = { raw: string[]; words: string[]; dynamic: number[]; isPiped: boolean }

const spend = (state: State, cost: number) => {
  state.left -= cost

  if (state.left < 0) {
    throw new Unreadable('the command is too complex to read')
  }
}

const unclosed = () => new Unreadable('a ${ } in the command is never closed')

// Where bash's ${ } that starts at `at` ends: a } quoted or nested in it does not end it (${a:-"}"}, ${a:-${b}}, ${a:-$(echo })}).
// Inside double quotes a ' in it quotes or not by bash version, so that line is refused, not guessed; so is one never closed.
const braceEnd = (text: string, at: number, state: State, isQuoted: boolean, depth = 0): number => {
  if (depth > DEEPEST) {
    throw new Unreadable('the command nests too deeply to read')
  }

  let end = at + 2

  while (end < text.length && text[end] !== '}') {
    const char = text[end]

    if (char === "'" && isQuoted) {
      throw new Unreadable("a ' inside a quoted ${ } cannot be read")
    }

    const next =
      char === '\\'
        ? end + 2
        : char === '$' && text[end + 1] === '{'
          ? braceEnd(text, end, state, isQuoted, depth + 1)
          : char === '$' && text[end + 1] === '('
            ? parenEnd(text, end + 1, state, depth + 1)
            : char === '$' && text[end + 1] === "'" && state.isAnsi && !isQuoted
              ? skip(text, end, 'bash', state, depth + 1)
              : char === '"'
                ? skip(text, end, 'bash', state, depth + 1)
                : char === "'" || char === '`'
                  ? text.indexOf(char, end + 1) + 1
                  : end + 1

    if (next <= end) {
      throw unclosed()
    }

    end = next
  }

  if (end >= text.length) {
    throw unclosed()
  }

  spend(state, end - at)

  return end + 1
}

// Where the $( ) whose ( stands at `at` ends, read for braceEnd: quotes and nested ( ) and ${ } in it.
const parenEnd = (text: string, at: number, state: State, depth: number): number => {
  let open = 0

  for (let end = at; end < text.length; ) {
    const char = text[end]

    if (char === '(' || char === ')') {
      open += char === '(' ? 1 : -1

      if (open === 0) {
        spend(state, end - at)

        return end + 1
      }
    }

    const next =
      char === '\\'
        ? end + 2
        : char === '$' && text[end + 1] === '{'
          ? braceEnd(text, end, state, false, depth + 1)
          : char === '"' || (char === '$' && text[end + 1] === "'" && state.isAnsi)
            ? skip(text, end, 'bash', state, depth + 1)
            : char === "'"
              ? text.indexOf("'", end + 1) + 1
              : end + 1

    if (next <= end) {
      throw unclosed()
    }

    end = next
  }

  throw unclosed()
}

// Where the quoted run, escaped character or ${VAR} that starts at `at` ends; `at` itself when none starts there (an open quote too).
const skip = (text: string, at: number, shell: Shell, state: State, depth = 0): number => {
  const char = text[at]

  if (char === ESCAPE[shell] && at + 1 < text.length) {
    return at + (text.startsWith('\r\n', at + 1) ? 3 : 2)
  }

  // $$ is one word of its own: the quote after it is a plain one ($$'a\' ends at the \').
  if (shell === 'bash' && char === '$' && text[at + 1] === '$') {
    return at + 2
  }

  // bash's $'...' ends at the first ' no backslash escapes.
  if (shell === 'bash' && state.isAnsi && char === '$' && text[at + 1] === "'") {
    let end = at + 2

    while (end < text.length && text[end] !== "'") {
      end += text[end] === '\\' ? 2 : 1
    }

    spend(state, end - at)

    return end < text.length ? end + 1 : at
  }

  if (shell === 'bash' && char === '$' && text[at + 1] === '{') {
    return braceEnd(text, at, state, false, depth)
  }

  // bash's double quotes: a ${ } in them is read whole ("${a:-"}"}" is one word).
  if (shell === 'bash' && char === '"') {
    let end = at + 1

    while (end < text.length && text[end] !== '"') {
      end = text[end] === '\\' ? end + 2 : text[end] === '$' && text[end + 1] === '{' ? braceEnd(text, end, state, true, depth) : end + 1
    }

    spend(state, end - at)

    return end < text.length ? end + 1 : at
  }

  if (char === "'" || (char === '$' && text[at + 1] === '{')) {
    const end = text.indexOf(char === "'" ? "'" : '}', at + 1)

    spend(state, end < 0 ? text.length - at : 0)

    return end < 0 ? at : end + 1
  }

  if (char === '"') {
    let end = at + 1

    // cmd's ^ escapes nothing inside double quotes.
    while (end < text.length && text[end] !== '"') {
      end += shell !== 'cmd' && text[end] === ESCAPE[shell] ? 2 : 1
    }

    spend(state, end - at)

    return end < text.length ? end + 1 : at
  }

  return at
}

// PowerShell's block comment. One never closed is left in.
const withoutBlocks = (text: string) => {
  let out = ''
  let at = 0

  for (let open = text.indexOf('<#'); open >= 0; open = text.indexOf('<#', at)) {
    const close = text.indexOf('#>', open + 2)

    if (close < 0) {
      break
    }

    out += `${text.slice(at, open)} `
    at = close + 2
  }

  return out + text.slice(at)
}

// Hands the body of every $( ) and, where the shell has them, ` ` to `nested`, innermost first, and leaves a NUL where each stood:
// what it puts there is not known.
// shortcut: quotes and escapes are not read here, so '$(prog)' and \$(prog) count as calls; read them if that bites.
// shortcut: a case inside $( ) is refused, not read: its pattern's ) would end the substitution early and hide the rest
// ($(case x in a) prog ;; esac)). Read the case if that bites.
const CASE = /(^|[\s;&|({])case\s[\s\S]*?\sin(\s|$)/
const substitute = (text: string, hasBackticks: boolean, nested: (body: string) => void): string => {
  const outer: [string, boolean][] = []
  let out = ''

  for (let at = 0; at < text.length; at++) {
    const char = text[at]

    if (char === '$' && text[at + 1] === '(') {
      outer.push([out, true])
      out = ''
      at++
    } else if (char === '(') {
      outer.push([out, false])
      out = ''
    } else if (char === ')' && outer.length > 0) {
      const [before, isSubstitution] = outer.pop() ?? ['', false]

      if (isSubstitution) {
        if (CASE.test(out)) {
          throw new Unreadable('a case inside $( ) cannot be read')
        }

        nested(out)
        out = `${before}\0 `
      } else {
        out = `${before}(${out})`
      }
    } else if (char === '`' && hasBackticks) {
      let end = at + 1

      while (end < text.length && text[end] !== '`' && text[end] !== '\n') {
        end++
      }

      if (text[end] === '`') {
        nested(text.slice(at + 1, end))
        out += '\0 '
        at = end
      } else {
        out += char
      }
    } else {
      out += char
    }
  }

  // One never closed is no substitution: its text stays.
  for (let open = outer.pop(); open !== undefined; open = outer.pop()) {
    out = `${open[0]}${open[1] ? '$(' : '('}${out}`
  }

  return out
}

// Takes out comments and heredoc bodies, read left to right with the quotes, so a quote in a comment opens nothing and a << in
// quotes, a comment or arithmetic (echo '<<EOF', ;# <<EOF, $((1<<2))) starts no heredoc. A body is data unless a shell runs it.
const cut = (text: string, shell: Shell, state: State, nested: (body: string) => void): string => {
  const waiting: [string, string][] = []
  let out = ''
  let lineAt = 0
  let isWordStart = true
  let isArithmetic = false

  for (let at = 0; at < text.length; ) {
    const end = skip(text, at, shell, state)

    if (end > at) {
      out += text.slice(at, end)
      at = end
      isWordStart = false
      continue
    }

    const char = text[at] ?? ''

    // A # where a word starts runs to the end of its line, whatever ends the line. A substitution in it still counts, as it did.
    if (char === '#' && isWordStart && shell !== 'cmd') {
      const line = text.indexOf('\n', at)
      const stop = line < 0 ? text.length : line

      substitute(text.slice(at, stop), shell === 'bash', nested)
      at = stop
      continue
    }

    OPENER.lastIndex = at
    const opener = char === '<' && text[at - 1] !== '<' && !isArithmetic ? OPENER.exec(text) : null

    if (opener !== null) {
      waiting.push([opener[1] ?? '', opener[2] ?? ''])
      at += opener[0].length
      isWordStart = false
      continue
    }

    if (char === '\n' && waiting.length > 0) {
      // The opening line as it runs: comments and the << tags gone, so a tag named SH names no shell.
      const opening = out.slice(lineAt)
      let from = at
      let resume = at

      for (const [quote, tag] of waiting.splice(0)) {
        // The body ends at the first line that starts with the tag: never later than bash ends it, so no command hides in a body.
        const close = new RegExp(`^[ \\t]*${tag}\\b`, 'gm')
        close.lastIndex = from + 1
        const ends = close.exec(text)

        spend(state, (ends?.index ?? text.length) - from)

        // No end line: no heredoc, and the lines after it run.
        if (ends === null) {
          continue
        }

        const body = text.slice(from + 1, Math.max(from + 1, ends.index - 1))
        let after = ends.index + ends[0].length

        resume = after

        while (/\s/.test(text[after] ?? '')) {
          after++
        }

        spend(state, after - resume)
        // The whole line after the end, so a wrapped shell (env sh) counts too.
        const lineEnd = text.indexOf('\n', after)
        const pipedTo = opening.trimEnd().endsWith('|') ? text.slice(after, lineEnd < 0 ? text.length : lineEnd) : ''

        if (state.isReader || readsHeredoc(opening) || readsHeredoc(pipedTo)) {
          nested(body)
        } else if (!quote) {
          // An unquoted body runs its substitutions wherever it goes: cat <<EOF $(terraform apply) EOF.
          substitute(body, true, nested)
        }

        const next = text.indexOf('\n', resume)
        from = next < 0 ? text.length : next
      }

      // The bodies go, and what follows the last end line joins the opening line: cat <<EOF | ... EOF sh.
      if (resume > at) {
        at = resume
        continue
      }
    }

    out += char

    if (char === '\n') {
      lineAt = out.length
      isArithmetic = false
    } else if (char === ')') {
      isArithmetic = false
    } else if (char === '(' && text[at + 1] === '(') {
      isArithmetic = true
    }

    isWordStart = ' \t\r\n;|&(){}'.includes(char)
    at++
  }

  return out
}

// What bash makes of the inside of $'...': \x2d, \055 and \u002d are all a dash.
const decode = (inner: string) =>
  inner
    .replace(ANSI, (_, code: string) =>
      /^[xuU]./.test(code)
        ? String.fromCodePoint(parseInt(code.slice(1), 16))
        : /^[0-7]/.test(code)
          ? String.fromCharCode(parseInt(code, 8) & 0xff)
          : code.length > 1
            ? String.fromCharCode(code.charCodeAt(1) & 31)
            : (NAMED[code] ?? (/[\\'"?]/.test(code) ? code : `\\${code}`)),
    )
    // A decoded character must not pass for one of the parser's own marks.
    .replace(/[\0\uFDD0-\uFDD2]/g, '\uFFFD')

// Every word a brace list stands for, as bash expands it: -{a,b} is -a -b. A pair with no comma inside is no list, and bash
// leaves its braces as written: {-a,-var={x}} is -a -var={x}.
const expand = (word: string, state: State, out: string[] = []): string[] => {
  const pair = PAIR.exec(word)

  spend(state, word.length + 1)

  if (pair === null) {
    out.push(word)
  } else {
    const inner = pair[1] ?? ''

    for (const one of inner.includes(COMMA) ? inner.split(COMMA) : [`{${inner}}`]) {
      expand(word.slice(0, pair.index) + one + word.slice(pair.index + pair[0].length), state, out)
    }
  }

  return out
}

// The commands of a line, each as its words: raw as written (to tell a quoted `>` from a redirection) and as the shell hands them
// on, quotes and escapes gone. ; | & and a newline end a command, and so do ( ) ` and a brace that is no list: a group, or a
// PowerShell script block.
const lex = (text: string, shell: Shell, state: State): Command[] => {
  const blank = (): Command => ({ raw: [], words: [], dynamic: [], isPiped: false })
  let command = blank()
  const commands = [command]
  let raw = ''
  let word = ''
  let isOpen = false

  const endCommand = (isPiped: boolean) => {
    // Nothing between a pipe and a & or a line end (|& prog, a | at the end of a line): the pipe goes on to the next command.
    if (!isPiped && command.raw.length === 0 && commands.at(-2)?.isPiped === true) {
      return
    }

    command.isPiped = isPiped
    command = blank()
    commands.push(command)
  }

  const endWord = () => {
    if (!isOpen) {
      return
    }

    const [written, cooked] = [raw, word]

    raw = ''
    word = ''
    isOpen = false

    if (!cooked.includes(OPEN) && !cooked.includes(CLOSE)) {
      command.raw.push(written)
      command.words.push(cooked.replaceAll(COMMA, ','))
      return
    }

    const listed = shell === 'bash' ? cooked.replace(SEQUENCE, '\0') : cooked

    if (listed !== cooked) {
      command.dynamic.push(command.words.length)
    }

    for (const one of shell === 'bash' ? expand(listed, state) : [cooked]) {
      for (const part of one.replaceAll(COMMA, ',').split(new RegExp(`([${OPEN}${CLOSE}])`))) {
        if (part === OPEN || part === CLOSE) {
          endCommand(false)
        } else if (part !== '') {
          command.raw.push(part)
          command.words.push(part)
        }
      }
    }
  }

  for (let at = 0; at < text.length; at++) {
    const end = skip(text, at, shell, state)
    const char = text[at] ?? ''

    if (end > at) {
      const part = text.slice(at, end)
      const inner = part.slice(1, -1)

      if (char === ESCAPE[shell] && /[\r\n]/.test(part[1] ?? '')) {
        // A line continuation: bash's leaves nothing behind (a split word is whole again), PowerShell's is a space.
        if (shell === 'powershell') {
          endWord()
        }
      } else {
        isOpen = true
        raw += part
        word +=
          char === ESCAPE[shell]
            ? part.slice(1)
            : part.startsWith("$'")
              ? decode(part.slice(2, -1))
              : char === "'"
              ? inner
              : char === '$'
                ? part
                : shell === 'bash'
                  ? inner.replace(/\\(["\\$`]|\r?\n)/g, (_, kept: string) => (/\n/.test(kept) ? '' : kept))
                  : shell === 'powershell'
                    ? inner.replace(/`([\s\S])/g, '$1')
                    : inner
      }

      at = end - 1
    } else if ((char === '&' || char === '|') && isOpen && text[at - 1] === '>' && text[at - 2] !== ESCAPE[shell]) {
      // 2>&1 is one word, and so is >|out. An escaped > is no redirection: echo \>| prog pipes to prog.
      raw += char
      word += char
    } else if (char === '\n' || char === ';' || char === '|') {
      endWord()
      endCommand(char === '|')
    } else if (char === '(' || char === ')') {
      endWord()

      // PowerShell takes ( ) among the arguments as one: terraform destroy ('-auto-approve').
      if (shell !== 'powershell') {
        endCommand(false)
      } else if (char === '(') {
        command.dynamic.push(command.words.length)
      }
    } else if (char === '&' || (char === '`' && shell !== 'powershell')) {
      endWord()
      endCommand(false)
    } else if (char === '\0') {
      endWord()
      command.dynamic.push(command.words.length)
    } else if (/\s/.test(char) || char === '"' || char === "'") {
      // A quote never closed ends the word and is dropped, so what follows it is still read.
      endWord()
    } else if (char === ESCAPE[shell]) {
      // The last character of the line: it escapes nothing and is dropped (terraform destroy `-auto-approve`).
      isOpen = true
    } else if (char === '$' && /["']/.test(text[at + 1] ?? '')) {
      // bash's $"..." quotes too, and so does a $'...' another shell is handed: $'terraform' is terraform.
      isOpen = true
      raw += char
    } else {
      isOpen = true
      raw += char
      word += char === '{' ? OPEN : char === '}' ? CLOSE : char === ',' ? COMMA : char
    }
  }

  endWord()

  return commands
}

// Every command in `source`, nested ones included, each as its words from the program on, redirections gone.
const read = (source: string, depth: number, state: State): string[][] => {
  const known = state.seen.get(source)

  if (known !== undefined) {
    return known
  }

  // Fail closed: a line nested deeper than this is not read, so it is refused, not passed.
  if (depth > DEEPEST) {
    throw new Unreadable('the command nests too deeply to read')
  }

  const found: string[][] = []
  const keys = new Set<string>()
  const add = (words: string[]) => {
    const key = words.join('\u0001')

    if (words.length > 0 && !keys.has(key)) {
      keys.add(key)
      found.push(words)
    }
  }
  // A command line fed by xargs or parallel has arguments the shell fills in: each call in it ends in DYNAMIC.
  const nested = (body: string, isFed = false) => {
    const { isAnsi } = state

    for (const words of read(body, depth + 1, state)) {
      add(isFed ? [...words, DYNAMIC] : words)
    }

    state.isAnsi = isAnsi
  }

  // bash's &> is a redirection, and what follows its target still belongs to the program; sh ends the command at the &. Both are read.
  if (source.includes('&>')) {
    nested(source.replaceAll('&>', '>'))
  }

  const shells: Shell[] = ['bash']

  // PowerShell's reading differs only where one of these is written; cmd's is taken where a ^ or cmd itself is.
  if (/[`\\({]|<#/.test(source)) {
    shells.push('powershell')
  }

  if (/\^|\bcmd\b/i.test(source)) {
    shells.push('cmd')
  }

  for (const [shell, isAnsi] of shells.flatMap((shell): [Shell, boolean][] => (shell === 'bash' && source.includes("$'") ? [[shell, true], [shell, false]] : [[shell, false]]))) {
    state.isAnsi = isAnsi
    spend(state, source.length + 1)

    const visible = cut(shell === 'powershell' ? withoutBlocks(source) : source, shell, state, nested)
    const commands = lex(substitute(visible, shell === 'bash', nested), shell, state)
    let feeds = false

    for (let i = commands.length - 1; i >= 0; i--) {
      const { raw = [], words = [], dynamic = [], isPiped = false } = commands[i] ?? {}
      const next = commands[i + 1]?.words ?? []

      // Piped to a shell, straight or through other commands (echo "prog ..." | tee log | bash).
      feeds =
        isPiped &&
        (next.some(word => READER.test(word)) || sources(next) || ((feeds || state.isReader) && next.length > 0))

      let from = 0

      while (from < raw.length && LEAD.test(raw[from] ?? '')) {
        // A bare redirection takes the next word as its target.
        from += /^\d*[<>]+[&|]?$/.test(raw[from] ?? '') ? 2 : 1
      }

      // Redirections (2>&1, >file, > file) are not arguments of the program.
      const isKept = (at: number) => !/^\d*[<>]/.test(raw[at] ?? '') && !(at > from && /^\d*[<>]+[&|]?$/.test(raw[at - 1] ?? ''))
      const kept = words.slice(from).filter((_, at) => isKept(from + at))
      const assigned = ASSIGNED.exec(kept[0] ?? '')

      if (assigned !== null) {
        kept[0] = assigned[1] ?? ''
      }

      // xargs or parallel among a wrapper's words, itself or in a script it runs: what it runs gets words from the input.
      // Quotes and backslashes go first, as the script's own shell drops them (sh -c 'x""args "$@"').
      // shortcut: any word counts, so a harmless one (find -name xargs) marks the call too; narrow it if that bites.
      const isFed = WRAPPER_NAME.test(kept[0] ?? '') && kept.some(word => FEEDER.test(word.replace(/\$?["']|\\/g, '')))

      // source or . reads a here-string as its script too (source /dev/stdin <<< "..."), so its words are read as a wrapper's are;
      // so does any call with one in a command that defines a reader (f() { source /dev/stdin; }; f <<< "...").
      const readsAll = sources(words) || (state.isReader && raw.some(word => /^\d*<<</.test(word)))

      if (WRAPPER_NAME.test(kept[0] ?? '') || readsAll) {
        // A quoted argument of a wrapper is a command line of its own, an option's attached one (su --command="...") and a
        // here-string (bash <<< "...") too.
        // Every word for source: its here-string may stand before it (<<< "..." source /dev/stdin).
        for (const word of (readsAll ? words : words.slice(from + 1)).filter(one => /\s/.test(one))) {
          nested(word.replace(/^(--?[\w-]+=|<<<)/, ''), isFed)
        }
      }

      if (feeds) {
        for (const word of kept.filter(one => /\s/.test(one))) {
          nested(word)
        }

        nested(kept.slice(1).join(' '))
      }

      // Kept as written: DYNAMIC where each unread word stood (one in the program's own place is not an argument), NULs left in.
      const marks = new Set(dynamic)
      const placed: string[] = []

      for (let at = from, taken = 0; at <= words.length; at++) {
        if (at > from && marks.has(at)) {
          placed.push(DYNAMIC)
        }

        if (at < words.length && isKept(at)) {
          placed.push(kept[taken++] ?? '')
        }
      }

      if (isFed) {
        placed.push(DYNAMIC)

        // A second reading where a word holding a string xargs or parallel replace is the input's, the program's name too
        // (xargs -IX X apply); the first, as written, still names the program for a guard that reads it. The strings come from
        // a script a wrapper runs too (sh -c 'xargs -Iplan "$@"' sh terraform plan), whose words are then all after its program.
        // The strings from the words as written and from each script split into words, so one standing feeder does not hide a
        // script's (sh -c 'xargs -Iplan "$@"' xargs terraform plan).
        const direct = placed.some(word => FEEDER_NAME.test(word))
        const tokens = placed.flatMap(word => word.replace(/\$?["']|\\/g, '').split(/\s+/)).filter(Boolean)
        const { found: written, program } = replacements(placed)
        const replaced = [...new Set([...written, ...replacements(tokens).found])]
        const isAll = replaced.length > MOST_REPLACED
        const start = direct ? program : 1

        spend(state, placed.length * Math.min(replaced.length, MOST_REPLACED))

        if (isAll || replaced.length > 0) {
          add(placed.map((word, at) => (at >= start && word !== DYNAMIC && (isAll || replaced.some(one => word.includes(one))) ? DYNAMIC : word)))
        }
      }

      add(placed)

      // A program the shell names: a word starting with a variable first, which LEAD passes over as PowerShell's `$out =` ($NPM install x), or a
      // substitution in the program's place ($(echo npm) install x). Kept for namedByShell, marked by a DYNAMIC first.
      // PowerShell's ( ) there is left out: (terraform plan) runs what is inside it.
      // shortcut: FOO=$(x) npm reads as a substitution in the program's place too; it errs toward a shell-named program.
      const isNamed = raw.slice(0, from).some((word, i) => word.startsWith('$') && !/^[-+*/%]?=/.test(raw[i + 1] ?? ''))

      if (isNamed || (shell !== 'powershell' && marks.has(from))) {
        add([DYNAMIC, ...placed])
      }
    }
  }

  state.seen.set(source, found)

  return found
}

// A guard asks about one line many times, once for each program it knows.
let last: { source: string; commands?: string[][]; why?: string } | undefined

const commandsOf = (source: string): string[][] => {
  if (last?.source !== source) {
    try {
      if (source.length > MOST) {
        throw new Unreadable('the command is longer than 64 KB')
      }

      if (/[\0\uFDD0-\uFDD2]/.test(source)) {
        throw new Unreadable('the command holds a character no command line uses')
      }

      last = { source, commands: read(source, 0, { left: WORK, seen: new Map(), isAnsi: false, isReader: definesReader(source) }) }
    } catch (error) {
      last = { source, why: error instanceof Unreadable ? error.message : 'the command could not be read' }
    }
  }

  if (last.commands === undefined) {
    throw new Unreadable(last.why)
  }

  return last.commands
}

/** Why `source` cannot be read (too long, nested too deeply, too complex), or undefined. A guard must deny a line that has a reason. */
export const unreadable = (source: string): string | undefined => {
  try {
    commandsOf(source)

    return undefined
  } catch (error) {
    return (error as Error).message
  }
}

// shortcut: no variable or alias expansion ($FLAG, @args and a program named by a variable are not followed), and a heredoc body
// is read only for its substitutions, unless a shell on its opening line or piped to after its end reads it all; a body saved to
// a file and run later is not followed, nor is input a shell reads from a file or a program (cat x | bash, source <(x)), and
// what xargs or parallel add is only marked DYNAMIC, not read; a
// PowerShell here-string (@' '@) is read as plain quotes; it errs toward finding a call, so `echo '$(prog …)'`,
// `bash -c echo prog …` and a quoted argument of any wrapper count as calls. Upgrade to a real shell parser if any of these bites.
/**
 * The argument list of every call to `binary` in `source`, wrappers, subshells and substitutions included. A list that ends with
 * DYNAMIC has arguments the shell fills in; with `inPlace`, DYNAMIC stands where each one does and a word that is partly one keeps
 * a NUL. Throws Unreadable for a line it cannot read: deny it.
 */
export const invocations = (source: string, binary: RegExp, inPlace = false): string[][] => {
  const found: string[][] = []
  const isUnread = (word: string) => word.includes('\0')

  for (const placed of commandsOf(source)) {
    // namedByShell's: a DYNAMIC never stands first in a call read here.
    if (placed[0] === DYNAMIC) {
      continue
    }

    const names = placed.map(word => word.replaceAll('\0', ''))
    const at = WRAPPER_NAME.test(names[0] ?? '') ? names.findIndex((name, i) => i > 0 && binary.test(name)) : binary.test(names[0] ?? '') ? 0 : -1

    if (at < 0) {
      continue
    }

    const rest = inPlace ? placed.slice(at + 1) : names.slice(at + 1).filter((_, i) => placed[at + 1 + i] !== DYNAMIC)
    const args = at > 0 ? rest.flatMap(word => word.split(/[\s,]+/)).filter(Boolean) : rest

    found.push((inPlace ? placed.slice(0, at) : placed).some(isUnread) ? [...args, DYNAMIC] : args)
  }

  return found
}

/** The argument list of every call whose program is a variable or a substitution, first or after a wrapper. Throws Unreadable. */
export const namedByShell = (source: string): string[][] => {
  // Any variable in the word counts, glued to other text too ($TF.exe, $T$F, TF_CLI_ARGS$A).
  const isFilled = (word: string) => word.includes('\0') || /\$[\w{]/.test(word)

  return commandsOf(source).flatMap(placed => {
    const at =
      isFilled(placed[0] ?? '')
        ? 0
        : WRAPPER_NAME.test((placed[0] ?? '').replaceAll('\0', ''))
          ? placed.findIndex((word, i) => i > 0 && isFilled(word))
          : -1

    // A wrapper's arguments may be a command line in one word (bash -c "$X install"): split, as invocations does.
    return at < 0 ? [] : [at > 0 ? placed.slice(at + 1).flatMap(word => word.split(/[\s,]+/)).filter(Boolean) : placed.slice(1)]
  })
}
