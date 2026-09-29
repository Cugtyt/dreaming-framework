# Dreaming Framework

A callable TypeScript block that turns completed OpenTelemetry traces into a
reviewable improvement spec. The host decides when to invoke it and whether
to implement a returned proposal. The framework can enrich missing trace
labels and evaluations, then projects each session. A proposal `ToolLoopAgent`
explores all projections; a separate evaluation `ToolLoopAgent` accepts the
proposal or sends feedback for another attempt.

The [framework spec](docs/specs/initial-framework.md) defines the current
behavior and acceptance contract. This repository has no DSH import, built-in
model provider, scheduler, or remote service.

## Use

Node.js 24 or newer is required. Install and check the repository with:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm typecheck
pnpm build
```

Run the [hello-world example](examples/hello.ts):

```sh
node examples/hello.ts
```

The example calls `dream(otelTraces, { workspaceDirectory })` with one completed OTLP JSON trace export. The supplied directory must be empty; the example creates a timestamped directory under `results/`, saves `result.json`, and prints its path.
It supplies an offline AI SDK mock model at `createDreamer({ model })`; a real
host supplies a provider's AI SDK `LanguageModel`. The framework gives that model
to separate proposal and evaluation `ToolLoopAgent` instances, with structured
outputs and read-only file tools plus `getSource` for compacted evidence. A host can
replace any reasoning stage to use different business logic or another model.

## Offline examples

The hello-world example uses a synthetic trace and an offline mock model.

For an example that starts with already supplied OTLP traces:

```ts
import { dreamWithFeedback } from './examples/dream-with-feedback.ts'

const result = await dreamWithFeedback(otelTraces, model, workspaceDirectory)
```

The caller supplies an AI SDK model and an empty run directory. The framework
decodes OTLP before calling the example's `enrichTrace`. That hook scores parsed
user feedback and returns evaluation additions; the framework assigns their
span IDs and adds them to the context view. It leaves ambiguous
messages unscored. See the [example contract](docs/specs/feedback-enrichment-example.md)
for the score rule and input assumptions.

The hello-world example saves its returned outcome in `result.json`.
`projections/<trace_id>.txt` holds one chronological text projection per session.
The trace tag carries the trace ID and harness version; each item tag carries a
native span ID and optional event index. Evaluation tags carry the score, target,
and weight. Each `attempts/<number>/` directory holds that round's
`proposal.json`, any `evaluation.json`, and any `feedback.json` needed for
revision. An invalid default proposal citation is recorded with feedback and
retried; its round has no evaluator files. The final outcome is in `result.json`.
For each default agent call, `attempts/<number>/proposer-model.jsonl` or
`evaluator-model.jsonl` records model inputs, prepared tool definitions,
responses, tool results, usage, and the parsed result or error. These local logs
contain context the model saw; provider headers and credentials are excluded.
Custom reasoning stages manage their own logs. The model's file listing does not
include these `.jsonl` files.

Its `requirement`, `skill.load`, and `tool.result` spans carry item-level
`harness_rsi.scope` attributes, with no second scope field on the parsed item.
A separate `gen_ai.evaluation.result` span
carries the observed score and target. Those values supply the improvement
direction; there is no separate goal input. The OTLP Resource carries
`harness_rsi.harness.version`. The returned spec uses that value as
`baseHarnessVersion`, so the host can implement a change in a later version.

The default `enrichTrace` returns no additions. A harness can replace it to
return a missing harness version, missing scope labels, or evaluation items
from parsed trace records. The framework applies and validates those additions.
`projectSession` receives the complete validated trace. `proposeSpec` receives
views and retry feedback; `evaluateSpec` receives the candidate, views, and
evaluations. Each reasoning stage receives run services as a separate argument.
The default
`projectSession` replaces tool results with `[compacted]` while keeping message
text and tool-call arguments readable in each projection file. Default model stages receive the run folder
path and can list, search, and read its files. `getSource` returns the full parsed
item by `{ trace_id, span_id, event_index? }` when the model needs original text.
Either stage, or any reasoning stage, can be replaced at setup or for one call:

```ts
await dreamer.dream(traces, {
  workspaceDirectory: '/path/to/empty/run-directory',
  stages: { projectSession: (trace) => customCompact(trace) },
})
```

When both reasoning stages are supplied at setup, no model is needed:

```ts
createDreamer({ stages: { proposeSpec, evaluateSpec } })
```

Otherwise, provide `model` for each reasoning stage left at its default.

Each projected view must keep the harness version. Each item keeps its span ID,
event index when applicable, order, kind, scope, and evaluation data. A stage can
change `content`, message text, or tool-call arguments in the compact view; the
original item remains available through
`getSource(reference)`. A reference uses `{ trace_id, span_id }` for a span and
adds `event_index` for an event within that span.

## Code layout

`src/index.ts` is the public entry point and `src/types.ts` defines its
contracts. `src/otel.ts` parses OTLP input; `src/validation.ts` checks shared
trace and stage invariants. `src/dream.ts` owns stage order, parallel session
work, source lookup, and retry control. `src/workspace.ts` writes run files. Each
stage file in `src/stages/` owns its default implementation and output
validation; `file-tools.ts` and `source-tool.ts` serve the two AI SDK stages.

`pnpm check` enforces the repository's Biome style and lint rules. `pnpm build`
emits JavaScript and declarations to `dist/` through the package entry point.
The package remains private while its public release contract is undecided.

## Boundary

Trace scope marks which observed items can support a proposed harness change.
Candidates cite at least one `in` item, and the evaluator judges the proposed
change against both `in` and `out` evidence.
Evaluation items keep observed business scores and targets in `attributes`;
a missing weight is `1` in the evaluator's input. The later `evaluateSpec` stage predicts
whether a candidate might improve those scores. Rejection feedback returns
to spec proposal for another attempt. The host measures any actual gain
after implementation and makes the adoption decision.
