/**
 * What a shell command can change, for the effect journal of a turn (`turn-effects.ts`). See
 * `docs/architecture/agents.md#safe-turn-resume`.
 *
 * This is not a shell and not a security check: it reads enough of a command to tell a read from a
 * local change and from an action that leaves this computer. It is strict on purpose. A program that it
 * does not know is `external`, because a script can send anything; a wrong `external` only makes the
 * app ask the person, while a wrong `read` could make it repeat a post or a push.
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
const NESTING_LIMIT = 3;

export function strongerReach(left: EffectReach, right: EffectReach): EffectReach {
  return RANK[right] > RANK[left] ? right : left;
}

const READ_PROGRAMS: ReadonlySet<string> = new Set(
  (
    "ls cat head tail less more grep egrep fgrep rg ag ack fd pwd echo printf wc sort uniq cut tr diff cmp comm " +
    "jq yq which whereis type file stat du df tree realpath dirname basename date whoami id uname hostname " +
    "printenv ps pgrep true false test [ [[ sleep seq nl column sha1sum sha256sum shasum md5 md5sum base64 xxd od " +
    "strings readlink man help lsof cd pushd popd exit set export unset read wait history alias column fold fmt " +
    "nproc sysctl sw_vers uptime free vm_stat top"
  ).split(" "),
);

/** Programs that change only this computer, whatever their arguments. */
const LOCAL_PROGRAMS: ReadonlySet<string> = new Set(
  (
    "mkdir touch cp mv rm rmdir ln chmod chown tar zip unzip gzip gunzip bzip2 xz unxz 7z patch tee install " +
    "tsc vitest jest mocha biome eslint prettier ruff black isort mypy pyright pytest swiftc swiftlint clang gcc " +
    "g++ cc ld rustc rustfmt gofmt shellcheck shfmt ffmpeg ffprobe magick convert sips pandoc trash kill pkill " +
    "killall open code pbcopy pbpaste say afplay sqlite3 xcodebuild xcrun pod"
  ).split(" "),
);

/** Programs that reach another computer by design. */
const NETWORK_PROGRAMS: ReadonlySet<string> = new Set(
  (
    "ssh scp sftp ftp telnet nc ncat netcat socat mosh mail mailx sendmail mutt msmtp osascript vercel netlify " +
    "wrangler flyctl fly heroku firebase railway render amplify sam serverless sls cdk pulumi stripe twilio " +
    "slack-cli psql mysql mongo mongosh redis-cli eval source . exec"
  ).split(" "),
);

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);

/** npm, pnpm, yarn and bun scripts that only build or check this computer's work. */
const LOCAL_SCRIPT = /^(?:test|build|lint|typecheck|check|format|fmt|compile|clean|e2e|storybook)(?:[:-][\w:.-]*)?$/u;
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_LOCAL: ReadonlySet<string> = new Set(
  "install i ci add remove rm uninstall un update up upgrade link unlink dedupe prune init outdated ls list why info view audit pack version cache config test t".split(
    " ",
  ),
);
const PACKAGE_RUNNERS: ReadonlySet<string> = new Set(["npx", "bunx", "pnpx"]);

const result = (reach: EffectReach, label: string, check: string | null = null): CommandEffect => ({
  reach,
  label,
  check,
});

/** The words after the program that are not flags: the subcommand path, such as `pr create`. */
function operands(words: readonly ShellWord[]): string[] {
  return words.filter((word) => !word.value.startsWith("-")).map((word) => word.value);
}

function hasFlag(words: readonly ShellWord[], ...flags: string[]): boolean {
  return words.some((word) =>
    flags.some((flag) => word.value === flag || (flag.startsWith("--") && word.value.startsWith(`${flag}=`))),
  );
}

/** The value of `-X POST`, `-XPOST` or `--request=POST`, in upper case, or null. */
function requestMethod(words: readonly ShellWord[]): string | null {
  for (let index = 0; index < words.length; index += 1) {
    const value = words[index]?.value ?? "";
    if (value === "-X" || value === "--request" || value === "--method")
      return (words[index + 1]?.value ?? "").toUpperCase();
    if (/^-X[A-Za-z]+$/u.test(value)) return value.slice(2).toUpperCase();
    const joined = /^--(?:request|method)=(.+)$/u.exec(value);
    if (joined?.[1]) return joined[1].toUpperCase();
  }
  return null;
}

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

function git(args: readonly ShellWord[]): CommandEffect {
  // `git -C dir push`: the options before the subcommand, with the values of -C and -c.
  let index = 0;
  while (index < args.length && args[index]?.value.startsWith("-")) {
    index += args[index]?.value === "-C" || args[index]?.value === "-c" ? 2 : 1;
  }
  const sub = args[index]?.value ?? "";
  const rest = args.slice(index + 1);
  if (sub === "push" || sub === "send-email" || sub === "svn") {
    return result("external", `git ${sub}`, "git status -sb && git log --oneline -3 @{upstream}");
  }
  if (sub === "lfs" && rest[0]?.value === "push") return result("external", "git lfs push");
  const read = new Set(
    "status log diff show rev-parse ls-files ls-tree ls-remote describe blame shortlog reflog cat-file grep check-ignore merge-base for-each-ref name-rev rev-list cherry whatchanged count-objects fsck help version request-pull".split(
      " ",
    ),
  );
  if (read.has(sub) || sub === "") return result("read", `git ${sub}`.trim());
  if (sub === "branch" && !hasFlag(rest, "-d", "-D", "-m", "-M", "-c", "-C", "--delete", "--move", "--copy"))
    return result(operands(rest).length === 0 ? "read" : "local", "git branch");
  if ((sub === "tag" || sub === "stash" || sub === "worktree" || sub === "remote") && operands(rest).length === 0)
    return result("read", `git ${sub}`);
  if ((sub === "stash" || sub === "worktree") && rest[0]?.value === "list") return result("read", `git ${sub} list`);
  if (sub === "config" && hasFlag(rest, "--get", "--list", "-l", "--get-all")) return result("read", "git config");
  // add, commit, checkout, merge, rebase, reset, fetch, pull, clone, tag, stash and the rest stay here.
  return result("local", `git ${sub}`);
}

const GH_READ_VERBS: ReadonlySet<string> = new Set(["list", "view", "status", "checks", "diff", "watch", "download"]);

function gh(args: readonly ShellWord[]): CommandEffect {
  const [group = "", verb = ""] = operands(args);
  if (group === "api") {
    const method = requestMethod(args);
    const sends = hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
    if ((method === null && !sends) || (method !== null && READ_METHODS.has(method))) return result("read", "gh api");
    return result("external", "gh api (sends data)");
  }
  if (group === "auth" || group === "search" || group === "browse" || group === "help" || group === "version")
    return result("read", `gh ${group}`);
  if (group === "repo" && verb === "clone") return result("local", "gh repo clone");
  if (GH_READ_VERBS.has(verb) || (group === "status" && verb === ""))
    return result("read", `gh ${group} ${verb}`.trim());
  const check =
    group === "pr"
      ? "gh pr list --state all --limit 10"
      : group === "issue"
        ? "gh issue list --state all --limit 10"
        : group === "release"
          ? "gh release list --limit 10"
          : null;
  return result("external", `gh ${group} ${verb}`.trim(), check);
}

function curl(args: readonly ShellWord[]): CommandEffect {
  const method = requestMethod(args);
  const sends = hasFlag(
    args,
    "-d",
    "--data",
    "--data-raw",
    "--data-binary",
    "--data-urlencode",
    "--data-ascii",
    "--json",
    "-F",
    "--form",
    "--form-string",
    "-T",
    "--upload-file",
  );
  if (sends || (method !== null && !READ_METHODS.has(method))) return result("external", "curl (sends data)");
  return result("read", "curl");
}

function wget(args: readonly ShellWord[]): CommandEffect {
  const method = requestMethod(args);
  if (
    hasFlag(args, "--post-data", "--post-file", "--body-data", "--body-file") ||
    (method && !READ_METHODS.has(method))
  )
    return result("external", "wget (sends data)");
  return result("local", "wget");
}

/** HTTPie and xh: `http POST url key=value`. A field or a method that writes sends data. */
function httpie(name: string, args: readonly ShellWord[]): CommandEffect {
  const words = operands(args);
  const method = words[0] && /^[A-Z]+$/u.test(words[0]) ? words[0] : null;
  const fields = words.slice(method ? 2 : 1).some((word) => /^[^=:\s]+(?::=|=|@)/u.test(word));
  if ((method && !READ_METHODS.has(method)) || fields || hasFlag(args, "-f", "--form", "--raw"))
    return result("external", `${name} (sends data)`);
  return result("read", name);
}

function packageManager(name: string, args: readonly ShellWord[]): CommandEffect {
  const [verb = "", script = ""] = operands(args);
  if (verb === "publish" || verb === "deploy" || verb === "release" || verb === "unpublish" || verb === "deprecate")
    return result("external", `${name} ${verb}`, name === "npm" ? "npm view <package> versions" : null);
  if (PACKAGE_LOCAL.has(verb)) return result("local", `${name} ${verb}`);
  if (verb === "run" || verb === "run-script") {
    return LOCAL_SCRIPT.test(script) ? result("local", `${name} run ${script}`) : result("external", `${name} run`);
  }
  // `bun x tool`, `bun file.ts`, `yarn tool`: a script or a program that the app does not know.
  if (name === "yarn" && LOCAL_SCRIPT.test(verb)) return result("local", `yarn ${verb}`);
  if (verb === "x" || verb === "exec" || verb === "dlx") return runner(`${name} ${verb}`, args.slice(1));
  return result("external", name);
}

/** `npx tool …`: the tool decides. */
function runner(label: string, args: readonly ShellWord[]): CommandEffect {
  const index = args.findIndex((word) => !word.value.startsWith("-"));
  if (index < 0) return result("external", label);
  const tool = programName(args[index]?.value ?? "").replace(/@[^/]*$/u, "");
  if (LOCAL_PROGRAMS.has(tool) || tool === "playwright") return result("local", `${label} ${tool}`);
  return program([...args.slice(index)], 0);
}

function cloudCli(name: string, args: readonly ShellWord[]): CommandEffect {
  const words = operands(args);
  // `aws s3 ls`, `gcloud compute instances list`, `kubectl get pods`: a verb that only reads.
  const reads = words.some((word) =>
    /^(?:get|list|ls|describe|show|view|logs|explain|top|version|status|whoami|plan|validate|fmt|template|lint|head-object|get-[\w-]+|list-[\w-]+|describe-[\w-]+)$/u.test(
      word,
    ),
  );
  const writes = words.some((word) =>
    /^(?:apply|destroy|delete|create|deploy|push|put|post|patch|set|update|import|rm|mv|cp|sync|run|scale|rollout|replace|edit|label|annotate|taint|publish|send|invoke|start|stop|terminate|put-[\w-]+|create-[\w-]+|delete-[\w-]+|update-[\w-]+)$/u.test(
      word,
    ),
  );
  if (reads && !writes) return result("read", `${name} ${words[0] ?? ""}`.trim());
  return result("external", `${name} ${words[0] ?? ""}`.trim());
}

function docker(args: readonly ShellWord[]): CommandEffect {
  const [verb = "", next = ""] = operands(args);
  if (
    verb === "push" ||
    verb === "login" ||
    (verb === "image" && next === "push") ||
    (verb === "buildx" && hasFlag(args, "--push"))
  )
    return result("external", `docker ${verb}`);
  if (/^(?:ps|images|inspect|logs|version|info|stats|top|history|diff|port)$/u.test(verb))
    return result("read", `docker ${verb}`);
  return result("local", `docker ${verb}`.trim());
}

function interpreter(name: string, args: readonly ShellWord[]): CommandEffect {
  const words = args.map((word) => word.value);
  if (words.length === 0 || words.every((word) => /^(?:-V|--version|-h|--help)$/u.test(word)))
    return result("read", name);
  // `python -m pytest`, `python -m pip install`: a module that the app knows.
  const moduleIndex = words.indexOf("-m");
  const module = moduleIndex >= 0 ? words[moduleIndex + 1] : undefined;
  if (module && /^(?:pytest|pip|venv|unittest|mypy|black|ruff|isort|compileall|json\.tool|http\.server)$/u.test(module))
    return result(module === "json.tool" ? "read" : "local", `${name} -m ${module}`);
  return result("external", name);
}

function make(args: readonly ShellWord[]): CommandEffect {
  const targets = operands(args).filter((word) => !word.includes("="));
  if (targets.every((target) => LOCAL_SCRIPT.test(target) || target === "all" || target === "install"))
    return result("local", "make");
  return result("external", "make");
}

function buildTool(name: string, args: readonly ShellWord[]): CommandEffect {
  const words = operands(args);
  if (words.some((word) => /^(?:publish|deploy|upload|release|push)$/u.test(word)))
    return result(
      "external",
      `${name} ${words.find((word) => /^(?:publish|deploy|upload|release|push)$/u.test(word))}`,
    );
  if (words.includes("run")) return result("external", `${name} run`);
  return result("local", `${name} ${words[0] ?? ""}`.trim());
}

/** The effect of one program with its arguments; `words[0]` is the program. */
function program(words: readonly ShellWord[], depth: number): CommandEffect {
  const first = words[0];
  if (!first) return result("read", "");
  const name = programName(first.value);
  const args = words.slice(1);
  if (args.length > 0 && args.every((word) => /^(?:-V|-v|--version|-h|--help|help|version)$/u.test(word.value)))
    return result("read", name);
  if (SHELLS.has(name)) {
    // `bash -lc "git push"`: the text after a `-c` flag is a command of its own.
    const flag = args.findIndex((word) => /^-[a-z]*c[a-z]*$/u.test(word.value));
    const script = flag >= 0 ? args[flag + 1]?.value : undefined;
    if (script !== undefined && depth < NESTING_LIMIT) return classifyAt(script, depth + 1);
    return result("external", name);
  }
  if (name === "git") return git(args);
  if (name === "gh") return gh(args);
  if (name === "curl") return curl(args);
  if (name === "wget") return wget(args);
  if (name === "http" || name === "https" || name === "xh") return httpie(name, args);
  if (PACKAGE_MANAGERS.has(name)) return packageManager(name, args);
  if (PACKAGE_RUNNERS.has(name)) return runner(name, args);
  if (name === "docker" || name === "podman") return docker(args);
  if (/^(?:aws|gcloud|gsutil|az|doctl|oci|kubectl|helm|terraform|tofu)$/u.test(name)) return cloudCli(name, args);
  if (/^(?:python|python3|python3\.\d+|node|deno|ruby|perl|php|lua|osascript)$/u.test(name))
    return interpreter(name, args);
  if (name === "make" || name === "gmake") return make(args);
  if (/^(?:cargo|go|gradle|gradlew|mvn|dotnet|swift|uv|poetry|pip|pip3|brew|gem|twine)$/u.test(name)) {
    if (/^(?:twine|gem)$/u.test(name) && operands(args).some((word) => word === "upload" || word === "push"))
      return result("external", `${name} ${operands(args)[0]}`);
    return buildTool(name, args);
  }
  if (name === "rsync") {
    // A remote side is `host:path` or `host::module`.
    return operands(args).some((word) => /^[^/\s]+:/u.test(word) && !/^[A-Za-z]:\\/u.test(word))
      ? result("external", "rsync (remote)")
      : result("local", "rsync");
  }
  if (name === "sed")
    return hasFlag(args, "-i", "--in-place") || args.some((word) => /^-[a-zA-Z]*i/u.test(word.value))
      ? result("local", "sed -i")
      : result("read", "sed");
  if (name === "awk" || name === "gawk") return result("read", name);
  if (name === "find") {
    if (hasFlag(args, "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"))
      return result("local", "find");
    return result("read", "find");
  }
  if (name === "xargs" || name === "env" || name === "sudo") return result("external", name);
  if (READ_PROGRAMS.has(name)) return result("read", name);
  if (LOCAL_PROGRAMS.has(name)) return result("local", name);
  if (NETWORK_PROGRAMS.has(name)) return result("external", name);
  // A script or a program that the app does not know can send anything.
  return result("external", name.slice(0, 40));
}

/** Output to a file makes a read a local change; `/dev/null` and the terminal do not. */
function writesFile(segment: ShellSegment): boolean {
  return segment.outputs.some((word) => !/^(?:\/dev\/(?:null|stdout|stderr|tty)|&?[12])$/u.test(word.value));
}

function classifyAt(command: string, depth: number): CommandEffect {
  const { statements, cut } = readShell(command, STATEMENT_LIMIT);
  let strongest: CommandEffect = result("read", "");
  const consider = (effect: CommandEffect) => {
    if (RANK[effect.reach] > RANK[strongest.reach] || (strongest.label === "" && effect.label !== ""))
      strongest = RANK[effect.reach] >= RANK[strongest.reach] ? effect : strongest;
  };
  for (const statement of statements) {
    for (const segment of statement.segments) {
      const index = commandIndex(segment.words);
      if (index >= 0) {
        // `sudo`, `env`, `xargs` and the like run the program after them; `commandIndex` skips them.
        consider(program(segment.words.slice(index), depth));
      }
      if (writesFile(segment)) consider(result("local", strongest.label || "write to a file"));
      // `echo $(curl -X POST …)`: each subcommand runs too.
      for (const word of segment.words) {
        for (const sub of word.subcommands) if (depth < NESTING_LIMIT) consider(classifyAt(sub.text, depth + 1));
      }
    }
  }
  // A command too long to read to its end may hold anything after the cut.
  if (cut) consider(result("external", strongest.label || "long command"));
  return strongest;
}

/** The effect of a shell command, as the provider reported it (`commandExecution.command`, Bash `command`). */
export function classifyCommand(command: string): CommandEffect {
  const effect = classifyAt(command, 0);
  return effect.label ? effect : { ...effect, label: "command" };
}
