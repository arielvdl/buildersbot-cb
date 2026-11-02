/**
 * What a shell command can change, for the effect journal of a turn (`turn-effects.ts`). See
 * `docs/architecture/agents.md#safe-turn-resume`.
 *
 * This is not a shell and not a security check: it reads enough of a command to prove that it only
 * reads or only changes this computer. It fails closed. A command is `read` or `local` only when each of
 * its parts is a known program with arguments that this file reads completely; anything else is
 * `external`: a program that it does not know, a flag that it cannot read, a variable or a substitution
 * where an argument or a program decides what runs, a program that runs another program, and a wrapper
 * that adds arguments. A wrong `external` only makes the app ask the person; a wrong `read` could make a
 * resumed turn post, push or pay a second time.
 */
import { commandIndex, programName, readShell, type ShellSegment, type ShellWord } from "../guard/guard-shell";

/** `read`: safe to run again. `local`: changes only this computer. `external`: can change something else. */
export type EffectReach = "read" | "local" | "external";

export interface CommandEffect {
  reach: EffectReach;
  /**
   * A short name of the strongest part, such as `git push` or `curl (sends data)`: the program and its
   * subcommand, never its arguments, so it holds no text of the task or a token.
   */
  label: string;
  /** A read-only command that shows whether the action already ran, or null when there is none. */
  check: string | null;
}

const RANK: Record<EffectReach, number> = { read: 0, local: 1, external: 2 };
const STATEMENT_LIMIT = 64;
/** The depth of `$( )`, backticks and `sh -c` that is read. A command nested deeper is `external`. */
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

/** Programs that only read, whatever their arguments, as far as they are listed here. */
const READ_PROGRAMS: ReadonlySet<string> = new Set(
  (
    "ls cat head tail grep egrep fgrep ack pwd echo printf wc uniq cut tr diff cmp comm jq yq which whereis type " +
    "file stat du df tree realpath dirname basename whoami id uname printenv ps pgrep true false test [ [[ : sleep " +
    "seq nl column sha1sum sha256sum shasum md5 md5sum base64 xxd od strings readlink help lsof cd pushd popd exit " +
    "wait history fold fmt nproc sw_vers uptime free vm_stat top unset unalias read set fi done esac } then else " +
    "pbpaste"
  ).split(" "),
);

/** Programs that change only this computer and run no other program. */
const LOCAL_PROGRAMS: ReadonlySet<string> = new Set(
  (
    "mkdir touch cp mv rm rmdir ln chmod chown gzip gunzip bzip2 bunzip2 xz unxz unzip install trash kill pkill " +
    "killall pbcopy say afplay sips shellcheck shfmt gofmt rustfmt tsc biome black ruff isort pyright swiftlint " +
    "patch tee dd"
  ).split(" "),
);

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
/** Commands that run the command after them with arguments of their own, or later, or again. */
const RUNNERS: ReadonlySet<string> = new Set([
  "xargs",
  "parallel",
  "watch",
  "flock",
  "trap",
  "crontab",
  "at",
  "batch",
  "eval",
  "source",
  ".",
]);

/**
 * Variables that a command may set before a program. Any other one can make a program run another,
 * such as `GIT_SSH_COMMAND`, `PAGER`, `EDITOR`, `NODE_OPTIONS`, `LD_PRELOAD`, `HOME` or `PATH`.
 */
const SAFE_VARIABLES: ReadonlySet<string> = new Set(
  (
    "LANG LANGUAGE LC_ALL LC_CTYPE LC_COLLATE LC_MESSAGES LC_NUMERIC LC_TIME TZ TERM NO_COLOR FORCE_COLOR CLICOLOR " +
    "CLICOLOR_FORCE COLUMNS LINES CI NODE_ENV RUST_BACKTRACE RUST_LOG PYTHONUNBUFFERED PYTHONDONTWRITEBYTECODE " +
    "GIT_TERMINAL_PROMPT"
  ).split(" "),
);

/** The folders of system programs. A program in another folder may be anything with a known name. */
const SYSTEM_FOLDERS: ReadonlySet<string> = new Set([
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/local/bin",
  "/usr/sbin",
  "/sbin",
]);

/** Words of the shell that look like operators but are programs or the end of a group. */
const SHELL_SYMBOLS: ReadonlySet<string> = new Set(["[", "[[", "}", ":"]);
/** Shell expansion left in a word: a variable, a substitution, or arithmetic. */
const EXPANSION = /[$`]/u;
/** A program word that the shell builds: an expansion, a glob, a brace, or an operator. */
const BUILT_PROGRAM = /[$`*?[\]{}()<>|;&!\\=]/u;

const isOption = (word: ShellWord) => word.value.startsWith("-");
const operands = (words: readonly ShellWord[]) => words.filter((word) => !isOption(word)).map((word) => word.value);
/** Whether the shell can change an argument when it runs: an unquoted variable can add words. */
const expands = (words: readonly ShellWord[]) => words.some((word) => EXPANSION.test(word.expandable));
/** A long option, or the long option with its value joined by `=`. */
const longOption = (word: ShellWord, ...names: string[]) =>
  names.some((name) => word.value === name || word.value.startsWith(`${name}=`));
/** A group of short options, such as `-sXPOST`, that holds one of `letters`. */
const shortGroup = (word: ShellWord, letters: string) =>
  /^-[^-]/u.test(word.value) && [...word.value.slice(1)].some((char) => letters.includes(char));

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The method of `-X POST`, `-XPOST`, `-sXPOST` or `--request=POST`, in upper case; "" when an `-X` has no
 * readable value, which counts as not read; null when there is none.
 */
function requestMethod(words: readonly ShellWord[], longNames: readonly string[]): string | null {
  let method: string | null = null;
  for (let index = 0; index < words.length; index += 1) {
    const value = words[index]?.value ?? "";
    const long = longNames.find((name) => value === name || value.startsWith(`${name}=`));
    if (long) method = (value === long ? (words[index + 1]?.value ?? "") : value.slice(long.length + 1)).toUpperCase();
    else if (/^-[^-]/u.test(value) && value.includes("X")) {
      const rest = value.slice(value.indexOf("X") + 1);
      method = (rest || (words[index + 1]?.value ?? "")).toUpperCase();
    }
  }
  return method;
}

const sendsMethod = (method: string | null) => method !== null && !READ_METHODS.has(method);

// --- git ---------------------------------------------------------------------------------------------

const GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(
  "--no-pager -P --paginate -p --bare --no-replace-objects --literal-pathspecs --glob-pathspecs --noglob-pathspecs --icase-pathspecs --no-optional-locks --no-lazy-fetch --no-advice".split(
    " ",
  ),
);
/** Global options whose value is a path or a name. `-c`, `--config-env` and `--exec-path` are not read. */
const GIT_GLOBAL_VALUES = ["-C", "--git-dir", "--work-tree", "--namespace"] as const;

const GIT_READ: ReadonlySet<string> = new Set(
  "status log diff show rev-parse ls-files ls-tree describe blame shortlog cat-file merge-base for-each-ref name-rev rev-list cherry whatchanged count-objects help version ls-remote fsck check-ignore check-attr var grep show-ref show-branch range-diff fast-export".split(
    " ",
  ),
);
const GIT_LOCAL: ReadonlySet<string> = new Set(
  "add commit checkout switch restore reset merge cherry-pick revert init mv rm clean apply am notes sparse-checkout gc prune repack fetch pull clone rebase format-patch bundle fast-import maintenance".split(
    " ",
  ),
);

/**
 * Arguments that make a git command run a program, contact another place, or load hooks: an upload or
 * receive pack, an exec, an external diff, a pager of files, an `ext::` remote, a template or config.
 */
function gitRunsProgram(sub: string, rest: readonly ShellWord[]): boolean {
  return rest.some(
    (word) =>
      longOption(
        word,
        "--upload-pack",
        "--receive-pack",
        "--exec",
        "--ext-diff",
        "--open-files-in-pager",
        "--template",
        "--config",
        "--separate-git-dir",
      ) ||
      /(?:^|[^a-z])(?:ext|fd)::/u.test(word.value) ||
      (sub === "grep" && /^-[^-]*O/u.test(word.value)) ||
      (sub === "rebase" && shortGroup(word, "x")) ||
      ((sub === "clone" || sub === "ls-remote" || sub === "fetch" || sub === "pull") &&
        (shortGroup(word, "u") || shortGroup(word, "c"))),
  );
}

function git(args: readonly ShellWord[]): CommandEffect {
  const check = "git status -sb && git log --oneline -3 @{upstream}";
  // An unquoted variable can add words anywhere: `git -C $repo status` can be a push.
  if (expands(args)) return outside("git (variable)", check);
  let index = 0;
  for (let word = args[index]; word && isOption(word); word = args[index]) {
    if (GIT_GLOBAL_FLAGS.has(word.value)) index += 1;
    else if (GIT_GLOBAL_VALUES.some((name) => word.value === name)) index += 2;
    else if (GIT_GLOBAL_VALUES.some((name) => word.value.startsWith(`${name}=`))) index += 1;
    // `-c alias.x=!cmd`, `-c core.hooksPath=…`, `--exec-path` and any option that this file does not read.
    else return outside("git (config)");
  }
  const subWord = args[index];
  const sub = subWord?.value ?? "";
  const rest = args.slice(index + 1);
  if (!subWord) return result("read", "git");
  if (gitRunsProgram(sub, rest)) return outside(`git ${sub}`, check);
  const words = operands(rest);
  if (GIT_READ.has(sub)) return result("read", `git ${sub}`);
  switch (sub) {
    case "reflog":
      return result(words.length === 0 || words[0] === "show" ? "read" : "local", `git reflog`);
    case "branch":
      if (rest.some((word) => longOption(word, "--edit-description"))) return outside("git branch");
      return result(
        rest.length === 0 || rest.every((word) => /^(?:-a|-r|-v|-vv|--all|--list|-l)$/u.test(word.value))
          ? "read"
          : "local",
        "git branch",
      );
    case "tag":
      return result(
        rest.length === 0 || rest.every((word) => /^(?:-l|--list|-n\d*)$/u.test(word.value)) ? "read" : "local",
        "git tag",
      );
    case "stash":
      return result(words[0] === "list" || words[0] === "show" ? "read" : "local", "git stash");
    case "worktree":
      return result(words[0] === "list" ? "read" : "local", "git worktree");
    case "remote":
      if (words.length === 0 || words[0] === "show" || words[0] === "get-url") return result("read", "git remote");
      return result("local", "git remote");
    case "config":
      // Only a read: a set can add an alias that runs a program, or hooks.
      return rest.length > 0 &&
        rest.some((word) => /^(?:--get|--get-all|--get-regexp|--list|-l)$/u.test(word.value)) &&
        rest.every(
          (word) =>
            /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--global|--local|--system|--name-only)$/u.test(
              word.value,
            ) || !isOption(word),
        )
        ? result("read", "git config")
        : outside("git config");
    case "bisect":
      return words[0] === "run" ? outside("git bisect run") : result("local", "git bisect");
    case "submodule":
      if (words[0] === "foreach") return outside("git submodule foreach");
      return result(words[0] === "status" || words[0] === "summary" ? "read" : "local", "git submodule");
    case "lfs":
      if (["pull", "fetch", "checkout", "track", "untrack", "install"].includes(words[0] ?? ""))
        return result("local", "git lfs");
      if (["ls-files", "status", "env", "version"].includes(words[0] ?? "")) return result("read", "git lfs");
      return outside(`git lfs ${words[0] ?? ""}`.trim(), check);
    default:
      if (GIT_LOCAL.has(sub)) return result("local", `git ${sub}`);
      // push, send-email, svn, p4, difftool, mergetool, filter-branch, archive, an alias of the repository, …
      return outside(`git ${sub}`, check);
  }
}

// --- gh ----------------------------------------------------------------------------------------------

const GH_READ_VERBS: ReadonlySet<string> = new Set(["list", "view", "status", "checks", "diff", "watch"]);
const GH_GROUPS: ReadonlySet<string> = new Set(
  "pr issue run release repo workflow label gist cache ruleset project secret variable codespace org".split(" "),
);

function gh(args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside("gh (variable)");
  // `-R owner/repo` names the repository anywhere on the line.
  const words: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (value === "-R" || value === "--repo") index += 1;
    else if (!value.startsWith("-")) words.push(value);
  }
  const [group = "", verb = ""] = words;
  if (group === "api") {
    const fields = args.some((word) => longOption(word, "--field", "--raw-field", "--input") || shortGroup(word, "fF"));
    const method = requestMethod(args, ["--method"]);
    if (fields || sendsMethod(method)) return outside("gh api (sends data)");
    return result("read", "gh api");
  }
  const check =
    group === "pr"
      ? "gh pr list --state all --limit 10"
      : group === "issue"
        ? "gh issue list --state all --limit 10"
        : group === "release"
          ? "gh release list --limit 10"
          : null;
  if (group === "status" || group === "search" || (group === "auth" && verb === "status"))
    return result("read", `gh ${group}`);
  if ((group === "repo" && verb === "clone") || (group === "pr" && verb === "checkout"))
    return result("local", `gh ${group} ${verb}`);
  if (GH_GROUPS.has(group) && verb === "download") return result("local", `gh ${group} download`);
  if (
    GH_GROUPS.has(group) &&
    GH_READ_VERBS.has(verb) &&
    !args.some((word) => longOption(word, "--web") || word.value === "-w")
  )
    return result("read", `gh ${group} ${verb}`);
  // A change, a browser, an extension or an alias that this file does not know.
  return outside(`gh ${group} ${verb}`.trim(), check);
}

// --- HTTP clients --------------------------------------------------------------------------------------

/** A URL of a scheme other than HTTP: curl sends mail, writes Redis or publishes MQTT with them. */
const OTHER_SCHEME = /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//iu;

function curl(args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside("curl (variable)");
  const sends = args.some(
    (word) =>
      longOption(
        word,
        "--data",
        "--data-raw",
        "--data-binary",
        "--data-urlencode",
        "--data-ascii",
        "--json",
        "--form",
        "--form-string",
        "--upload-file",
        "--config",
        "--mail-from",
        "--mail-rcpt",
        "--mail-auth",
      ) ||
      // A data, form, upload or config flag, alone, grouped or with its value: `-d@f`, `-sd`, `-Ffile=@a`.
      shortGroup(word, "dFTK") ||
      OTHER_SCHEME.test(word.value),
  );
  if (sends || sendsMethod(requestMethod(args, ["--request"]))) return outside("curl (sends data)");
  const writes = args.some(
    (word) =>
      longOption(word, "--output", "--remote-name", "--remote-name-all", "--output-dir") || shortGroup(word, "oO"),
  );
  return result(writes ? "local" : "read", "curl");
}

function wget(args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside("wget (variable)");
  const sends = args.some(
    (word) =>
      longOption(
        word,
        "--post-data",
        "--post-file",
        "--body-data",
        "--body-file",
        "--execute",
        "--config",
        "--use-askpass",
      ) ||
      shortGroup(word, "e") ||
      OTHER_SCHEME.test(word.value.replace(/^ftps?:\/\//iu, "https://")),
  );
  if (sends || sendsMethod(requestMethod(args, ["--method"]))) return outside("wget (sends data)");
  return result("local", "wget");
}

/** HTTPie and xh: `http POST url key=value`. A method, a field or a form sends data. */
function httpie(name: string, args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside(`${name} (variable)`);
  const words = operands(args);
  const method = words[0] && /^[A-Za-z]+$/u.test(words[0]) && words.length > 1 ? words[0].toUpperCase() : null;
  const items = words.slice(method ? 2 : 1).some((word) => /[=@]|:=/u.test(word));
  if (
    sendsMethod(method) ||
    items ||
    args.some((word) => longOption(word, "--form", "--raw", "--multipart") || shortGroup(word, "f"))
  )
    return outside(`${name} (sends data)`);
  return result("read", name);
}

// --- programs that run other programs or project code ----------------------------------------------------

/** npm, pnpm, yarn and bun: only a read of the registry or of the installed tree; scripts run project code. */
function packageManager(name: string, args: readonly ShellWord[]): CommandEffect {
  const [verb = "", next = ""] = operands(args);
  if (
    (args.length > 0 && args.every((word) => /^(?:-v|--version|-h|--help)$/u.test(word.value))) ||
    ["ls", "list", "outdated", "view", "info", "why", "explain"].includes(verb) ||
    (verb === "audit" && !args.some((word) => word.value === "fix" || longOption(word, "--fix"))) ||
    (verb === "config" && (next === "get" || next === "list")) ||
    (verb === "pm" && next === "ls")
  )
    return result("read", `${name} ${verb}`.trim());
  if (verb === "publish") return outside(`${name} publish`, name === "npm" ? "npm view <package> versions" : null);
  // install, run, test, exec, version, pack: each runs scripts of the project or of a package.
  return outside(`${name} ${verb}`.trim());
}

const CLOUD_READ =
  /^(?:get|list|ls|describe|show|view|logs|explain|top|version|status|whoami|template|lint|history|search|get-[\w-]+|list-[\w-]+|describe-[\w-]+|head-object)$/u;
const CLOUD_CHANGE =
  /^(?:exec|port-forward|proxy|attach|cp|sync|mv|rm|run|ssh|scp|tunnel|login|logout|configure|auth|apply|delete|create|deploy|push|put|post|patch|set|update|import|scale|rollout|replace|edit|label|annotate|taint|publish|send|invoke|start|stop|terminate|install|upgrade|uninstall|rollback|(?:put|create|delete|update|invoke|start|stop|send|publish|attach|detach|modify|run|execute|import|register|deregister|enable|disable|reboot|copy|restore|reset|associate|disassociate|authorize|revoke|tag|untag)-[\w-]+)$/u;

function cloudCli(name: string, args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside(`${name} (variable)`);
  const words = operands(args);
  if (name === "terraform" || name === "tofu") {
    // A plan can run programs (the `external` data source); only these commands do not.
    if (["validate", "version", "show", "output", "providers", "graph"].includes(words[0] ?? ""))
      return result("read", `${name} ${words[0]}`);
    if (words[0] === "fmt") return result("local", `${name} fmt`);
    if (words[0] === "state" && (words[1] === "list" || words[1] === "show")) return result("read", `${name} state`);
    return outside(`${name} ${words[0] ?? ""}`.trim());
  }
  if (words.some((word) => CLOUD_READ.test(word)) && !words.some((word) => CLOUD_CHANGE.test(word)))
    return result("read", `${name} ${words[0] ?? ""}`.trim());
  return outside(`${name} ${words[0] ?? ""}`.trim());
}

function docker(name: string, args: readonly ShellWord[]): CommandEffect {
  const [verb = ""] = operands(args);
  if (/^(?:ps|images|inspect|logs|version|info|stats|top|history|diff|port)$/u.test(verb) && !expands(args))
    return result("read", `${name} ${verb}`);
  // build runs the steps of a Dockerfile, run and compose run anything, push and login send.
  return outside(`${name} ${verb}`.trim());
}

function interpreter(name: string, args: readonly ShellWord[]): CommandEffect {
  const words = args.map((word) => word.value);
  if (words.length > 0 && words.every((word) => /^(?:-V|--version|-h|--help)$/u.test(word)))
    return result("read", name);
  if (name === "node" && words.length === 2 && (words[0] === "--check" || words[0] === "-c"))
    return result("read", "node --check");
  const moduleIndex = words.indexOf("-m");
  const module = moduleIndex >= 0 ? words[moduleIndex + 1] : undefined;
  if (module === "json.tool") return result("read", `${name} -m json.tool`);
  if (module === "venv" || module === "py_compile" || module === "compileall")
    return result("local", `${name} -m ${module}`);
  // A script, `-c`, `-e` or a module such as pip or pytest runs code that this file cannot read.
  return outside(name);
}

function buildTool(name: string, args: readonly ShellWord[]): CommandEffect {
  const words = operands(args);
  const verb = words[0] ?? "";
  if (args.length > 0 && args.every((word) => /^(?:-V|--version|-h|--help|version)$/u.test(word.value)))
    return result("read", name);
  if (name === "cargo" && (verb === "fmt" || verb === "metadata" || verb === "tree" || verb === "locate-project"))
    return result(verb === "fmt" ? "local" : "read", `cargo ${verb}`);
  if (name === "go") {
    if (["list", "env", "version", "doc"].includes(verb)) return result("read", `go ${verb}`);
    if (["fmt", "vet", "build", "mod", "get", "install"].includes(verb)) return result("local", `go ${verb}`);
  }
  if (
    ["list", "show", "freeze", "outdated", "info", "search"].includes(verb) &&
    /^(?:pip|pip3|brew|gem|uv|poetry)$/u.test(name)
  )
    return result("read", `${name} ${verb}`);
  // A build runs build scripts (build.rs, Gradle, MSBuild, package plugins), a test or run runs code,
  // an install runs package code, and a publish sends.
  return outside(`${name} ${verb}`.trim());
}

function rsync(args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside("rsync (variable)");
  const remote =
    args.some((word) => longOption(word, "--rsh", "--rsync-path") || shortGroup(word, "e")) ||
    operands(args).some((word) => /^[^/\s]+:/u.test(word) && !/^[A-Za-z]:\\/u.test(word));
  return remote ? outside("rsync (remote)") : result("local", "rsync");
}

function tar(args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside("tar (variable)");
  const runs = args.some(
    (word) =>
      longOption(
        word,
        "--to-command",
        "--checkpoint-action",
        "--use-compress-program",
        "--info-script",
        "--new-volume-script",
        "--rsh-command",
        "--rmt-command",
      ) ||
      shortGroup(word, "IF") ||
      // A remote archive, `-f host:file`.
      (!word.value.startsWith("--") && word.value.includes(":")),
  );
  return runs ? outside("tar (runs a program)") : result("local", "tar");
}

function sed(args: readonly ShellWord[]): CommandEffect {
  if (expands(args)) return outside("sed (variable)");
  const scripts: string[] = [];
  let inPlace = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const word = args[index];
    if (!word) break;
    const value = word.value;
    if (value === "--") break;
    if (longOption(word, "--file") || /^-[^-]*f/u.test(value)) return outside("sed (script file)");
    if (value === "-e" || value === "--expression") {
      scripts.push(args[index + 1]?.value ?? "");
      index += 1;
    } else if (value.startsWith("--expression=")) scripts.push(value.slice("--expression=".length));
    else if (longOption(word, "--in-place") || /^-[^-]*[iI]/u.test(value)) {
      inPlace = true;
      // BSD sed: `-i ''` or `-i .bak` names the backup suffix.
      const next = args[index + 1]?.value;
      if ((value === "-i" || value === "-I") && next !== undefined && (next === "" || /^\.[\w.-]*$/u.test(next)))
        index += 1;
    } else if (!value.startsWith("-")) break;
  }
  if (scripts.length === 0) scripts.push(args[index]?.value ?? "");
  if (!scripts.every(safeSedScript)) return outside("sed (runs or writes)");
  return result(inPlace ? "local" : "read", inPlace ? "sed -i" : "sed");
}

const SED_ADDRESS = String.raw`(?:\d+|\$|/(?:\\.|[^/\\])*/)(?:,(?:\d+|\$|/(?:\\.|[^/\\])*/|\+\d+))?!?`;
const SED_SIMPLE = new RegExp(`^(?:${SED_ADDRESS})?\\s*[pdqQ=nNPDgGhHxl{}]?$`, "u");

/**
 * Whether a sed script only prints, deletes or substitutes: each command is one that this file knows,
 * and no substitution has the `e` or `w` flag. A command that runs (`e`) or writes (`w`), or a script that
 * this file does not read completely, is not safe.
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
      const delimiter = substitution[2];
      const parts = splitByDelimiter(command.slice(2), delimiter);
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

function awk(name: string, args: readonly ShellWord[]): CommandEffect {
  let program: ShellWord | undefined;
  for (let index = 0, word = args[0]; word; index += 1, word = args[index]) {
    const value = word.value;
    if (value === "--") {
      program = args[index + 1];
      break;
    }
    if (/^-[^-]*[fiElL]/u.test(value) || longOption(word, "--file", "--include", "--load", "--exec", "--source"))
      return outside(`${name} (program file)`);
    if (value === "-v" || value === "-F" || value === "--assign" || value === "--field-separator") index += 1;
    else if (!value.startsWith("-")) {
      program = word;
      break;
    }
  }
  if (!program || EXPANSION.test(program.expandable)) return outside(`${name} (program)`);
  // `system()`, a pipe, `getline` from a command, an output redirection or an extension can run or write.
  if (/system|\||getline|>|@load|@include/u.test(program.value)) return outside(`${name} (runs or writes)`);
  return result("read", name);
}

function find(args: readonly ShellWord[], depth: number): CommandEffect {
  let strongest = result("read", "find");
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.value ?? "";
    if (/^-(?:exec|execdir|ok|okdir)$/u.test(value)) {
      const end = args.findIndex((word, at) => at > index && (word.value === ";" || word.value === "+"));
      const command = args.slice(index + 1, end < 0 ? args.length : end);
      if (end < 0 || command.length === 0 || depth >= NESTING_LIMIT) return outside("find -exec");
      // The command runs for each file: `{}` is a file name.
      const effect = program(command, depth + 1);
      if (RANK[effect.reach] > RANK[strongest.reach]) strongest = { ...effect, label: `find -exec ${effect.label}` };
      index = end;
    } else if (/^-(?:delete|fprint|fprint0|fprintf|fls)$/u.test(value) && strongest.reach === "read")
      strongest = result("local", "find");
  }
  return strongest;
}

/** `fd -x cmd`: the command after the flag runs for each file. */
function fd(args: readonly ShellWord[], depth: number): CommandEffect {
  const index = args.findIndex((word) => /^-(?:x|X)$/u.test(word.value) || longOption(word, "--exec", "--exec-batch"));
  if (index < 0) return result("read", "fd");
  const command = args.slice(index + 1);
  if (command.length === 0 || depth >= NESTING_LIMIT) return outside("fd -x");
  const effect = program(command, depth + 1);
  return { ...effect, label: `fd -x ${effect.label}`.slice(0, LABEL_LIMIT) };
}

/** `export`, `declare`: a variable that can make a later program run another one is not safe. */
function setsVariables(name: string, args: readonly ShellWord[]): CommandEffect {
  for (const word of args) {
    if (isOption(word)) {
      // `export -f`, `declare -f`: a function for later commands.
      if (/f/u.test(word.value.slice(1))) return outside(name);
      continue;
    }
    const variable = word.value.split("=")[0] ?? "";
    if (!SAFE_VARIABLES.has(variable)) return outside(`${name} ${variable}`);
  }
  return result("read", name);
}

/** Whether every argument is only a version or a help flag. */
const onlyHelp = (args: readonly ShellWord[]) =>
  args.length > 0 && args.every((word) => /^(?:-V|-v|--version|-h|--help)$/u.test(word.value));

/** The effect of one program with its arguments; `words[0]` is the program. */
function program(words: readonly ShellWord[], depth: number): CommandEffect {
  const first = words[0];
  if (!first) return result("read", "");
  // A program that a variable, a substitution, a glob or an escape names may be any program.
  if (
    !first.value ||
    (!SHELL_SYMBOLS.has(first.value) && BUILT_PROGRAM.test(first.value)) ||
    EXPANSION.test(first.expandable)
  )
    return outside("a built program name");
  const slash = first.value.lastIndexOf("/");
  // `./git` or `/tmp/git` is not git.
  if (slash >= 0 && !SYSTEM_FOLDERS.has(first.value.slice(0, slash))) return outside(programName(first.value));
  const name = programName(first.value);
  const args = words.slice(1);
  if (SHELLS.has(name)) {
    // `bash -lc "git push"`: the text after a `-c` flag is a command of its own.
    const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word.value));
    const script = flag >= 0 ? args[flag + 1] : undefined;
    if (script !== undefined && depth < NESTING_LIMIT && !EXPANSION.test(script.expandable))
      return classifyAt(script.value, depth + 1);
    return outside(name);
  }
  if (RUNNERS.has(name)) return outside(name);
  switch (name) {
    case "git":
      return git(args);
    case "gh":
      return gh(args);
    case "curl":
      return curl(args);
    case "wget":
      return wget(args);
    case "http":
    case "https":
    case "xh":
      return httpie(name, args);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
      return packageManager(name, args);
    case "docker":
    case "podman":
      return docker(name, args);
    case "rsync":
      return rsync(args);
    case "tar":
      return tar(args);
    case "zip":
      return args.some((word) => longOption(word, "--unzip-command", "--test") || shortGroup(word, "T"))
        ? outside("zip (runs a program)")
        : result("local", "zip");
    case "sed":
    case "gsed":
      return sed(args);
    case "awk":
    case "gawk":
    case "mawk":
    case "nawk":
      return awk(name, args);
    case "find":
      return find(args, depth);
    case "fd":
      return fd(args, depth);
    case "rg":
      return args.some((word) => longOption(word, "--pre")) ? outside("rg --pre") : result("read", "rg");
    case "ag":
      return args.some((word) => longOption(word, "--pager")) ? outside("ag --pager") : result("read", "ag");
    case "sort":
      if (args.some((word) => longOption(word, "--compress-program"))) return outside("sort (runs a program)");
      return result(
        args.some((word) => longOption(word, "--output") || shortGroup(word, "o")) ? "local" : "read",
        "sort",
      );
    case "man":
      return args.some((word) => longOption(word, "--pager", "--html") || shortGroup(word, "PH"))
        ? outside("man (runs a program)")
        : result("read", "man");
    case "less":
    case "more":
      return args.some((word) => word.value.startsWith("+")) ? outside(name) : result("read", name);
    case "sysctl":
      return result(args.some((word) => word.value === "-w" || word.value.includes("=")) ? "local" : "read", "sysctl");
    case "date":
      return result(args.some((word) => longOption(word, "--set") || shortGroup(word, "s")) ? "local" : "read", "date");
    case "hostname":
      return result(operands(args).length > 0 ? "local" : "read", "hostname");
    case "export":
    case "declare":
    case "typeset":
    case "local":
    case "readonly":
      return setsVariables(name, args);
    case "alias":
      // An alias changes what a later word runs.
      return args.length === 0 ? result("read", "alias") : outside("alias");
    case "for":
    case "select":
      // A loop head: `for name in words`. Its body is a statement of its own.
      return args.length >= 2 && args[1]?.value === "in" && !BUILT_PROGRAM.test(args[0]?.value ?? "")
        ? result("read", name)
        : outside(name);
    case "case":
      return args.at(-1)?.value === "in" ? result("read", "case") : outside("case");
  }
  if (/^(?:aws|gcloud|gsutil|az|doctl|oci|kubectl|helm|terraform|tofu)$/u.test(name)) return cloudCli(name, args);
  if (/^(?:python|python3|python3\.\d+|node|deno|ruby|perl|php|lua)$/u.test(name)) return interpreter(name, args);
  if (/^(?:cargo|go|gradle|gradlew|mvn|dotnet|swift|uv|poetry|pip|pip3|brew|gem|twine)$/u.test(name))
    return buildTool(name, args);
  if (READ_PROGRAMS.has(name)) return result("read", name);
  if (LOCAL_PROGRAMS.has(name)) return result("local", name);
  if (onlyHelp(args) && /^(?:make|npx|bunx|pnpx|ssh|scp|rsync|osascript|open|code)$/u.test(name))
    return result("read", name);
  // A program, a script, a test runner, a build tool, a runner of packages (`npx`, `bunx`), `make`, a deploy
  // tool, `ssh`, `osascript`, `open`, `sqlite3`, `ffmpeg`, … : it can send anything.
  return outside(name);
}

/**
 * What the output redirections of a segment do: a file is a local change; `/dev/null` and the terminal
 * are nothing; a target that a variable names may be `/dev/tcp/…`, which sends.
 */
function outputEffect(segment: ShellSegment): CommandEffect | null {
  if (segment.outputs.some((word) => EXPANSION.test(word.expandable))) return outside("redirection to a variable");
  return segment.outputs.some((word) => !/^(?:\/dev\/(?:null|stdout|stderr|tty)|&?[12])$/u.test(word.value))
    ? result("local", "write to a file")
    : null;
}

function classifyAt(command: string, depth: number): CommandEffect {
  // The network files of bash, and an output process substitution, which the reader does not see.
  if (/\/dev\/(?:tcp|udp)\//u.test(command)) return outside("network redirection");
  if (command.includes(">(")) return outside("process substitution");
  const { statements, cut } = readShell(command, STATEMENT_LIMIT);
  let strongest = result("read", "");
  const consider = (effect: CommandEffect) => {
    if (
      RANK[effect.reach] > RANK[strongest.reach] ||
      (strongest.label === "" && RANK[effect.reach] === RANK[strongest.reach])
    )
      strongest = effect;
  };
  for (const statement of statements) {
    for (const segment of statement.segments) {
      const index = commandIndex(segment.words);
      const before = index < 0 ? segment.words : segment.words.slice(0, index);
      // A variable before the program (`GIT_SSH_COMMAND=… git fetch`), or set alone for later programs.
      for (const word of before) {
        const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(word.value);
        if (assignment?.[1] && !SAFE_VARIABLES.has(assignment[1])) consider(outside(`variable ${assignment[1]}`));
        if (assignment) continue;
        // `xargs` adds arguments that this file does not see.
        if (RUNNERS.has(programName(word.value))) consider(outside(programName(word.value)));
        // `env -S "…"` splits a text into a command.
        if (
          longOption(word, "--split-string") ||
          (/^-[^-]*S/u.test(word.value) && before.some((other) => programName(other.value) === "env"))
        )
          consider(outside("env -S"));
      }
      if (index >= 0) consider(program(segment.words.slice(index), depth));
      const output = outputEffect(segment);
      if (output)
        consider(output.reach === "local" && strongest.label ? { ...output, label: strongest.label } : output);
      // `echo $(curl -X POST …)`: each subcommand runs too, also in a redirection or a here-string.
      for (const word of [...segment.words, ...segment.inputs, ...segment.outputs, ...segment.hereStrings]) {
        for (const sub of word.subcommands) {
          if (depth >= NESTING_LIMIT) consider(outside("nested command"));
          else consider(classifyAt(sub.text, depth + 1));
        }
      }
    }
  }
  // A command too long to read to its end may hold anything after the cut.
  if (cut) consider(outside(strongest.label || "long command"));
  return strongest;
}

/** The effect of a shell command, as the provider reported it (`commandExecution.command`, Bash `command`). */
export function classifyCommand(command: string): CommandEffect {
  const effect = classifyAt(command, 0);
  return effect.label ? effect : { ...effect, label: "command" };
}
