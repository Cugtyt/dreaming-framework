# Project boundaries

## Start point and goal

Refactor the new framework into clear owners in the existing `context-compaction`
worktree, based on `c115d8d`. Pending context-management and strict-configuration
changes belong to this work. Other worktrees are outside scope.

## Architecture

- `index.ts` exposes the existing public names; `contracts.ts` owns dreamer
  configuration, stage interfaces, services and inputs.
- `domain/types.ts` owns trace, reference, proposal, decision and result types.
  `domain/schemas.ts` owns shared structured-output schemas. Optional schema fields
  retain their optional semantics, including Zod's explicit-undefined values.
- `domain/validation.ts` owns general assertions, trace and result invariants.
  `domain/sources.ts` owns native source keys, indexing, in-scope membership,
  evaluation collection and cloned lookup results.
- `trace/otel.ts` converts OTLP; `trace/projection.ts` formats projected traces.
- `dream.ts` composes and orchestrates the pipeline, independently validating
  default and caller-supplied stage results.
- `stages/` owns enrichment/projection behavior and proposal/evaluation instructions.
- `agent/run-agent.ts` owns typed agent construction/execution for both reasoning
  stages, shared tools, callbacks, compaction, generation and result/error logging.
- `agent/context-management.ts` owns budget estimation and history replacement;
  `agent/checkpoint.ts` owns the dreaming checkpoint schema and summary instructions.
- `agent/model-trace.ts` owns model/tool/compaction logging with a named contract.
  `agent/tools/` owns file and source tools.
- `workspace.ts` owns confined workspace preparation and writes only.
- `extensions/codex/` stays outside core and converts Codex sessions into OTLP.

Domain modules cannot import AI SDK or agents. Stages cannot construct ToolLoopAgent.
Core cannot import extensions. Shared abstractions have current consumers: source
indexing in orchestration/validation; shared schemas in stages/tools/checkpoints;
agent execution in proposal/evaluation; checked fixture access in existing tests.

## Closed scope

Split/remove `src/types.ts`; relocate/remove `src/validation.ts` and `src/otel.ts`;
add the domain, trace, runner and checkpoint files described above. Modify
`src/index.ts`, `src/dream.ts`, `src/workspace.ts`, all four stage files,
`src/agent/context-management.ts` and `src/agent/model-trace.ts`. Relocate file/source
tools into `src/agent/tools/`. Update all seven existing test files; add
`tests/helpers.ts` and `tests/architecture.test.ts`. Modify only imports and checked
access in `examples/codex-test-set.ts` and `examples/dream-with-feedback.ts`.
Include extensions in `biome.json`. Update README, initial-framework and
context-management specs for the final ownership and paths. No new dependencies.

Keep existing public export names, custom-stage optional references, OTLP and
Codex behavior, workspace artifacts, retries, tool names/limits/results/path
confinement, model-trace event formats and the twelve-step limit. Compaction keeps
the 128k default, 10k headroom, 4k summary output cap, structured checkpoint and
latest complete tool round. No compatibility wrappers or unrelated functionality.

## Implementation and acceptance

1. Add dependency-boundary tests first. They must fail against current ownership.
2. Move domain and trace responsibilities; preserve existing runtime expectations.
3. Consolidate agent execution; share checkpoint/domain schemas; require compactor
   tools/output settings and use narrow tracing dependencies.
4. Fix strict optional-property diagnostics by omitting absent configuration fields
   or matching schema types. Replace non-null assertions with checked access.
   Valid SDK fixture/call helpers must typecheck; malformed-input fixtures may
   deliberately bypass typing.
5. Update documentation and validate the public exports and dependency boundaries.

Acceptance requires existing and boundary tests, strict typecheck, Biome lint and
format checking, and declaration build to pass without weakening current flags.
Tests retain their current paths and existing behavioral expectations. Any needed
file, behavior or abstraction outside this scope requires a new confirmation.
