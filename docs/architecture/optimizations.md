# Advanced optimizations (beta)

Some changes make agents faster or lighter, but they change what the app does in a way that a person
can notice. Each of them is behind a switch of its own, in Settings › General › Advanced
optimizations (beta). Every switch is off by default. With every switch off, the app does what it
did before the switches existed, so a person can turn one on, watch, and turn it off again.

## The registry

`packages/contracts/src/ipc-optimizations.ts` has the closed list `OPTIMIZATION_IDS`. The order of the
list is the order of the Settings page.

| Id | What it changes when it is on |
| --- | --- |
| `queue-priority-user` | A delivery from the person can use one more place than the cap on agents, and at `low` memory one turn of the person can start on an agent whose provider session is open. See [providers.md](providers.md#memory-of-the-computer). |
| `idle-release-low` | When the memory of the computer goes to `low`, the provider threads with no turn for more than 2 minutes close. See [providers.md](providers.md#memory-of-the-computer). |
| `fiscal-resume-grace` | After the computer sleeps, the task reviewer holds every task for two looks. See [task-reviewer.md](task-reviewer.md). |
| `turn-start-unify` | The two security reviews before a turn become one. See [guard.md](guard.md). |
| `channel-context-spill` | Long old channel messages go to an agent cut, with a pointer to read the rest. |
| `safe-resume` | A channel task that fails in a turn with a passing error continues by itself, with a limit. |
| `routing` | The routing of a channel request uses less reasoning. |
| `streaming-checkpoints` | A reply that streams is written to the database at checkpoints, not at each frame. |

A new switch is one line in `OPTIMIZATION_IDS`, its name and description in the `settings` catalog
(`settings.optimizations.<name>.title` and `.description`, in English and Portuguese, with the risk
in plain words), a line in `OPTIMIZATION_TEXT` of `OptimizationSettings.tsx`, a row in this table,
and the code that reads it. A check that reads a switch keeps the old behavior on the path where the
switch is off.

## The file and the port

Each host has its own file, `openbot-optimizations-v1.json` in its user data folder:
`{ "version": 1, "on": ["queue-priority-user"] }`. `OptimizationStore` (`src/main/optimization-store.ts`)
holds it in memory after `load`, as the other preference stores of main do.

- A file that is missing, damaged, of another version or of another shape reads as every switch off.
- An id that this version does not know stays in the file when a write changes another switch. So a
  person who goes back to an older version and changes a switch does not lose a switch of a newer one.
  The older version does not use it, and the window does not show it.
- Each change goes to the log of the host (`optimizations`): the id and the new value. At start, the
  log says which switches are on. The log has no other value.

The code that runs agents reads the switches through one port, `OptimizationPort` in
`src/backend/optimizations.ts`:

- `optimizationEnabled(id)`: a synchronous read, so a check reads it each time it decides, and a
  change applies to the next decision. Nothing restarts.
- `onOptimizationChange(listener)`: for a reader that keeps state for a switch, such as a timer. It
  comes once for each switch whose value changed, after the file is written.

`AgentService` takes the port as its option `optimizations` and gives it to its parts as
`AgentService.optimizations`. With no option, as in a test, it is `OPTIMIZATIONS_OFF`: every switch
off. Main gives the same store to the services of main that have a switch, such as the task reviewer.

## The window

`app:get-optimizations` and `app:set-optimizations` carry the state as `{ on: [ids] }`. A change is
`{ changes: [{ id, enabled }] }`, with one to eight known ids, each one at most once. Main refuses any
other payload (`parseSetOptimizationsInput`). The preload leaves out an id of the answer that this
version does not know (`decodeOptimizationState`). "Turn all on" and "Turn all off" are one change
each. The switches are of the computer that runs the window, as the task reviewer is: a joined server
reads its own file, and no Team API route reads or sets it yet.

`scripts/optimizations-e2e.ts` checks the file, the event, the defaults, the parser and the decoder.
