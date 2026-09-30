# Callable dreaming framework

## Start point and goal

This independent TypeScript library turns completed OpenTelemetry traces into
reviewable Issue/Proposal/Predict improvement specs. The host supplies complete
OTLP JSON `ExportTraceServiceRequest` data, chooses when to call dreaming, and
owns implementation and measurement after a spec is returned. The framework
does not schedule work or use DSH.

## Public contract

- `createDreamer({ model?, stages?, maxProposalAttempts?, contextWindowTokens? }).dream(otelTraces,
  { workspaceDirectory, stages? })` accepts an array of completed OTLP JSON trace exports, one
  trace ID per array element. The host supplies an AI SDK `LanguageModel` when
  any default reasoning stage is used. If both reasoning stages are
  supplied at setup, no model is required. The framework owns no model resource
  or provider connection. `workspaceDirectory` is a caller-supplied empty run
  directory, created if absent. A nonempty directory is rejected so stale files
  cannot enter a new run. Per-call `stages` replace defaults for that call.
  The examples create timestamped directories under repository `results/` and
  write the final `result.json` there; this path choice is not part of the
  library API.
  There is no goal argument: evaluation items carry observed values and desired
  targets, while item-level scope labels bound possible changes. All traces in
  one call come from the same harness version; a returned spec proposes a change
  for its next version.
- All four named stages have defaults. `enrichTrace` returns no additions and
  `projectSession` compacts content. The default `proposeSpec` and
  `evaluateSpec` each create an AI SDK `ToolLoopAgent` with structured output,
  framework-owned instructions, a run folder path, bounded read-only
  `listFiles`, `searchFiles`, `readFile`, and `getSource` tools. The model prompt
  contains the folder path rather than serialized session or stage data. Setup
  and per-call stage replacements may replace any
  default without changing the others. Each stage has a specific typed input
  and output. The reasoning stages receive run services in a separate argument;
  custom stages may use AI SDK, other models, or ordinary business logic.
- Default agents use independent context management from `src/agent/`.
  `contextWindowTokens` defaults to 128,000 and must be a safe integer greater
  than 14,000. Before each normal model call, previous reported input usage plus
  estimated added content (or a whole-request estimate when usage is absent)
  triggers compaction at 10,000 tokens below the window. The same model generates
  a structured summary of older messages with no tools and at most 4,000 output
  tokens. The original task and instructions remain, followed by a user summary
  and the latest complete assistant/tool round, which is excluded from summary
  input. Later compactions include the previous summary. Summary failure or an
  oversized context fails the stage without silently truncating evidence. The
  existing 12-step limit and proposal attempts do not reset. Source/file tool
  behavior and custom stages are unchanged. Exact behavior and limitations are
  defined in `docs/specs/context-management.md`.
- Each default agent call writes `attempts/<number>/proposer-model.jsonl` or
  `evaluator-model.jsonl` with its model inputs, prepared tool definitions,
  model responses, tool results, token usage, and parsed result or error. The
  files omit provider headers and credentials. They are local run artifacts,
  separate from the input OTLP traces, and are not listed by the model's file
  tools. Summary model events carry `purpose: "summary"`, and
  `context_compaction` events record the summary and before/after estimates.
  Custom reasoning stages own any logging they need.
- The framework parses OTLP before `enrichTrace`. That hook receives a parsed
  `TraceDraft` and returns `TraceAdditions`: an optional missing harness version,
  scope labels for unlabeled items, and independent evaluation records with
  timestamps. The framework applies additions, assigns evaluation span IDs,
  and validates the complete `TraceSession`. It rejects edits to existing
  evidence. The original OTLP export stays unchanged. A complete trace needs
  no custom enricher; parsing is not a replaceable stage.
- `projectSession(trace)` receives only the validated trace.
  `proposeSpec({ views, feedback }, services)` and
  `evaluateSpec({ candidate, views, evaluations }, services)` receive their
  own task data. `services` contains source lookup, run directory, and attempt
  number for the reasoning stages.
- Each span or event describing an independently attributable action or input
  carries `harness_rsi.scope` (`in` or `out`). A mixed parent may omit scope
  when a descendant is labeled. Parsed items keep scope only in `attributes`.
  A scope label does not require a subject ID.
- A score is a separate `gen_ai.evaluation.result` span or span event with
  `gen_ai.evaluation.name`, `gen_ai.evaluation.score.value`,
  `harness_rsi.evaluation.target`, and optional
  `harness_rsi.evaluation.weight` (default `1`). Value and target are in
  `[0, 1]`; the versioned metric name defines their meaning. The target
  indicates the desired direction. The evaluation need not assess one action.
  An evaluation span is an unscoped item with its own span ID. An evaluation
  event is also an unscoped item, identified beneath its containing span. Parsed
  evaluation items keep name, value, target, optional weight, and other
  metadata together in `attributes`.
- The default projector creates a trace-shaped context view that keeps the
  harness version, order, IDs, kinds, scope, and evaluations. It replaces
  tool result bodies with `[compacted]` while keeping message text and tool-call
  arguments readable. Source lookup returns copies
  of unprojected parsed items, including their full content. Projection may
  change only these content fields; IDs, labels, scores, and other metadata
  remain equal to the source.
- The framework writes one `projections/<trace_id>.txt` file per projected
  session. A trace tag carries the trace ID and harness version. Each item is
  one line with its kind, scope, native span ID, optional event index, and
  readable content. Evaluation tags carry score, target, and weight; meta tags
  carry other attributes. XML escaping keeps source text from creating false
  tags, and line breaks are encoded so one item stays on one line. The trace ID
  and item IDs form the native reference for `getSource`. The file tools can
  list, search, and read text and JSON files inside the run directory; reads
  are paged with explicit continuation. Listing/search have no overall cap;
  long lines use recoverable head/tail previews. Full-line reads and getSource
  preserve complete content. See [contract hardening](contract-hardening.md).
  Each `attempts/<number>/` contains that round's proposal, any evaluation,
  and any feedback for revision. A default proposal with an invalid citation
  is identified by a reference error category and saved to `proposal.json`; its validation reason is saved to
  `feedback.json`, and the evaluator is skipped for that round. A rejected or
  revised evaluation also writes feedback in its own round. The next default
  proposer reads the previous round's feedback. Custom proposal validation
  continues to fail fast. Default stages inspect these files; custom stages
  receive all projected views as typed input and their outputs are written
  the same way.
- Each proposal attempt calls one spec agent across all projected sessions. It
  returns a cited Issue/Proposal/Predict candidate with `baseHarnessVersion`
  equal to the input harness version, or `no_proposal`. The dedicated evaluator
  examines all views, evaluation items, and original evidence. `accept` returns
  a spec; `reject` or `revise` returns feedback directly to the proposer for
  another attempt. A no-proposal result or the configurable attempt limit stops
  the loop. The default limit is three attempts. Evaluator files are written
  only when that agent runs.
- Default proposal asks the model to identify score gaps, weights, already-met
  targets to preserve, relevant `in` items, and contrary `out` context with
  source citations, then return one bounded cited change or an explained
  no-proposal result. Default spec evaluation asks whether that
  change is likely to move named scores toward targets without degrading
  preserved outcomes; rejection gives concrete feedback for the next attempt.
  Stage outputs pass the same validation as custom outputs.

## Code ownership

- `src/index.ts` exports the existing public API; `src/contracts.ts` owns setup,
  serializable input/option schemas, stage interfaces and services. `src/domain/types.ts` owns domain types.
- `src/domain/schemas.ts` owns shared structured-output schemas;
  `src/domain/validation.ts` owns trace/spec/decision invariants;
  `src/domain/sources.ts` owns native keys, indexing and cloned source lookup.
- `src/trace/schemas.ts` owns supported OTLP wire schemas; `src/trace/otel.ts`
  parses them and `src/trace/projection.ts` formats projected text.
- `src/stages/` owns enrichment/projection behavior and proposal/evaluation instructions.
  `src/agent/run-agent.ts` owns construction and execution for both model stages,
  including tools, tracing, context hooks and the twelve-step limit.
- `src/agent/checkpoint.ts` defines checkpoint content; `context-management.ts`
  owns budget estimation and history replacement; `model-trace.ts` owns logging.
  File/source tools and their schemas live in `src/agent/tools/`.
- `src/dream.ts` composes stages, validates results against domain rules, writes
  projections and controls retries. `src/workspace.ts` owns run preparation/writes.
- Domain has no AI SDK/agent imports; stages do not construct SDK agents; core
  does not depend on extensions. These boundaries have a static test. The full
  ownership contract is in [project-boundaries.md](project-boundaries.md).

## OTLP JSON interpretation

- A trace export uses the official `resourceSpans` → `scopeSpans` → `spans`
  nesting, with hexadecimal `traceId` and `spanId`, optional `parentSpanId`,
  span attributes, and timestamped span events. Extra OTLP fields are retained
  in the host's input. The parser reads only the fields needed for dreaming.
- The OTLP Resource carries `harness_rsi.harness.version` as a nonempty string.
  The parser copies it to `TraceSession.harness_version`. One trace may include
  multiple Resource groups, but any declared harness versions must agree. All
  traces in one `dream()` call must share that version. The spec's
  `baseHarnessVersion` identifies that source version; the host chooses the
  next version identifier after implementation.
- Each span becomes a context item with its OTLP span ID. Each span event keeps
  its containing span ID and a zero-based `event_index` from that span's event
  list. A source reference is `{ trace_id, span_id }` for a span or
  `{ trace_id, span_id, event_index }` for an event, so repeated span IDs across
  different traces remain distinct.
  Span and event names provide kinds. Items are ordered by OTLP nanosecond
  timestamps, breaking ties by source order. Item attributes remain in the
  context item. A `gen_ai.tool.call.result` attribute supplies content.
  Enrichment may add evaluation records to the parsed context view; timestamps
  place them without reordering the OTLP input. The framework generates a
  stable span ID for each added evaluation so it can be cited like a source span.
- The input and enriched data remain immutable to later stages. Projection may
  change only item content, message text, and tool-call arguments. The harness
  version, IDs, ordering, other metadata, labels,
  and scores remain
  equal to their unprojected source items. A source reference must resolve.
- Duplicate trace or span IDs, missing or mixed harness versions, malformed
  labels or scores, missing scope on attributable leaves, proposals without an
  in-scope source citation, and changed
  projection identity fail clearly. No evaluation items yield `no_proposal`
  because the trace supplies no improvement target.

## Ownership and non-goals

```text
host: completed OTLP exports, empty run directory, AI SDK model when needed, optional stage replacements
  -> framework: parse, apply returned enrichment, validate, project once per session
  -> loop: one proposer explores all projections -> evaluate
           rejection feedback returns to the proposer
  -> framework: cited spec or explained no-proposal result
host: review, implement, measure, adopt or reject the actual change
```

The framework coordinates stages, uses AI SDK for default reasoning, and
validates outputs. The host owns model access, label completion, score
production, and any replacement reasoning stages. The framework does not
provide a model provider, metric rubric, OTLP exporter, collector, scheduler,
remote service, harness implementation adapter, or post-implementation
experiment runner. It does not claim that a predicted gain has already been
measured.

## Acceptance contract

- A runnable example uses a real-shaped OTLP JSON export with a Resource-level
  harness version, labeled items, and a separate evaluation span. It supplies
  an offline AI SDK mock model at setup and returns a cited spec with the input
  version using both default reasoning stages without DSH.
- Default stage model requests contain the run directory path and instructions,
  without inline projected content. Read-only file and source lookup tools let
  the model inspect relevant evidence. Rejection feedback is saved and reaches
  a new default proposal call.
  Malformed model outputs fail schema or framework output validation. Fully
  custom reasoning stages work without a model; incomplete stages without a
  model fail at setup. Invalid stage functions also fail at setup.
- Mock-model tests force repeated context compactions, preserve original tasks
  and complete recent tool rounds, exclude the retained round from summary
  input, and continue both default stages to their existing structured outputs.
  They cover usage fallback, configuration validation, failure without history
  mutation, oversized contexts, logs, and unchanged normal-agent step limits.
- Enrichment can fill a missing harness version or label and return new
  evaluations without altering existing evidence. A complete trace works with
  empty enrichment. The framework owns OTLP traversal and generated IDs.
- Projection compacts tool content while source lookup retains the full value;
  each session has a dedicated projection file with native references, and
  projected views keep input order. A nonempty run directory is rejected;
  file tools cannot read outside it.
- Rejection feedback reaches a fresh proposal pass. Acceptance returns
  the accepted candidate; unsupported evidence and exhausted attempts return
  explained no-proposal results.
- Tests cover malformed input, missing labels and versions, mixed harness
  versions, unresolved citations, candidates without an in-scope citation,
  and changed projection identity.
  Traces without a scope boundary work individually and together.
  `pnpm check`, `pnpm test`, `pnpm typecheck`, `pnpm build`, the example,
  its direct typecheck, a built-entry import, and `git diff --check` pass.

## Implementation contract

1. Test OTLP parsing, enrichment, item-level scope, dedicated score items,
   harness version consistency, projection identity, and native source references.
   Implement parsing and validation in their existing owners.
2. Test a caller-supplied empty run directory, one compact projection file per
   trace, and rejection of stale files. Implement workspace writing and confined,
   paged read-only file tools.
3. Test one proposer call over all projected views, a cited candidate or
   no-proposal result, dedicated evaluation, and feedback returning directly to
   the next proposal attempt. Implement the loop without a per-session analysis
   stage or analyses files.
4. Test the default AI SDK proposer and evaluator with a mock model, including
   projection and source tool calls, saved stage outputs, rejection feedback,
   and output validation. Keep custom stage replacements and model-free setup
   when both reasoning stages are supplied.
5. Run tests, typecheck, style checks, build, the offline example, a multi-trace
   file-flow sample, and `git diff --check` before reporting acceptance.
