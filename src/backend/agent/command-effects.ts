/**
 * What a shell command can change, for the effect journal of a turn (`turn-effects.ts`). See
 * `docs/architecture/agents.md#safe-turn-resume`.
 *
 * This is a strict allowlist, not a list of dangers. A command is `read` or `local` only when each part
 * of it is in the tables of this file: a known program, a known subcommand, and each flag a known flag of
 * that program, with literal arguments. Anything else is `external`: a program, a subcommand or a flag
 * that is not listed, a wrapper (`env`, `sudo`, `exec`, `xargs`), a variable or a substitution in a word,
 * a redirection that the file does not read, and a shell construct other than a plain list, a pipe, `if`
 * and `while`. A wrong `external` only makes the app ask the person; a wrong `read` could make a resumed
 * turn post, push or pay a second time. The tables stay small: what a coding agent runs to look at a
 * project and to change its files.
 */
import { programName, readShell, type ShellSegment, type ShellWord } from "../guard/guard-shell";

/** `read`: safe to run again. `local`: changes only this computer. `external`: can change something else. */
export type EffectReach = "read" | "local" | "external";

export interface CommandEffect {
  reach: EffectReach;
  /**
   * A short name of the strongest part, such as `git push` or `curl`: the program and its subcommand,
   * never its arguments, so it holds no text of the task or a token.
   */
  label: string;
  /** A read-only command that shows whether the action already ran, or null when there is none. */
  check: string | null;
}

const RANK: Record<EffectReach, number> = { read: 0, local: 1, external: 2 };
const STATEMENT_LIMIT = 64;
/** The depth of `sh -c` that is read. A command nested deeper is `external`. */
const NESTING_LIMIT = 3;
const LABEL_LIMIT = 40;

export function strongerReach(left: EffectReach, right: EffectReach): EffectReach {
  return RANK[right] > RANK[left] ? right : left;
}

const result = (reach: EffectReach, label: string, check: string | null = null): CommandEffect => ({
  reach,
  label: label.slice(0, LABEL_LIMIT),
  check,
});
const outside = (label: string, check: string | null = null) => result("external", label, check);

/** Shell expansion left in a word: a variable, a substitution, or arithmetic. */
const EXPANSION = /[$`]/u;

/**
 * The flags that one program, or one subcommand, takes. A short flag with no value can join others
 * (`-la`); a short flag with a value takes the rest of its word or the next word (`-n5`, `-n 5`).
 */
interface Flags {
  short?: string;
  shortValue?: string;
  long?: readonly string[];
  /** A long flag with a value: `--x=v` or `--x v`. */
  longValue?: readonly string[];
  /** A long flag with an optional value, only as `--x=v`. */
  longOptional?: readonly string[];
  /** A long flag with two values: `--arg name value`. */
  longTwo?: readonly string[];
  /** `-20`, as `head -20`. */
  numeric?: boolean;
}

interface Parsed {
  operands: string[];
  /** Each flag that the command used, as written (`-X`, `--request`), with its value or null. */
  options: { name: string; value: string | null }[];
}

const split = (text: string) => text.split(" ").filter(Boolean);

/** The operands and flags of `args` when each flag is in `flags`; null when one is not. */
function parse(args: readonly ShellWord[], flags: Flags): Parsed | null {
  const operands: string[] = [];
  const options: Parsed["options"] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (value === "--") {
      operands.push(...args.slice(index + 1).map((word) => word.value));
      break;
    }
    if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = equals < 0 ? value : value.slice(0, equals);
      const joined = equals < 0 ? null : value.slice(equals + 1);
      if (flags.longTwo?.includes(name) && joined === null) {
        if (index + 2 >= args.length) return null;
        options.push({ name, value: `${args[index + 1]?.value ?? ""} ${args[index + 2]?.value ?? ""}` });
        index += 2;
      } else if (flags.longValue?.includes(name)) {
        if (joined === null && index + 1 >= args.length) return null;
        options.push({ name, value: joined ?? args[index + 1]?.value ?? "" });
        if (joined === null) index += 1;
      } else if (flags.longOptional?.includes(name)) options.push({ name, value: joined });
      else if (joined === null && flags.long?.includes(name)) options.push({ name, value: null });
      else return null;
      continue;
    }
    if (value.startsWith("-") && value.length > 1) {
      if (flags.numeric && /^-\d+$/u.test(value)) continue;
      const letters = value.slice(1);
      for (let at = 0; at < letters.length; at += 1) {
        const letter = letters.charAt(at);
        if (flags.short?.includes(letter)) {
          options.push({ name: `-${letter}`, value: null });
          continue;
        }
        if (!flags.shortValue?.includes(letter)) return null;
        const rest = letters.slice(at + 1);
        if (rest === "" && index + 1 >= args.length) return null;
        options.push({ name: `-${letter}`, value: rest || (args[index + 1]?.value ?? "") });
        if (rest === "") index += 1;
        break;
      }
      continue;
    }
    operands.push(value);
  }
  return { operands, options };
}

const has = (parsed: Parsed, ...names: string[]) => parsed.options.some((option) => names.includes(option.name));
const valuesOf = (parsed: Parsed, ...names: string[]) =>
  parsed.options.filter((option) => names.includes(option.name)).map((option) => option.value ?? "");

interface Rule {
  reach: EffectReach;
  flags: Flags;
  /** A further check of the parsed command: the reach, or null when the command is not in the table. */
  check?: (parsed: Parsed) => EffectReach | null;
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
/** A header that asks a server to treat the request as another method. */
const METHOD_HEADER = /^\s*x-(?:http-)?method(?:-override)?\s*:/iu;

// --- Simple programs -------------------------------------------------------------------------------------

const PROGRAMS: Readonly<Record<string, Rule>> = {
  ls: {
    reach: "read",
    flags: {
      short: "1aAbBcCdfFgGhHiklLmnopqrRsStuUvwx@",
      long: split(
        "--all --almost-all --human-readable --classify --directory --recursive --reverse --size --group-directories-first --full-time --inode --numeric-uid-gid --dereference --no-group",
      ),
      longOptional: ["--color"],
      longValue: split("--sort --time-style --format --width --indicator-style --hide --ignore --block-size --time"),
    },
  },
  cat: {
    reach: "read",
    flags: {
      short: "AbeEnstTuv",
      long: split("--number --show-all --squeeze-blank --number-nonblank --show-ends --show-tabs"),
    },
  },
  head: {
    reach: "read",
    flags: {
      short: "qvz",
      shortValue: "nc",
      numeric: true,
      long: split("--quiet --silent --verbose --zero-terminated"),
      longValue: ["--lines", "--bytes"],
    },
  },
  tail: {
    reach: "read",
    flags: {
      short: "fFqrvz",
      shortValue: "ncs",
      numeric: true,
      long: split("--follow --retry --quiet --silent --verbose --zero-terminated"),
      longValue: split("--lines --bytes --pid --sleep-interval"),
    },
  },
  wc: { reach: "read", flags: { short: "clmwL", long: split("--bytes --chars --lines --words --max-line-length") } },
  grep: {
    reach: "read",
    flags: {
      short: "EFGPivwxyclLnhHoqsrRUzZabTI0123456789",
      shortValue: "efmABCdD",
      long: split(
        "--ignore-case --recursive --dereference-recursive --line-number --count --files-with-matches --files-without-match --only-matching --quiet --silent --no-messages --invert-match --word-regexp --line-regexp --extended-regexp --fixed-strings --perl-regexp --basic-regexp --with-filename --no-filename --null --text --byte-offset --initial-tab --line-buffered",
      ),
      longOptional: ["--color", "--colour"],
      longValue: split(
        "--regexp --file --max-count --after-context --before-context --context --include --exclude --exclude-dir --label --binary-files --devices --directories",
      ),
    },
  },
  rg: {
    reach: "read",
    flags: {
      short: "iISsFwxvclLnNHoqUua0bp.",
      shortValue: "egtTmABCMjrf",
      long: split(
        "--ignore-case --smart-case --case-sensitive --fixed-strings --word-regexp --line-regexp --invert-match --count --files-with-matches --files-without-match --line-number --no-line-number --with-filename --no-filename --only-matching --quiet --hidden --no-ignore --no-ignore-vcs --follow --multiline --json --files --no-heading --heading --vimgrep --stats --sort-files --trim --null --pretty --text --unrestricted --column --no-messages --count-matches --passthru --type-list",
      ),
      longValue: split(
        "--regexp --glob --iglob --type --type-not --max-count --after-context --before-context --context --max-columns --threads --replace --file --sort --sortr --max-depth --color --max-filesize --encoding --context-separator",
      ),
    },
  },
  echo: { reach: "read", flags: { short: "neE" } },
  printf: { reach: "read", flags: {} },
  pwd: { reach: "read", flags: { short: "LP" } },
  date: { reach: "read", flags: { short: "uRjIn", shortValue: "drvf" } },
  which: { reach: "read", flags: { short: "as" } },
  type: { reach: "read", flags: { short: "atpPf" } },
  basename: {
    reach: "read",
    flags: { short: "az", shortValue: "s", long: ["--multiple", "--zero"], longValue: ["--suffix"] },
  },
  dirname: { reach: "read", flags: { short: "z" } },
  realpath: { reach: "read", flags: { short: "eqmsLPz", longValue: ["--relative-to", "--relative-base"] } },
  readlink: { reach: "read", flags: { short: "fenmqsvz" } },
  stat: {
    reach: "read",
    flags: {
      short: "LFlnqrstx",
      shortValue: "fc",
      long: ["--dereference", "--terse"],
      longValue: ["--format", "--printf"],
    },
  },
  file: { reach: "read", flags: { short: "bciLhkNnrsz0", long: ["--brief", "--mime", "--mime-type"] } },
  du: {
    reach: "read",
    flags: {
      short: "acdhHkLmsx0",
      shortValue: "dB",
      long: ["--human-readable", "--summarize", "--all"],
      longValue: ["--max-depth"],
    },
  },
  df: { reach: "read", flags: { short: "aHhiklmPT" } },
  tree: {
    reach: "read",
    flags: { short: "adfilpsughDFqNQrtvUCAnSx", shortValue: "LIP", long: ["--noreport", "--dirsfirst", "--gitignore"] },
  },
  diff: {
    reach: "read",
    flags: {
      short: "uaBbiEwqrsNTtypc",
      shortValue: "UCx",
      numeric: true,
      long: split(
        "--brief --recursive --new-file --ignore-case --ignore-all-space --ignore-space-change --side-by-side --text --strip-trailing-cr --suppress-common-lines --report-identical-files",
      ),
      longOptional: ["--color"],
      longValue: split("--unified --context --exclude --label"),
    },
  },
  cmp: { reach: "read", flags: { short: "bls", shortValue: "in" } },
  comm: { reach: "read", flags: { short: "123iz" } },
  sha256sum: { reach: "read", flags: { short: "bctwz" } },
  sha1sum: { reach: "read", flags: { short: "bctwz" } },
  md5sum: { reach: "read", flags: { short: "bctwz" } },
  shasum: { reach: "read", flags: { short: "bctwz", shortValue: "a" } },
  md5: { reach: "read", flags: { short: "qrs" } },
  base64: { reach: "read", flags: { short: "dD", shortValue: "wb" } },
  nl: { reach: "read", flags: { shortValue: "bvihsw" } },
  fold: { reach: "read", flags: { short: "bs", shortValue: "w" } },
  column: { reach: "read", flags: { short: "tnex", shortValue: "cs" } },
  whoami: { reach: "read", flags: {} },
  id: { reach: "read", flags: { short: "unGgr" } },
  uname: { reach: "read", flags: { short: "amnrsvpio" } },
  nproc: { reach: "read", flags: {} },
  uptime: { reach: "read", flags: {} },
  sw_vers: { reach: "read", flags: {} },
  printenv: { reach: "read", flags: {} },
  ps: { reach: "read", flags: { short: "aefjlmuvwxAMSTr", shortValue: "opUutcgG" } },
  pgrep: { reach: "read", flags: { short: "lafnoxvi", shortValue: "uUPgGt" } },
  true: { reach: "read", flags: {} },
  false: { reach: "read", flags: {} },
  ":": { reach: "read", flags: {} },
  sleep: { reach: "read", flags: {} },
  exit: { reach: "read", flags: {} },
  test: { reach: "read", flags: { short: "abcdefghknoprsuwxzGLNOS" } },
  "[": { reach: "read", flags: { short: "abcdefghknoprsuwxzGLNOS" } },
  "[[": { reach: "read", flags: { short: "abcdefghknoprsuwxzGLNOS" } },
  "}": { reach: "read", flags: {} },
  fi: { reach: "read", flags: {} },
  done: { reach: "read", flags: {} },
  cd: { reach: "read", flags: { short: "LPe" }, check: (parsed) => (parsed.operands.length <= 1 ? "read" : null) },
  set: { reach: "read", flags: { short: "euxvfnhCTEbBm", shortValue: "o" } },
  jq: {
    reach: "read",
    flags: {
      short: "rcnsSejaCMhj",
      long: split(
        "--raw-output --compact-output --null-input --slurp --sort-keys --exit-status --join-output --ascii-output --tab --color-output --monochrome-output --raw-input --stream --seq",
      ),
      longValue: ["--indent"],
      longTwo: ["--arg", "--argjson", "--slurpfile", "--rawfile"],
    },
  },
  sort: {
    reach: "read",
    flags: {
      short: "bdfghiMnRrsuVcCz",
      shortValue: "ktSoT",
      long: split(
        "--numeric-sort --reverse --unique --ignore-case --human-numeric-sort --version-sort --stable --check --zero-terminated --general-numeric-sort --month-sort --random-sort --dictionary-order --ignore-leading-blanks --merge",
      ),
      longValue: split("--key --field-separator --buffer-size --temporary-directory --parallel --output --sort"),
    },
    check: (parsed) => (has(parsed, "-o", "--output") ? "local" : "read"),
  },
  uniq: {
    reach: "read",
    flags: {
      short: "cdDuiz",
      shortValue: "fsw",
      long: split("--count --repeated --unique --ignore-case --zero-terminated"),
      longValue: split("--skip-fields --skip-chars --check-chars"),
    },
    // A second file is the output.
    check: (parsed) => (parsed.operands.length >= 2 ? "local" : "read"),
  },
  cut: {
    reach: "read",
    flags: {
      short: "snz",
      shortValue: "bcdf",
      long: ["--complement", "--only-delimited"],
      longValue: split("--bytes --characters --delimiter --fields --output-delimiter"),
    },
  },
  tr: { reach: "read", flags: { short: "cCdst" } },
  xxd: {
    reach: "read",
    flags: { short: "pirEu", shortValue: "lcsgo" },
    check: (parsed) => (parsed.operands.length >= 2 ? "local" : "read"),
  },
  mkdir: {
    reach: "local",
    flags: { short: "pv", shortValue: "m", long: ["--parents", "--verbose"], longValue: ["--mode"] },
  },
  touch: { reach: "local", flags: { short: "acmh", shortValue: "drt" } },
  cp: {
    reach: "local",
    flags: {
      short: "rRfpvniaPLHlsxuT",
      shortValue: "t",
      long: split("--recursive --force --verbose --no-clobber --archive --update"),
      longValue: ["--target-directory"],
      longOptional: ["--preserve"],
    },
  },
  mv: {
    reach: "local",
    flags: {
      short: "fnviuT",
      shortValue: "t",
      long: split("--force --no-clobber --verbose --update"),
      longValue: ["--target-directory"],
    },
  },
  rm: { reach: "local", flags: { short: "rRfvid", long: split("--recursive --force --verbose --dir") } },
  rmdir: { reach: "local", flags: { short: "pv" } },
  ln: { reach: "local", flags: { short: "sfnvTr", shortValue: "t" } },
  chmod: { reach: "local", flags: { short: "Rvf" } },
  tee: { reach: "local", flags: { short: "ai", long: ["--append"] } },
  tsc: {
    reach: "local",
    flags: {
      short: "b",
      shortValue: "p",
      long: split(
        "--noEmit --pretty --incremental --build --listFiles --extendedDiagnostics --strict --skipLibCheck --declaration --noEmitOnError --emitDeclarationOnly",
      ),
      longValue: split("--project --outDir --target --module --lib --jsx --rootDir"),
    },
  },
};

/** Other names of a listed program: `egrep` is `grep -E`, `gawk` is `awk`. */
const ALIASES: Readonly<Record<string, string>> = {
  egrep: "grep",
  fgrep: "grep",
  gawk: "awk",
  mawk: "awk",
  nawk: "awk",
};

// --- sed, awk, find --------------------------------------------------------------------------------------

function sed(args: readonly ShellWord[]): CommandEffect {
  const scripts: string[] = [];
  let inPlace = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (value === "-e" || value === "--expression") {
      scripts.push(args[index + 1]?.value ?? "");
      index += 1;
    } else if (value.startsWith("--expression=")) scripts.push(value.slice("--expression=".length));
    else if (/^-[nErsuz]+$/u.test(value) || /^--(?:quiet|silent|regexp-extended|separate|null-data)$/u.test(value))
      continue;
    else if (/^-i(?:\.[\w.-]*)?$/u.test(value) || value === "-I" || /^--in-place(?:=\.[\w.-]*)?$/u.test(value)) {
      inPlace = true;
      // BSD sed: `-i ''` or `-i .bak` names the backup suffix.
      const next = args[index + 1]?.value;
      if ((value === "-i" || value === "-I") && next !== undefined && (next === "" || /^\.[\w.-]*$/u.test(next)))
        index += 1;
    } else if (value.startsWith("-")) return outside("sed (flag)");
    else break;
  }
  if (scripts.length === 0) {
    scripts.push(args[index]?.value ?? "");
    index += 1;
  }
  if (args.slice(index).some((word) => word.value.startsWith("-"))) return outside("sed (flag)");
  if (!scripts.every(safeSedScript)) return outside("sed (runs or writes)");
  return result(inPlace ? "local" : "read", inPlace ? "sed -i" : "sed");
}

const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/)(?:,(?:\d+|\$|/(?:\\.|[^/\\])*/|\+\d+))?!?`;
const SED_SIMPLE = new RegExp(`^(?:${SED_ADDRESS})?\\s*[pdqQ=nNPDgGhHxl{}]?$`, "u");

/**
 * Whether a sed script only prints, deletes or substitutes: each command is one that this file knows,
 * and no substitution has the `e` or `w` flag. A command that runs (`e`) or writes (`w`), or a script
 * that this file does not read completely, is not safe.
 */
function safeSedScript(script: string): boolean {
  if (!script.trim()) return false;
  return script
    .split(/[;\n]/u)
    .map((part) => part.trim())
    .every((part) => {
      if (SED_SIMPLE.test(part)) return true;
      const command = part.replace(new RegExp(`^(?:${SED_ADDRESS})?\\s*`, "u"), "");
      const substitution = /^([sy])(.)/u.exec(command);
      if (!substitution?.[2] || /[\s\\\n]/u.test(substitution[2])) return false;
      const parts = splitByDelimiter(command.slice(2), substitution[2]);
      if (parts?.length !== 3) return false;
      const flags = parts[2] ?? "";
      return substitution[1] === "y" ? flags === "" : /^[gpiImM0-9]*$/u.test(flags);
    });
}

/** The parts of `a/b/flags` split by an unescaped delimiter, or null for a part that does not end. */
function splitByDelimiter(text: string, delimiter: string): string[] | null {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\") {
      current += char + text.charAt(index + 1);
      index += 1;
    } else if (char === delimiter && parts.length < 2) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.length === 3 ? parts : null;
}

/**
 * awk with only `-F` and `-v`, and an inline program with none of `system`, a pipe, `getline`, an output
 * redirection or `@` (gawk's `@load`, `@include` and indirect calls such as `@f("…")`).
 */
function awk(name: string, args: readonly ShellWord[]): CommandEffect {
  let index = 0;
  for (; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (value === "-F" || value === "-v") index += 1;
    else if (/^-F./u.test(value) || /^-v[A-Za-z_]\w*=/u.test(value)) continue;
    else if (value.startsWith("-")) return outside(`${name} (flag)`);
    else break;
  }
  const program = args[index]?.value;
  if (program === undefined) return outside(name);
  if (/system|\||getline|>|@/u.test(program)) return outside(`${name} (runs or writes)`);
  if (args.slice(index + 1).some((word) => word.value.startsWith("-"))) return outside(`${name} (flag)`);
  return result("read", name);
}

const FIND_FLAGS: ReadonlySet<string> = new Set(
  split(
    "-print -print0 -not ! -o -or -a -and ( ) -prune -L -H -P -follow -depth -xdev -mount -readable -writable -executable -empty -ls -nouser -nogroup -true -false",
  ),
);
const FIND_VALUES: ReadonlySet<string> = new Set(
  split(
    "-name -iname -path -ipath -regex -iregex -type -maxdepth -mindepth -size -mtime -mmin -newer -perm -user -group -wholename -iwholename -links -inum -samefile -atime -ctime -amin -cmin -printf -regextype",
  ),
);

/** find with tests only. `-delete` is a local change; `-exec`, `-ok`, `-fprint` and any other action are not read. */
function find(args: readonly ShellWord[]): CommandEffect {
  let reach: EffectReach = "read";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (FIND_VALUES.has(value)) index += 1;
    else if (value === "-delete") reach = "local";
    else if (FIND_FLAGS.has(value) || !value.startsWith("-")) continue;
    else return outside(`find ${value}`.slice(0, LABEL_LIMIT));
  }
  return result(reach, "find");
}

// --- git -------------------------------------------------------------------------------------------------

const LOG_FLAGS: Flags = {
  short: "pruszMCw",
  shortValue: "nSGLU",
  numeric: true,
  long: split(
    "--oneline --graph --all --shortstat --numstat --name-only --name-status --patch --no-patch --follow --reverse --first-parent --merges --no-merges --abbrev-commit --no-color --source --left-right --cherry-pick --cherry-mark --boundary --simplify-by-decoration --full-history --topo-order --date-order --relative-date --ignore-all-space --invert-grep --regexp-ignore-case --all-match --raw --full-diff --no-decorate --no-abbrev-commit --no-renames --summary --no-ext-diff",
  ),
  longOptional: split(
    "--decorate --color --word-diff --abbrev --stat --dirstat --branches --tags --remotes --relative",
  ),
  longValue: split(
    "--format --pretty --since --until --after --before --author --committer --grep --max-count --date --diff-filter --skip --min-parents --max-parents --encoding",
  ),
};
const DIFF_FLAGS: Flags = {
  short: "pubwaRzMCBDsq",
  shortValue: "USG",
  long: split(
    "--cached --staged --shortstat --numstat --name-only --name-status --patch --no-patch --check --exit-code --quiet --minimal --patience --histogram --merge-base --no-ext-diff --text --ignore-all-space --ignore-space-change --ignore-blank-lines --no-renames --raw --summary --no-index --no-color",
  ),
  longOptional: split("--color --word-diff --stat --relative --dirstat --find-renames --find-copies --abbrev"),
  longValue: split("--unified --diff-filter --diff-algorithm --src-prefix --dst-prefix --inter-hunk-context"),
};

/** A remote that git reaches with a program (`ext::`, `fd::`) or with an option that runs one. */
const UNSAFE_OPERAND = /::|^!/u;

const GIT: Readonly<Record<string, Rule>> = {
  status: {
    reach: "read",
    flags: {
      short: "sbuvz",
      long: split(
        "--short --branch --long --verbose --ignored --show-stash --ahead-behind --no-ahead-behind --renames --no-renames",
      ),
      longOptional: ["--porcelain", "--untracked-files", "--ignore-submodules", "--column"],
    },
  },
  log: { reach: "read", flags: LOG_FLAGS },
  diff: { reach: "read", flags: DIFF_FLAGS },
  show: {
    reach: "read",
    flags: {
      short: "psuwzM",
      shortValue: "U",
      long: split(
        "--name-only --name-status --oneline --no-patch --patch --no-color --quiet --shortstat --numstat --summary --raw --abbrev-commit --no-ext-diff",
      ),
      longOptional: split("--color --word-diff --decorate --abbrev --stat"),
      longValue: split("--format --pretty --date"),
    },
  },
  branch: {
    reach: "read",
    flags: {
      short: "arvdDmMf",
      shortValue: "u",
      long: split("--all --remotes --list --show-current --verbose --delete --move --force --no-color"),
      longOptional: split("--merged --no-merged --contains --no-contains --color --track"),
      longValue: split("--sort --format --points-at --set-upstream-to"),
    },
    check: (parsed) =>
      parsed.operands.length === 0 &&
      !has(parsed, "-d", "-D", "-m", "-M", "-f", "--delete", "--move", "--force", "-u", "--set-upstream-to")
        ? "read"
        : "local",
  },
  "rev-parse": {
    reach: "read",
    flags: {
      short: "q",
      long: split(
        "--show-toplevel --git-dir --is-inside-work-tree --verify --symbolic-full-name --absolute-git-dir --show-prefix --show-cdup --git-common-dir --quiet --is-bare-repository",
      ),
      longOptional: ["--short", "--abbrev-ref"],
    },
  },
  "ls-files": {
    reach: "read",
    flags: {
      short: "zocmdsvt",
      long: split(
        "--others --exclude-standard --cached --modified --deleted --stage --error-unmatch --full-name --ignored --directory",
      ),
      longValue: ["--exclude"],
    },
  },
  blame: {
    reach: "read",
    flags: {
      short: "wMCelsptf",
      shortValue: "L",
      long: split("--porcelain --line-porcelain --show-email"),
      longValue: ["--date"],
    },
  },
  describe: {
    reach: "read",
    flags: {
      long: split("--tags --always --long --all --exact-match"),
      longOptional: ["--abbrev", "--dirty"],
      longValue: ["--match", "--exclude"],
    },
  },
  "show-ref": { reach: "read", flags: { short: "dsq", long: split("--heads --tags --verify --quiet --dereference") } },
  "merge-base": { reach: "read", flags: { short: "a", long: ["--all", "--is-ancestor", "--fork-point"] } },
  "rev-list": {
    reach: "read",
    flags: {
      shortValue: "n",
      long: split("--count --all --reverse --left-right --first-parent --objects"),
      longValue: split("--max-count --since --until"),
    },
  },
  "for-each-ref": {
    reach: "read",
    flags: { longValue: split("--format --sort --count --points-at --merged --contains") },
  },
  shortlog: { reach: "read", flags: { short: "sne", long: ["--summary", "--numbered", "--email"] } },
  "ls-remote": { reach: "read", flags: { short: "htq", long: split("--heads --tags --refs --quiet --symref") } },
  grep: {
    reach: "read",
    flags: {
      short: "ilnvwcEFPhHoqIr",
      shortValue: "efABC",
      long: split(
        "--ignore-case --line-number --count --word-regexp --invert-match --extended-regexp --fixed-strings --perl-regexp --files-with-matches --name-only --untracked --cached --no-index --only-matching --heading --break --full-name --quiet",
      ),
      longValue: split("--max-depth --after-context --before-context --context --threads"),
    },
  },
  "cat-file": { reach: "read", flags: { short: "ptse" } },
  remote: {
    reach: "read",
    flags: { short: "v" },
    check: (parsed) =>
      parsed.operands.length === 0 ||
      ((parsed.operands[0] === "get-url" || parsed.operands[0] === "show") && parsed.operands.length === 2)
        ? "read"
        : null,
  },
  stash: {
    reach: "local",
    flags: {
      short: "ukq",
      shortValue: "m",
      long: split("--include-untracked --keep-index --quiet --index --staged"),
      longValue: ["--message"],
    },
    check: (parsed) => {
      const verb = parsed.operands[0];
      if (verb === "list" || verb === "show") return "read";
      return verb === undefined || ["push", "pop", "apply", "drop", "save"].includes(verb) ? "local" : null;
    },
  },
  tag: {
    reach: "read",
    flags: {
      short: "ladf",
      shortValue: "m",
      long: split("--list --delete --force --annotate"),
      longValue: split("--sort --contains --points-at --merged --message"),
    },
    check: (parsed) =>
      parsed.operands.length === 0 &&
      !has(parsed, "-d", "-a", "-f", "-m", "--delete", "--annotate", "--force", "--message")
        ? "read"
        : "local",
  },
  worktree: { reach: "read", flags: {}, check: (parsed) => (parsed.operands[0] === "list" ? "read" : null) },
  reflog: {
    reach: "read",
    flags: { numeric: true, shortValue: "n" },
    check: (parsed) => (parsed.operands.length === 0 || parsed.operands[0] === "show" ? "read" : null),
  },
  config: {
    reach: "read",
    flags: {
      short: "l",
      long: split(
        "--get --get-all --get-regexp --list --show-origin --global --local --system --name-only --show-scope",
      ),
    },
    // Only a read: a set can add an alias that runs a program, or hooks.
    check: (parsed) => (has(parsed, "--get", "--get-all", "--get-regexp", "--list", "-l") ? "read" : null),
  },
  add: {
    reach: "local",
    flags: {
      short: "AuNfvn",
      long: split("--all --update --intent-to-add --force --verbose --dry-run --ignore-errors --renormalize"),
    },
  },
  commit: {
    reach: "local",
    flags: {
      short: "aqvsn",
      shortValue: "mF",
      long: split(
        "--all --amend --no-edit --quiet --verbose --allow-empty --allow-empty-message --no-verify --signoff --no-gpg-sign",
      ),
      longValue: split("--message --file --author --date --fixup --squash"),
    },
  },
  checkout: {
    reach: "local",
    flags: {
      short: "fqtm",
      shortValue: "bB",
      long: split("--force --quiet --detach --track --no-track --ours --theirs --merge"),
      longValue: ["--orphan"],
    },
  },
  switch: {
    reach: "local",
    flags: {
      short: "dfq",
      shortValue: "cC",
      long: split("--detach --force --quiet --discard-changes --track --no-track"),
      longValue: split("--create --force-create --orphan"),
    },
  },
  restore: {
    reach: "local",
    flags: {
      short: "SWq",
      shortValue: "s",
      long: split("--staged --worktree --quiet --ours --theirs"),
      longValue: ["--source"],
    },
  },
  reset: { reach: "local", flags: { short: "q", long: split("--hard --soft --mixed --keep --merge --quiet") } },
  fetch: {
    reach: "local",
    flags: {
      short: "pqtvf",
      long: split("--all --prune --tags --no-tags --quiet --verbose --force --dry-run --unshallow"),
      longValue: split("--depth --deepen --shallow-since"),
    },
  },
  pull: {
    reach: "local",
    flags: {
      short: "qvr",
      long: split("--no-rebase --ff-only --no-ff --ff --quiet --verbose --autostash --prune --tags"),
      longOptional: ["--rebase"],
    },
  },
  merge: {
    reach: "local",
    flags: {
      short: "q",
      shortValue: "m",
      long: split("--no-ff --ff-only --ff --squash --abort --continue --no-edit --quiet --no-commit --commit"),
      longValue: ["--message"],
    },
  },
  rebase: {
    reach: "local",
    flags: {
      short: "q",
      long: split("--continue --abort --skip --autosquash --no-autosquash --quiet --autostash --keep-empty"),
      longValue: ["--onto"],
    },
  },
  "cherry-pick": {
    reach: "local",
    flags: {
      short: "nx",
      shortValue: "m",
      long: split("--continue --abort --skip --no-commit --no-edit --quit"),
      longValue: ["--mainline"],
    },
  },
  revert: {
    reach: "local",
    flags: {
      short: "n",
      shortValue: "m",
      long: split("--continue --abort --skip --no-commit --no-edit --quit"),
      longValue: ["--mainline"],
    },
  },
  init: {
    reach: "local",
    flags: { short: "q", shortValue: "b", long: ["--quiet", "--bare"], longValue: ["--initial-branch"] },
  },
  clone: {
    reach: "local",
    flags: {
      short: "q",
      shortValue: "b",
      long: split("--quiet --single-branch --no-checkout --bare --no-tags"),
      longValue: split("--branch --depth --origin --filter"),
    },
  },
  mv: { reach: "local", flags: { short: "fkvn" } },
  rm: { reach: "local", flags: { short: "rfqn", long: split("--cached --force --quiet --dry-run") } },
  apply: {
    reach: "local",
    flags: {
      short: "vR3",
      long: split("--check --stat --cached --index --reverse --3way"),
      longValue: split("--whitespace --directory --exclude --include"),
    },
  },
};

const GIT_CHECK = "git status -sb && git log --oneline -3 @{upstream}";

/** A name for a git command whose options this file does not read, such as `git push`, for the person. */
function gitLabel(args: readonly ShellWord[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (/^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)$/u.test(value))
      index += 1;
    else if (!value.startsWith("-")) return `git ${value}`;
  }
  return "git";
}

function git(args: readonly ShellWord[]): CommandEffect {
  // Only these global options: anything else (`-c alias.x=!cmd`, `--exec-path`, `--git-dir`) is not read.
  let index = 0;
  for (let word = args[index]; word?.value.startsWith("-"); word = args[index]) {
    if (word.value === "-C") index += 2;
    else if (word.value === "--no-pager" || word.value === "-P") index += 1;
    else return outside(gitLabel(args), GIT_CHECK);
  }
  const sub = args[index]?.value ?? "";
  const rule = GIT[sub];
  if (!rule) return outside(`git ${sub}`.trim(), GIT_CHECK);
  const parsed = parse(args.slice(index + 1), rule.flags);
  if (!parsed || parsed.operands.some((operand) => UNSAFE_OPERAND.test(operand)))
    return outside(`git ${sub}`, GIT_CHECK);
  const reach = rule.check ? rule.check(parsed) : rule.reach;
  return reach ? result(reach, `git ${sub}`) : outside(`git ${sub}`, GIT_CHECK);
}

// --- gh --------------------------------------------------------------------------------------------------

const GH_GROUPS: ReadonlySet<string> = new Set(
  split("pr issue run release repo workflow label gist cache ruleset variable"),
);
const GH_VERBS: ReadonlySet<string> = new Set(split("list view status checks diff watch"));
const GH_FLAGS: Flags = {
  shortValue: "RLsqtSAalBHb",
  long: split(
    "--comments --log --log-failed --verbose --exit-status --required --name-only --patch --fail-fast --compact",
  ),
  longOptional: ["--color"],
  longValue: split(
    "--repo --json --jq --template --limit --state --author --assignee --label --base --head --search --app --branch --workflow --status --user --event --commit --created --interval --attempt --job --milestone --mention --owner --language --sort --order --match",
  ),
};
const GH_API_FLAGS: Flags = {
  short: "i",
  shortValue: "qtXHR",
  long: ["--paginate", "--include", "--silent", "--slurp"],
  longValue: split("--jq --template --cache --hostname --method --header --repo"),
};

function gh(args: readonly ShellWord[]): CommandEffect {
  const [first, second] = args;
  const group = first?.value ?? "";
  const verb = second?.value ?? "";
  const check =
    group === "pr"
      ? "gh pr list --state all --limit 10"
      : group === "issue"
        ? "gh issue list --state all --limit 10"
        : null;
  if (group === "api") {
    const parsed = parse(args.slice(1), GH_API_FLAGS);
    if (
      parsed?.operands.length !== 1 ||
      valuesOf(parsed, "-X", "--method").some((method) => !READ_METHODS.has(method.toUpperCase())) ||
      valuesOf(parsed, "-H", "--header").some((header) => METHOD_HEADER.test(header))
    )
      return outside("gh api");
    return result("read", "gh api");
  }
  if (group === "status" && args.length === 1) return result("read", "gh status");
  if (group === "auth" && verb === "status" && args.length === 2) return result("read", "gh auth status");
  const rest = args.slice(2);
  if (group === "search" || (GH_GROUPS.has(group) && GH_VERBS.has(verb)))
    return parse(rest, GH_FLAGS) ? result("read", `gh ${group} ${verb}`) : outside(`gh ${group} ${verb}`, check);
  if (group === "pr" && verb === "checkout")
    return parse(rest, { short: "f", shortValue: "bR", long: ["--force"], longValue: ["--branch", "--repo"] })
      ? result("local", "gh pr checkout")
      : outside("gh pr checkout");
  return outside(`gh ${group} ${verb}`.trim(), check);
}

// --- HTTP clients ----------------------------------------------------------------------------------------

const HTTP_URL = /^(?![a-z][a-z0-9+.-]*:\/\/)|^https?:\/\//iu;

const CURL_FLAGS: Flags = {
  short: "sSfLkivIg46#NjO",
  shortValue: "HoumAewrbX",
  long: split(
    "--silent --show-error --fail --fail-with-body --location --insecure --include --head --verbose --compressed --http1.1 --http2 --globoff --no-progress-meter --no-buffer --remote-name --remote-name-all --create-dirs --get --progress-bar --ipv4 --ipv6 --fail-early",
  ),
  longValue: split(
    "--header --output --user --max-time --connect-timeout --user-agent --referer --write-out --range --cookie --request --url --retry --retry-delay --retry-max-time --output-dir --max-redirs --oauth2-bearer --cacert --limit-rate",
  ),
};

/** curl with only the flags of a GET or a HEAD, and HTTP URLs. Any other flag (`-d`, `-F`, `-T`, `-K`, `--json`, `--expand-…`) is not read. */
function curl(args: readonly ShellWord[]): CommandEffect {
  const parsed = parse(args, CURL_FLAGS);
  if (
    !parsed ||
    valuesOf(parsed, "-X", "--request").some((method) => !READ_METHODS.has(method.toUpperCase())) ||
    valuesOf(parsed, "-H", "--header").some((header) => METHOD_HEADER.test(header)) ||
    [...parsed.operands, ...valuesOf(parsed, "--url")].some((url) => !HTTP_URL.test(url))
  )
    return outside("curl (sends data)");
  const writes = has(
    parsed,
    "-o",
    "-O",
    "--output",
    "--remote-name",
    "--remote-name-all",
    "--output-dir",
    "--create-dirs",
  );
  return result(writes ? "local" : "read", "curl");
}

const HTTPIE_FLAGS: Flags = {
  short: "hbvF",
  shortValue: "psaA",
  long: split("--ignore-stdin --follow --check-status --headers --body --verbose"),
  longValue: split("--print --pretty --style --timeout --auth --auth-type"),
};

/**
 * HTTPie and xh send their standard input as the body, and a field as a POST. Only an explicit GET or
 * HEAD with `--ignore-stdin`, headers and query parameters is a read.
 */
function httpie(name: string, args: readonly ShellWord[]): CommandEffect {
  const parsed = parse(args, HTTPIE_FLAGS);
  const [method, url, ...items] = parsed?.operands ?? [];
  if (
    !parsed ||
    !has(parsed, "--ignore-stdin") ||
    (method !== "GET" && method !== "HEAD") ||
    url === undefined ||
    !HTTP_URL.test(url) ||
    !items.every((item) => (/^[\w-]+:[^=]/u.test(item) && !METHOD_HEADER.test(item)) || /^[\w.-]+==/u.test(item))
  )
    return outside(`${name} (sends data)`);
  return result("read", name);
}

// --- shells ----------------------------------------------------------------------------------------------

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

/**
 * `bash -c 'script'`, `bash -lc 'script'` or `zsh -l -c 'script'`: options only before the script, each
 * one only `-l` and `-c`, and nothing after the script. Any other option (`-i`, `--rcfile`, `-o`), an
 * operand before `-c`, or an argument after the script is not read.
 */
function shell(name: string, args: readonly ShellWord[], depth: number): CommandEffect {
  let script: ShellWord | undefined;
  let index = 0;
  for (; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (/^-l+$/u.test(value)) continue;
    if (/^-l*cl*$/u.test(value)) {
      script = args[index + 1];
      index += 2;
      break;
    }
    return outside(name);
  }
  if (!script || index !== args.length || EXPANSION.test(script.expandable) || depth >= NESTING_LIMIT)
    return outside(name);
  return classifyAt(script.value, depth + 1);
}

// --- one program -----------------------------------------------------------------------------------------

/** The folders of system programs. A program in another folder may be anything with a known name. */
const SYSTEM_FOLDERS: ReadonlySet<string> = new Set([
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/sbin",
  "/sbin",
]);

/** The effect of one program with its arguments; `words[0]` is the program. */
function program(words: readonly ShellWord[], depth: number): CommandEffect {
  const first = words[0];
  if (!first) return result("read", "");
  // A word that the shell changes when it runs: a variable, a substitution, `<( )`.
  if (words.some((word) => EXPANSION.test(word.expandable) || word.subcommands.length > 0)) return outside("expansion");
  const slash = first.value.lastIndexOf("/");
  // `./git` or `/tmp/git` is not git.
  if (slash >= 0 && !SYSTEM_FOLDERS.has(first.value.slice(0, slash))) return outside(programName(first.value));
  const typed = slash >= 0 ? first.value.slice(slash + 1) : first.value;
  const name = ALIASES[typed] ?? typed;
  const args = words.slice(1);
  if (SHELLS.has(name)) return shell(name, args, depth);
  switch (name) {
    case "git":
      return git(args);
    case "gh":
      return gh(args);
    case "curl":
      return curl(args);
    case "http":
    case "https":
    case "xh":
    case "xhs":
      return httpie(name, args);
    case "sed":
      return sed(args);
    case "awk":
      return awk(typed, args);
    case "find":
      return find(args);
  }
  const rule = Object.hasOwn(PROGRAMS, name) ? PROGRAMS[name] : undefined;
  if (!rule) return outside(name.slice(0, LABEL_LIMIT));
  const parsed = parse(args, rule.flags);
  const reach = parsed ? (rule.check ? rule.check(parsed) : rule.reach) : null;
  return reach ? result(reach, name) : outside(`${name} (flag)`);
}

/** Words before the program that the shell reads: `if`, `while`, `!`, `{`, `then`, `else`, `do`. */
const KEYWORDS: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "do", "while", "until", "!", "{"]);

/**
 * Variables that a command may set before a program. Any other one can make a program run another,
 * such as `GIT_SSH_COMMAND`, `PAGER`, `LESSOPEN`, `NODE_OPTIONS`, `LD_PRELOAD`, `HOME` or `PATH`.
 */
const SAFE_VARIABLES: ReadonlySet<string> = new Set(
  split(
    "LANG LANGUAGE LC_ALL LC_CTYPE LC_COLLATE LC_MESSAGES LC_NUMERIC LC_TIME TZ TERM NO_COLOR FORCE_COLOR CLICOLOR COLUMNS CI GIT_TERMINAL_PROMPT",
  ),
);

const NETWORK_FILE = /^\/dev\/(?:tcp|udp)\//u;
const NOTHING = /^(?:\/dev\/(?:null|stdout|stderr|tty)|&?\d)$/u;

/** The effect of the redirections of a segment: a network file sends, a file written is a local change. */
function redirections(segment: ShellSegment): CommandEffect | null {
  for (const word of [...segment.inputs, ...segment.outputs, ...segment.hereStrings])
    if (EXPANSION.test(word.expandable) || word.subcommands.length > 0) return outside("redirection");
  if ([...segment.inputs, ...segment.outputs].some((word) => NETWORK_FILE.test(word.value)))
    return outside("network redirection");
  return segment.outputs.some((word) => !NOTHING.test(word.value)) ? result("local", "write to a file") : null;
}

function segmentEffect(segment: ShellSegment, depth: number): CommandEffect {
  const words = segment.words;
  let index = 0;
  for (; index < words.length; index += 1) {
    const word = words[index];
    if (!word) break;
    if (KEYWORDS.has(word.value)) continue;
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(word.value);
    if (!assignment) break;
    if (!SAFE_VARIABLES.has(assignment[1] ?? "") || EXPANSION.test(word.expandable))
      return outside(`variable ${assignment[1]}`);
  }
  const own = index < words.length ? program(words.slice(index), depth) : result("read", "");
  const redirected = redirections(segment);
  if (!redirected || RANK[own.reach] >= RANK[redirected.reach]) return own;
  return redirected.reach === "local" && own.label ? { ...redirected, label: own.label } : redirected;
}

function classifyAt(command: string, depth: number): CommandEffect {
  // The network files of bash and an output process substitution, also where the reader does not look,
  // as in a here-document.
  if (/\/dev\/(?:tcp|udp)\//u.test(command)) return outside("network redirection");
  if (command.includes(">(")) return outside("process substitution");
  const { statements, cut } = readShell(command, STATEMENT_LIMIT);
  let strongest = result("read", "");
  for (const statement of statements)
    for (const segment of statement.segments) {
      const effect = segmentEffect(segment, depth);
      if (RANK[effect.reach] > RANK[strongest.reach] || (strongest.label === "" && effect.reach === strongest.reach))
        strongest = effect;
    }
  // A command too long to read to its end may hold anything after the cut.
  if (cut) return outside(strongest.label || "long command");
  return strongest;
}

/** The effect of a shell command, as the provider reported it (`commandExecution.command`, Bash `command`). */
export function classifyCommand(command: string): CommandEffect {
  const effect = classifyAt(command, 0);
  return effect.label ? effect : { ...effect, label: "command" };
}
