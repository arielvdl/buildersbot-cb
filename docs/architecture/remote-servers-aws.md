# Per-sector servers on AWS

`infra/aws/` holds the infrastructure as code (CloudFormation and the AWS CLI) that runs one Builders
Bot server for each sector of Cultura Builder, such as finance or marketing, in the Cultura Builder
AWS account. All of its names start with `bb-srv`. The full operator guide is in Portuguese:
[infra/aws/README.md](../../infra/aws/README.md).

## What it contains

| Path | Contents |
| --- | --- |
| `templates/` | CloudFormation templates: the stacks `bb-srv-dns`, `bb-srv-base`, `bb-srv-ops`, `bb-srv-proxy` and `bb-srv-signal`, and one `bb-srv-<sector>-data` and one `bb-srv-<sector>-compute` stack for each sector |
| `scripts/` | Bash scripts that deploy, update and remove the stacks, build the server image, sign in a sector and show the status. Each script calls `scripts/check-access.sh` before an AWS command |
| `tests/` | `negative.sh` runs the refusal paths of the scripts against a fake `aws` that refuses each write, and the egress proxy tool against a fake host. It needs no AWS access |
| `tools/` | Python helpers of `scripts/validate.sh` |
| `config/` | `mfa-roles.txt` and `allowed-egress-ips.example.txt` |

Each sector gets its own EC2 VM with no inbound port. One shared VM runs the Signal and TURN
services. The README gives the design, the costs, the deployment order and the rollback steps.

## How it uses this repository

The scripts read commits of this repository with `git archive` and `git show`: the server image and
the Signal VM are built from one commit. By default, the scripts use the checkout that contains
`infra/aws` (`git rev-parse --show-toplevel`). `BB_SRV_FORK=<path>` selects another checkout. The
scripts do not change the checkout, so each worktree that has the commit is satisfactory. A copy of
`infra/aws` outside a git checkout stops in each command that needs a commit.

The container image of a sector copies only the AppImage (`docker/Dockerfile`).

## How to run it

Run the commands from `infra/aws/` (`cd infra/aws`). The paths in the README are relative to that
folder. The scripts need the AWS CLI v2 with the `cb` profile. The scripts that change AWS also
need an MFA session.

`config/allowed-egress-ips.txt` holds the egress IP addresses of the operator. It is a local file:
`infra/aws/.gitignore` ignores it. Make it from `config/allowed-egress-ips.example.txt`. Without it,
each script stops before an AWS call. The tests use only the example file, which holds only
documentation addresses (`203.0.113.0/24`).

## Checks

| Check | AWS access | What it does |
| --- | --- | --- |
| `infra/aws/tests/negative.sh` | No | The refusal paths of the scripts and the egress proxy tool |
| `infra/aws/scripts/validate.sh` | Read only, from an allowed egress IP | `validate-template` and the resource schemas, `bash -n`, `shellcheck`, then `tests/negative.sh` |

No CI workflow runs these checks. Biome, knip, `check:ui` and the type checks do not read the infra
files, because they are Bash, YAML, Python, Markdown and text files. `check:doc-links` and the
telemetry destination guard read them.

## Packaging

The `files` patterns of `electron-builder.yml` are an allow list (`out/**/*`, `package.json`,
`LICENSE`, `NOTICE`). They do not include `infra/`, and no `extraResources` entry comes from it. Thus
the packaged app does not contain the infra files.

## Egress proxy of the sector VMs

The host of each sector VM sends all container egress through a residential proxy, with a firewall
that blocks direct egress (README, section 16). This control is on the VM. It is different from the
server setting in [Network egress through a proxy](egress-proxy.md), which the app applies to the
agents of one server.

## History

The folder came from the separate local repository `buildersbot-infra` on 31 October 2026, with all
45 of its commits. Each commit keeps its author, date and message; its files moved from the root to
`infra/aws/`. The original repository stays on the computer of the owner as a backup, with no
changes. Do new infrastructure work in `infra/aws/`.

The imported commits before the move contain the egress IP address of the operator, in
`config/allowed-egress-ips.txt` and in the README. The current tree does not contain it.
