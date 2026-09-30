# Dreaming Framework

A callable TypeScript block that turns completed OpenTelemetry traces into a
reviewable improvement spec. The host decides when to invoke it and whether
to implement a returned proposal. The framework can enrich missing trace
labels and evaluations, then projects each session. A proposal `ToolLoopAgent`
explores all projections; a separate evaluation `ToolLoopAgent` accepts the
proposal or sends feedback for another attempt.

The [framework spec](docs/specs/initial-framework.md) defines the current
behavior and acceptance contract. This repository has no DSH runtime dependency,
built-in model provider, scheduler, or remote service.

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

## Trace inputs

`dream()` accepts an in-memory list of OTLP JSON exports or a trace folder path:

```ts
const dreamer = createDreamer({ model })

await dreamer.dream([traceA, traceB], {
  workspaceDirectory: '/path/to/list-run',
})

await dreamer.dream('/path/to/traces', {
  workspaceDirectory: '/path/to/folder-run',
})
```

Each list element or file contains one OTLP export with one trace ID. Folder
loading reads immediate `.json` files in filename order; it ignores other files
and subdirectories and rejects `.json` symlinks. Relative folder paths resolve
against the current working directory. Invalid JSON, unreadable files, and trace
validation errors identify the source filename. An empty folder returns the same
`no_proposal` outcome as an empty list. The existing trace validation, enrichment,
projection, proposal, and evaluation behavior applies to both forms.

Source files are read only. Use a separate empty `workspaceDirectory` for outputs.
Folder loading completes before that workspace is created. Codex session JSONL
continues to use the adapter below; trace folders contain OTLP JSON, not session
JSONL. `DreamInput` is the exported input type. See the
[trace input contract](docs/specs/trace-input.md).

## Codex extension

The optional Codex adapter converts a session JSONL file into OTLP traces:

```ts
import { createDreamer } from 'dreaming-framework'
import { codexAdapter } from 'dreaming-framework/extensions/codex'
import { enrichUserFeedback } from './examples/dream-with-feedback.ts'

const traces = await codexAdapter.readSession(sessionPath)
const result = await createDreamer({
  model,
  stages: { enrichTrace: enrichUserFeedback },
}).dream(traces, { workspaceDirectory })
```

`codexAdapter.convertSession(jsonl)` accepts session text directly. The adapter
returns one trace for the completed turns of one session, with the Codex CLI
version and item scope labels. It retains message text and tool content, links
results to calls, and omits unfinished turns, reasoning, and unsupported
records. Scoring belongs to enrichment. The
[adapter contract](docs/specs/codex-adapter.md) defines the conversion rules;
[dream-codex-session.ts](examples/dream-codex-session.ts) shows the complete call.
Harness adapters live in `extensions/`; the core does not import them.

## DSH extension

The optional DSH adapter converts an exported DSH Session JSONL log into OTLP
traces:

```ts
import { createDreamer } from 'dreaming-framework'
import { dshAdapter } from 'dreaming-framework/extensions/dsh'
import { enrichUserFeedback } from './examples/dream-with-feedback.ts'

const traces = await dshAdapter.readSession(sessionPath, {
  harnessVersion: 'dsh@0.2.0-rc.2',
})
const result = await createDreamer({
  model,
  stages: { enrichTrace: enrichUserFeedback },
}).dream(traces, { workspaceDirectory })
```

In DSH, choose **Download session log** or run `/export`, extract the ZIP, and
pass its uncompressed `session.v3.jsonl` or `session.v4.jsonl` file. Direct
`.jsonl.zstd` persistence files are intentionally unsupported because DSH owns
their framing, migration, and recovery behavior. `dshAdapter.convertSession(jsonl,
{ harnessVersion })` accepts Session JSONL text directly. `harnessVersion` is
required because the Session format version describes storage compatibility, not
the deployed harness behavior; use the actual DSH release, build, or configuration
identifier.

The adapter keeps supported records from turns ending with `reason.kind ===
"completed"`, maps append-origin messages, requested and started tool calls, and
tool results, and preserves model-history replacements as separate in-scope
evidence. It omits private reasoning, enforces v3/v4 identities, preserves DSH
sequence order across clock drift, and produces no scores. The existing feedback
enricher can derive evaluations from follow-up user messages.
See the [adapter contract](docs/specs/dsh-adapter.md) and
[dream-dsh-session.ts](examples/dream-dsh-session.ts).

## Offline examples

The [hello-world example](examples/hello.ts) uses a synthetic trace and an AI SDK
mock model. It runs without credentials, a provider endpoint, or local session
history. Its scripted responses demonstrate the pipeline, not proposal quality.

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

## Codex session inspection suite

Run all three synthetic Codex JSONL cases with an offline mock model:

```sh
node examples/codex-test-set.ts
```

The command prints a fresh run directory with one workspace per case:

| Case | Observed behavior | Expected judgment |
| --- | --- | --- |
| `repeated-read` | The same unchanged file is read twice, followed by negative feedback | Propose reusing an available result while preserving rereads after edits |
| `efficient-read` | The same task succeeds with one read and positive feedback | Preserve successful behavior; no proposal |
| `ambiguous-feedback` | Negative feedback supplies no supported cause | No unsupported proposal |

Each case starts with a synthetic completed Codex session, uses the existing
adapter and feedback enricher, then runs the default projection and reasoning
stages. The repeated-read mock exercises file and source tools before returning
its scripted proposal and evaluator acceptance. The other mocks return
`no_proposal`, so the evaluator does not run for those cases.

Inspect these files in each case directory:

- `adapter-output.json`: the adapter's OTLP output.
- `enriched-trace.json`: the parsed trace with feedback evaluations added.
- `projections/<trace_id>.txt`: the compacted view supplied through model tools.
- `attempts/<number>/`: proposals, applicable evaluator decisions, retry feedback,
  and default-agent model logs.
- `result.json`: the returned `dreamResult` and a `review` with observed read counts,
  feedback scores, expected judgment, manual quality checks, and evidence level.

Snapshots and the merged result are written after dreaming completes. Expected
judgments are not available to the model during proposal or evaluation. There is
no separate JSON projection or review file.

To inspect generated proposals with your own AI SDK `LanguageModel`, import the
runner and supply your model:

```ts
import { runCodexTestSet } from './examples/codex-test-set.ts'

const run = await runCodexTestSet({ model })
console.log(run.outputDirectory)
```

You can also supply `outputDirectory`, which must be empty. Importing the runner
does not start the CLI. No provider or credentials are bundled with the suite.

The mock run verifies pipeline behavior, not spec quality. The paired synthetic
sessions illustrate an observed difference; they do not measure an improvement
caused by implementing the generated proposal. A supplied-model run produces
predictions for human review. Check grounding, actionability, causal connection to
the metric, and preservation of successful behavior. Actual improvement requires
implementing a proposal and comparing harness versions on held-out tasks. See the
[suite contract](docs/specs/codex-inspection-suite.md).

The default agents are instructed to read every projection from beginning to end,
one file at a time. `listFiles({ offset?, limit? })` returns sorted paths,
`total`, and `nextOffset`; follow pages until `nextOffset` is null. Listing has
no overall file cap. `searchFiles({ query, regex?, path?, contextLines?, offset?,
limit? })` supports case-insensitive literal or JavaScript regex search, an exact
file/directory-prefix filter, and surrounding line context. It returns `total`
and `nextOffset` so every match is reachable. Listing pages contain at most 200
files; search pages contain at most 100 matches.

`readFile({ path, startLine?, lineCount?, fullLines? })` returns up to 200 lines,
`nextLine`, and `truncatedLines`. Lines longer than 200 characters show the first
100, an omitted-character marker, and the last 100. Reread those lines with
`fullLines: true` to recover all content. There is no aggregate character cap;
`getSource` also returns full original records. Paths remain confined to the run
workspace. Search and source retrieval supplement the complete projection read.

Domain data contracts are Zod schemas in `src/domain/schemas.ts`; public data types are inferred
from them. OTLP schemas live in `src/trace/schemas.ts`; input/option schemas live
in `src/contracts.ts`, and tool schemas live beside the tools. Semantic checks
still enforce identity, scope, and resolved citations.
Invalid stage overrides fail before a workspace is created. Default proposals,
including `no_proposal`, retry categorized reference errors, while custom proposal validation fails
immediately. Other malformed outputs and runtime errors fail immediately;
evaluator revision/rejection retries within the configured proposal attempt limit.
Conversation compaction remains enabled for default agents. See
[the hardening contract](docs/specs/contract-hardening.md) for exact defaults and
acceptance checks.

## Run artifacts and stages

The hello-world example prints a fresh `results/<UTC timestamp>-<unique suffix>/`
directory and saves the returned outcome as `result.json`.
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

Default proposer and evaluator agents compact their working conversation when
estimated input reaches 10,000 tokens below the configured context window:

```ts
const dreamer = createDreamer({ model, contextWindowTokens: 128_000 })
```

`contextWindowTokens` defaults to 128,000 and must be a safe integer greater than
14,000. Supply the actual window for your model. Each agent uses its previous
reported input usage, including cached tokens, plus estimated newly added
content; without usage it estimates the full request from UTF-8 bytes divided
by three. Instructions, messages, tool definitions, and output schema contribute
to the estimate. This is an approximation, not a provider tokenizer.

Compaction asks the same model for a structured summary of older progress with
tools disabled and a 4,000-token output limit. It excludes the latest complete
assistant/tool round, keeps that round verbatim, and inserts the summary as a
user message after the original task. Instructions remain unchanged. Summaries
record fully read files, in-progress reads, findings with source references,
current spec, rejected ideas/contrary evidence, and next steps. Read coverage is
model-reported. Later compactions incorporate the previous summary.

Summary calls have `purpose: "summary"` in the existing model logs;
`context_compaction` events include the parsed summary and before/after token
estimates. Summary errors and contexts that cannot fit fail through the normal
stage error path without silently truncating evidence. There must be older work
to summarize; if only the first recent round reaches the threshold, the stage
fails rather than consuming the 10,000-token headroom. Each stage has independent
context, and custom stages are unchanged.

Full-line reads and original source retrieval remain unlimited. A retained tool
result that exceeds the configured budget can fail the stage even after
compaction; the framework does not silently discard evidence.
Compaction adds model calls and cost but does not reset the existing 12-step
limit or proposal attempts. File/search enumeration limits and the complete
`getSource` response are unchanged, so a very large result can still prevent
continuation. See the [context-management contract](docs/specs/context-management.md).

The hello-world trace's `requirement`, `skill.load`, and `tool.result` spans carry
item-level `harness_rsi.scope` attributes. A separate `gen_ai.evaluation.result`
span carries the observed score and target. Those values supply the improvement
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

`src/index.ts` exposes the public API. `src/contracts.ts` defines dreamer
configuration, serializable input/option schemas, and stage interfaces; `src/domain/` owns trace/spec types, shared
schemas, invariants, and source indexing without importing the AI SDK or agents.
`src/trace/` owns input loading, supported OTLP schemas, parsing, and projection
formatting. `src/dream.ts` composes stages,
validates their results, and controls proposal retries; `src/workspace.ts`
prepares the run directory and writes artifacts.

`src/stages/` owns enrichment/projection behavior and the proposal/evaluation
instructions. Both reasoning stages call `src/agent/run-agent.ts`, which owns
agent construction, tools, context hooks, execution, and model logging.
`src/agent/context-management.ts` handles budgets and history replacement;
`src/agent/checkpoint.ts` defines the structured progress checkpoint.
File/source tools and their schemas live in `src/agent/tools/`. Codex and DSH
session conversion stays in `extensions/` behind separate package exports.

The dependency boundaries are checked in `tests/architecture.test.ts`.
See [project boundaries](docs/specs/project-boundaries.md) for the ownership contract.

`pnpm check` enforces the repository's Biome style and lint rules. `pnpm build`
emits JavaScript and declarations to `dist/` through the package entry point.
The package is licensed under [MIT](LICENSE) and permits npm publication.
Publication and API stability are separate release decisions.

## Boundary

Trace scope marks which observed items can support a proposed harness change.
Candidates cite at least one `in` item, and the evaluator judges the proposed
change against both `in` and `out` evidence.
Evaluation items keep observed business scores and targets in `attributes`;
a missing weight is `1` in the evaluator's input. The later `evaluateSpec` stage predicts
whether a candidate might improve those scores. Rejection feedback returns
to spec proposal for another attempt. The host measures any actual gain
after implementation and makes the adoption decision.

## Data handling

The harness adapter owns redaction before traces are passed to `dream()`. Remove
sensitive text from messages, tool arguments, tool results, and other attributes
while preserving trace identities, chronology, scope labels, and evaluations.
The current Codex and DSH adapters preserve supported source content and do not
redact it; callers must sanitize session input or its converted OTLP output before
submitting it to dreaming.

`enrichTrace` adds labels and evaluations; it cannot alter existing evidence.
Projection compaction is not redaction: `getSource` can retrieve the unprojected
content supplied to the framework. Default reasoning stages send that content
to the caller's model provider and write model inputs, outputs, and tool results
to local run logs. Excluding provider credentials does not remove secrets embedded
in trace content. Apply the adapter's redaction policy before model submission
and choose storage access and retention appropriate to the sanitized data.
