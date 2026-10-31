// A small reader of shell commands for the Guard. It finds the statements, the pipes and the words
// of a command, with their places, and the text that the shell fills in from a subcommand. It is not
// a shell: it reads enough to tell a file that travels as data from a file that a flag only names,
// such as the key of `ssh -i`. Every loop moves forward, so the time grows with the length only.

/** One word of a command, with its place in the whole command. */
export interface ShellWord {
  /** The word with quotes removed. A subcommand stays as written, such as `$(cat .env)`. */
  readonly value: string;
  /** The parts that the shell expands: the word without its single-quoted parts. */
  readonly expandable: string;
  readonly start: number;
  readonly end: number;
  /** The text of each subcommand outside single quotes: `$( )`, backticks and `<( )`. */
  readonly subcommands: readonly ShellSpan[];
}

/** A part of the command, such as the text of a subcommand, with its place. */
export interface ShellSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** One command of a pipe: its words, and the files that its input and output name. */
export interface ShellSegment {
  readonly words: readonly ShellWord[];
  /** The files after `<`: their content is the input of the command. */
  readonly inputs: readonly ShellWord[];
  /** The words after `<<<`: their text is the input of the command. */
  readonly hereStrings: readonly ShellWord[];
  /** The files after `>` or `>>`. */
  readonly outputs: readonly ShellWord[];
}

/** One statement: the commands that pipes join, from the first to the last. */
export interface ShellStatement {
  readonly start: number;
  readonly end: number;
  readonly segments: readonly ShellSegment[];
}

type Redirect = "input" | "here-string" | "here-document" | "output" | null;

class SegmentBuilder {
  readonly words: ShellWord[] = [];
  readonly inputs: ShellWord[] = [];
  readonly hereStrings: ShellWord[] = [];
  readonly outputs: ShellWord[] = [];
  redirect: Redirect = null;

  add(word: ShellWord): void {
    const redirect = this.redirect;
    this.redirect = null;
    if (redirect === "input") this.inputs.push(word);
    else if (redirect === "here-string") this.hereStrings.push(word);
    else if (redirect === "output") this.outputs.push(word);
    else if (redirect === null) this.words.push(word);
    // A here-document delimiter is not data.
  }

  build(): ShellSegment {
    return { words: this.words, inputs: this.inputs, hereStrings: this.hereStrings, outputs: this.outputs };
  }

  empty(): boolean {
    return this.words.length + this.inputs.length + this.hereStrings.length + this.outputs.length === 0;
  }
}

/**
 * The index after the `)` that closes the `(` at `open`, with quotes, nested parentheses and
 * backticks read. The end of the text when nothing closes it.
 */
function closeParen(text: string, open: number): number {
  let depth = 0;
  let quote: "'" | '"' | null = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/** The index after the backtick that closes the one at `open`, or the end of the text. */
function closeBacktick(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\") index += 1;
    else if (char === "`") return index + 1;
  }
  return text.length;
}

/**
 * The statements of a command: parts that `;`, `&&`, `||`, `&`, a new line or a parenthesis
 * separate, each with its commands that `|` joins. Quotes, escapes and subcommands are read, so a
 * `;` inside quotes does not end a statement. `limit` stops the reading after that many statements;
 * `cut` then says so.
 */
export function readShell(command: string, limit: number): { statements: ShellStatement[]; cut: boolean } {
  const statements: ShellStatement[] = [];
  let segments: ShellSegment[] = [];
  let segment = new SegmentBuilder();
  let statementStart = 0;
  let cut = false;

  let value = "";
  let expandable = "";
  let wordStart = -1;
  let subcommands: ShellSpan[] = [];

  const endWord = (end: number) => {
    if (wordStart < 0) return;
    segment.add({ value, expandable, start: wordStart, end, subcommands });
    value = "";
    expandable = "";
    wordStart = -1;
    subcommands = [];
  };
  const endSegment = (end: number) => {
    endWord(end);
    if (!segment.empty()) segments.push(segment.build());
    segment = new SegmentBuilder();
  };
  const endStatement = (end: number, next: number) => {
    endSegment(end);
    if (segments.length > 0) statements.push({ start: statementStart, end, segments });
    segments = [];
    statementStart = next;
    if (statements.length >= limit) cut = true;
  };
  const begin = (at: number) => {
    if (wordStart < 0) wordStart = at;
  };

  let index = 0;
  while (index < command.length && !cut) {
    const char = command.charAt(index);
    const next = command.charAt(index + 1);
    if (char === "\\") {
      begin(index);
      if (next !== "\n") {
        value += next;
        expandable += next;
      }
      index += 2;
      continue;
    }
    if (char === "'") {
      begin(index);
      const close = command.indexOf("'", index + 1);
      const end = close < 0 ? command.length : close;
      value += command.slice(index + 1, end);
      index = end + 1;
      continue;
    }
    if (char === '"') {
      begin(index);
      index += 1;
      while (index < command.length && command.charAt(index) !== '"') {
        const inner = command.charAt(index);
        if (inner === "\\" && index + 1 < command.length) {
          value += command.charAt(index + 1);
          expandable += command.charAt(index + 1);
          index += 2;
          continue;
        }
        if (inner === "$" && command.charAt(index + 1) === "(") {
          const end = closeParen(command, index + 1);
          subcommands.push({ text: command.slice(index + 2, Math.max(index + 2, end - 1)), start: index, end });
          value += command.slice(index, end);
          expandable += command.slice(index, end);
          index = end;
          continue;
        }
        if (inner === "`") {
          const end = closeBacktick(command, index);
          subcommands.push({ text: command.slice(index + 1, Math.max(index + 1, end - 1)), start: index, end });
          value += command.slice(index, end);
          expandable += command.slice(index, end);
          index = end;
          continue;
        }
        value += inner;
        expandable += inner;
        index += 1;
      }
      index += 1;
      continue;
    }
    if ((char === "$" || char === "<") && next === "(") {
      begin(index);
      const end = closeParen(command, index + 1);
      subcommands.push({ text: command.slice(index + 2, Math.max(index + 2, end - 1)), start: index, end });
      value += command.slice(index, end);
      expandable += command.slice(index, end);
      index = end;
      continue;
    }
    if (char === "`") {
      begin(index);
      const end = closeBacktick(command, index);
      subcommands.push({ text: command.slice(index + 1, Math.max(index + 1, end - 1)), start: index, end });
      value += command.slice(index, end);
      expandable += command.slice(index, end);
      index = end;
      continue;
    }
    if (char === "#" && wordStart < 0) {
      // A comment runs to the end of the line.
      const end = command.indexOf("\n", index);
      index = end < 0 ? command.length : end;
      continue;
    }
    if (char === "\n" || char === ";" || char === "(" || char === ")") {
      endStatement(index, index + 1);
      index += 1;
      continue;
    }
    if (char === "&" && next === "&") {
      endStatement(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "|" && next === "|") {
      endStatement(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "|") {
      endSegment(index);
      index += next === "&" ? 2 : 1;
      continue;
    }
    if (char === "<" || char === ">" || (char === "&" && next === ">")) {
      // A file descriptor number before the operator, such as `2>`, is not a word.
      if (wordStart >= 0 && /^\d+$/u.test(value)) {
        value = "";
        expandable = "";
        wordStart = -1;
        subcommands = [];
      }
      endWord(index);
      if (char === "<" && command.startsWith("<<<", index)) {
        segment.redirect = "here-string";
        index += 3;
      } else if (char === "<" && next === "<") {
        segment.redirect = "here-document";
        index += command.charAt(index + 2) === "-" ? 3 : 2;
      } else if (char === "<" && next === "&") {
        index += 2;
      } else if (char === "<") {
        segment.redirect = "input";
        index += 1;
      } else {
        // `>`, `>>`, `>|`, `&>`, `&>>`, `>&`: the target is written, not sent. `>&2` names no file.
        let end = index + 1;
        while (end < command.length && /[>&|]/u.test(command.charAt(end)) && end - index < 3) end += 1;
        if (command.charAt(end - 1) === "&" && /\d/u.test(command.charAt(end))) {
          index = end + 1;
          continue;
        }
        segment.redirect = "output";
        index = end;
      }
      continue;
    }
    if (char === "&") {
      endStatement(index, index + 1);
      index += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      endWord(index);
      index += 1;
      continue;
    }
    begin(index);
    value += char;
    expandable += char;
    index += 1;
  }
  if (!cut) endStatement(command.length, command.length);
  return { statements, cut };
}

/** Commands that run the command after them, such as `sudo curl …`. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "nice",
  "timeout",
  "stdbuf",
  "xargs",
  "builtin",
]);
/**
 * The options of a wrapper that take the next word as their value, such as `sudo -u root`: the value
 * is not the program. A value joined to its option (`-uroot`, `--user=root`) is one word already.
 */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(
    "-u -g -h -p -C -D -r -t -U -T --user --group --host --prompt --close-from --chdir --role --type --other-user --command-timeout".split(
      " ",
    ),
  ),
  doas: new Set(["-u", "-C"]),
  env: new Set("-u -C -S -P --unset --chdir --split-string".split(" ")),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  xargs: new Set(
    "-I -i -n -L -l -P -d -E -e -s -a --max-args --max-lines --max-procs --delimiter --eof --max-chars --arg-file --replace".split(
      " ",
    ),
  ),
};
/** Words of the shell that come before a command, such as `if`, `!` or the `{` of a group. */
const KEYWORDS: ReadonlySet<string> = new Set(["{", "!", "if", "then", "elif", "else", "do", "while", "until"]);
/** A shell assignment before a command, such as `TOKEN=abc curl …`. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]{0,120}=/u;

/** The name of a program, without its folder and in lower case. */
export function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * The index of the word that names the program of a segment, after assignments, shell words such as
 * `if` or `{`, and wrappers such as `sudo` and `env`, or -1 when the segment only assigns.
 */
export function commandIndex(words: readonly ShellWord[]): number {
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (!word) break;
    if (ASSIGNMENT.test(word.value) || KEYWORDS.has(word.value)) {
      index += 1;
      continue;
    }
    const name = programName(word.value);
    if (!WRAPPERS.has(name)) return index;
    const wrapper = index;
    index += 1;
    // The flags of a wrapper with their values, and the duration of `timeout`.
    const valued = WRAPPER_VALUE_OPTIONS[name];
    while (
      index < words.length &&
      (words[index]?.value.startsWith("-") || ASSIGNMENT.test(words[index]?.value ?? ""))
    ) {
      index += valued?.has(words[index]?.value ?? "") ? 2 : 1;
    }
    if (name === "timeout" && index < words.length) index += 1;
    // A wrapper with nothing to run is the program itself, such as `env` that prints the environment.
    if (index >= words.length) return wrapper;
  }
  return -1;
}
