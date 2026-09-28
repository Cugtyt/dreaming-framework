# Dreaming Framework

A callable TypeScript block that turns completed, labeled agent traces into a
reviewable improvement spec. The host decides when to invoke it and whether
to implement a returned proposal. The framework coordinates per-session
projection and analysis, proposal drafting, and a separate evaluation pass
against the trace evidence.

The [initial framework spec](docs/specs/initial-framework.md) defines the
current behavior and acceptance contract. This repository has no DSH import,
model provider, scheduler, or remote service.

## Use

Node.js 24 or newer is required. Install and check the repository with:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
```

Create a dreamer with the three business-specific stages, then call it with
completed traces and a goal:

```ts
import { createDreamer } from './src/index.ts'

const dreamer = createDreamer({
  analyzeSession: async (view) => {
    // Return observations that cite source IDs such as "run-17/42".
    return []
  },
  proposeSpec: async ({ goal, sessions, feedback }) => {
    // Return { issue, proposal, predict, componentId, references },
    // or { kind: 'no_proposal', reason }.
    return { kind: 'no_proposal', reason: 'No supported change yet' }
  },
  evaluateSpec: async ({ candidate, sessions, evaluations, getSource }) => {
    // Check expected gains and counterexamples with a dedicated context.
    // This stage runs only when proposeSpec returns a candidate.
    return { kind: 'reject', reason: 'Insufficient evidence' }
  },
})

// `traces` is the completed trace array supplied by the host.
const goal = {
  boundary: 'coding-harness/v3',
  question: 'Where is the review harness doing avoidable work?',
}
const result = await dreamer.dream(traces, goal)
```

The default `mapTrace` accepts the shared logical trace shape, and the default
`projectSession` replaces `tool.result` content with `[compacted]`. A harness
can replace either of those or any reasoning stage for one call:

```ts
await dreamer.dream(traces, goal, {
  projectSession: (trace) => customCompact(trace),
})
```

Each projected item must keep its source ID, order, kind, scope, subject, and
evaluation data. A stage can change `content` in the compact view; the
original item remains available through `getSource(reference)`. References
use `<trace_id>/<item_id>`.

## Boundary

Trace scope tells dreaming which subjects may be proposed for change.
Evaluation events record observed business scores; a missing weight is `1`
in the evaluator's input. The later `evaluateSpec` stage predicts whether a
candidate might improve those scores; it cannot measure the effect of an
implementation that has not been run. The host owns that later measurement
and any adoption decision.
