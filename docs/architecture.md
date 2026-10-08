# Architecture

Dreaming Framework analyzes completed sessions and returns a proposed harness
change with an evaluator's predicted judgment. The host owns scheduling, model
selection, implementation, adoption, and measurement of actual gain.

See [usage](usage.md) for integration and runtime limits, and the
[framework contract](specs/initial-framework.md) for exact behavior.

## Runtime path

```text
Codex / DSH JSONL → optional harness adapter → OTLP exports
                                                  │
OTLP export list or JSON directory ────────────────┤
                                                  ▼
loadTraceInputs → parseOtelTrace → enrichTrace → applyTraceAdditions → validateTrace
                                                  │
                             check common harness version and unique trace IDs
                                                  │
                                         createSourceIndex
                                        /                 \
                          originals + evaluations      projectSession
                                   │                      │
                              getSource              validateView
                                   │                      │
                                   └─────────┬───── projectionText → workspace
                                             ▼
                                         proposeSpec
                                             │
                             validateCandidate / validateNoProposal
                                             │
                           no_proposal ◄──────┤
                                             ▼
                                         evaluateSpec
                                             │
                                       validateDecision
                                             │
                             accept → return spec
                             revise/reject → feedback → next proposal attempt
```

`createDreamer` resolves setup defaults. Each `dream` call applies run overrides,
validates configuration, loads input, and prepares an empty workspace. Empty input
returns `no_proposal`. Traces are parsed/enriched, then validated; runs without
evaluations also return `no_proposal` before projection and reasoning.

Enrichment cannot mutate existing evidence. Projection can compact permitted
content fields while preserving identities, chronology, labels, and evaluations.
Original records remain accessible through cloned source lookup results.

A candidate must match the harness version and cite resolved sources, including
at least one in-scope item. Default-proposer reference errors feed another attempt;
custom-proposer validation errors fail immediately. Valid `no_proposal` returns
without evaluation. Evaluator revision and rejection both supply feedback for
another proposal attempt. Other malformed output and runtime errors fail rather
than being treated as evaluator feedback. Attempts default to three.

## File and function ownership

| File | Symbols / responsibility |
| --- | --- |
| `src/index.ts` | Public `createDreamer` and type exports; no pipeline implementation. |
| `src/contracts.ts` | `DreamerSetup`, `DreamInput`, `DreamOptions`, `StageImplementations`, `ReasoningServices`; input/config schemas and `assertStageImplementations`. |
| `src/dream.ts` | `createDreamer` and returned `dream`: stage composition, validation, source indexing, artifact coordination and retries. |
| `src/domain/schemas.ts` | Canonical trace, reference, proposal, evaluation and result schemas. |
| `src/domain/types.ts` | Schema-inferred types, `SessionView` and `SourceLookup`. |
| `src/domain/validation.ts` | `ValidationError`, `validateTrace`, `validateCandidate`, `validateNoProposal`, `validateDecision`; semantic invariants and reference resolution. |
| `src/domain/sources.ts` | `sourceKey`, `createSourceIndex`: originals, in-scope membership, evaluations and cloned lookup. Missing evaluation weight defaults to one in the indexed evaluator input. |
| `src/trace/input.ts` | `loadTraceInputs`: list normalization or ordered immediate JSON file loading. |
| `src/trace/schemas.ts` | Supported OTLP input shapes. |
| `src/trace/otel.ts` | `parseOtelTrace`: OTLP attribute decoding and chronological span/event normalization. |
| `src/trace/projection.ts` | `projectionText`: tagged text formatting and escaping. |
| `src/stages/enrich-trace.ts` | `defaultEnrichTrace` adds nothing; `applyTraceAdditions` adds missing version/scope and evaluation records. |
| `src/stages/project-session.ts` | `defaultProjectSession` compacts tool-result content; `validateView` preserves evidence identity. |
| `src/stages/propose-spec.ts` | `defaultProposeSpec`: investigation instructions and structured candidate/no-proposal output. |
| `src/stages/evaluate-spec.ts` | `defaultEvaluateSpec`: independent causal/constraint assessment and structured decision. |
| `src/agent/run-agent.ts` | `runAgent`: shared `ToolLoopAgent` construction, tools, hooks, generation and result/error logging; twelve-step limit. |
| `src/agent/context-management.ts` | `estimateContextTokens`, `createContextManagement`: context budget and history replacement hooks. |
| `src/agent/checkpoint.ts` | `summarySchema`, `SUMMARY_INSTRUCTIONS`: structured investigation checkpoint. |
| `src/agent/model-trace.ts` | `createModelTrace`: model, tool, summary and compaction events; final log persistence. |
| `src/agent/tools/file-tools.ts` | `fileTools`: workspace-confined listing, search and paginated reading with tool-local schemas. |
| `src/agent/tools/source-tool.ts` | `sourceTool`: original-record lookup by native source reference. |
| `src/workspace.ts` | `prepareWorkspace`, `writeWorkspaceJson`, `writeWorkspaceText`: empty-directory preparation and non-overwriting writes. |
| `extensions/codex/session-to-otel.ts` | `convertSession`, `readSession`: supported completed Codex turns to OTLP. |
| `extensions/dsh/session-to-otel.ts` | `convertSession`, `readSession`, `DshAdapterOptions`: supported DSH v3/v4 exported sessions to OTLP; explicit harness version required. |
| `extensions/*/index.ts` | Separate package exports for each adapter. |

Default reasoning stages obtain evidence from run files and `getSource`; their
model prompt starts with the workspace path. Custom stages receive structured
proposal/evaluation inputs and a separate services argument. Setup overrides and
per-call overrides use the same stage contracts. Replacing both reasoning stages
at setup removes the requirement to supply a model.

## Dependency rules

Arrows mean permitted relative imports, including type imports and re-exports:

```text
domain → domain
trace  → trace, domain, contracts
agent  → agent, domain, contracts, workspace
stages → stages, domain, contracts,
         agent/run-agent, agent/context-management
```

`dream.ts` composes these owners; `index.ts` exposes the public API.
`contracts.ts` defines host interfaces, including a type-only AI SDK model
reference. `workspace.ts` owns filesystem operations. Core never imports
`extensions/`. Domain never imports the AI SDK (`ai` or its subpaths).

Stages use named SDK helpers such as `Output` and model types, but cannot
import/re-export `ToolLoopAgent`, including aliases. Broad `ai` namespace/default
imports, wildcard/namespace exports, whole-module dynamic imports and whole-module
import types are rejected in stages because they expose agent construction.
The stage-to-agent rule restricts modules to the runner and context-management
constants; it does not inspect each imported symbol.

[Architecture tests](../tests/architecture.test.ts) parse the TypeScript AST and
check static imports, re-exports, literal dynamic imports and import types.
Fixtures verify permitted and forbidden dependencies. Computed module specifiers
are outside this static check; comments and string content are not imports.

## Layout and artifacts

```text
src/          public API, domain, trace pipeline, stages and agent infrastructure
extensions/   independent harness format adapters
examples/     integrations and offline mock demonstrations
tests/        behavior, adapters, context management and architecture checks
docs/specs/   behavior and acceptance contracts
```

Core prepares the run directory and writes `projections/<trace_id>.txt` plus
applicable `attempts/<number>/proposal.json`, `evaluation.json`, `feedback.json`,
and default-agent model logs. Early `no_proposal` outcomes can leave the workspace
empty. Core returns the outcome; it does not save `result.json`. The hello-world
example and inspection-suite runner persist that file after the call.

The inspection suite additionally saves adapter and enriched-trace snapshots.
These belong to the example runner, not the pipeline. Custom reasoning stages
own their model logging. See [run artifacts](usage.md#run-artifacts-and-stages).

The shared agent runner has two concrete consumers: proposal and evaluation.
The source index serves orchestration, validation and model evidence lookup.
Adapters retain their small local OTLP builders; no shared adapter abstraction
is needed for the current format-specific behavior.
