# Initial callable dreaming framework

## Start point

This is a new, independent TypeScript repository. The design starts from the
published trace-scope and callable-dreaming proposals, but this specification
is the implementation contract. No DSH package or scheduler is part of the
library. The first consumer can supply its own trace adapter and business
logic.

## Goal

Expose a callable block that takes completed traces and an improvement goal,
processes sessions in parallel, drafts a bounded improvement spec, and checks
the candidate against trace evidence in a separate evaluation pass. A host
chooses when to call it and what to do with the result.

## Scope

- `createDreamer(stages, options).dream(traces, goal, stage_overrides?)` is the
  public API. The five named stages are `mapTrace`, `projectSession`,
  `analyzeSession`, `proposeSpec`, and `evaluateSpec`. A replacement applies
  only to its call.
- The framework supplies an identity mapping for already standardized traces
  and a deterministic projector that replaces `tool.result` content with
  `[compacted]`. The host supplies base implementations of the three reasoning
  stages. They may use code, a model, or both.
- Trace items retain stable source IDs, kinds, parents, subjects, and item-level
  `in` or `out` scope. Evaluation events are separate records with a named
  value, target, and optional weight. An omitted weight is `1` in the
  evaluator's input. Unlabeled non-evaluation records are allowed only as
  parents of scoped descendants.
- A goal names the same improvement boundary as its traces. The proposal
  identifies an `in` subject and contains Issue, Proposal, Predict, and source
  references. A no-proposal result explains why no candidate is justified.
- The evaluator receives the candidate, all session views and observations,
  evaluation events, and a lookup for original source items. It returns
  accept, revise with feedback, or reject. A revision triggers another
  proposal pass, with at most three proposal attempts.

## Ownership and flow

```text
host: select traces and goal; supply business stages
  -> framework: map and validate each trace
  -> framework: project and analyze each session in parallel
  -> supplied proposer: candidate or no proposal
  -> supplied evaluator: accept, revise, or reject in a fresh input context
  -> framework: validated spec or explained no-proposal result
host: review, implement, and measure any actual gain
```

The framework owns stage order, per-session parallel work, source lookup,
validation, and the revision limit. Stage implementations own domain-specific
compaction, observations, proposals, and judgments. The host owns scheduling,
storage, model connections, implementation, and measured evaluation. The
framework neither edits the harness nor claims that a predicted gain has
already been measured.

## Contracts

- Inputs are JSON-compatible values. Stage inputs and source lookup results
  are copies so a stage cannot mutate the host's trace or another stage's
  evidence. Session results retain the supplied session order even when work
  finishes in a different order.
- Each trace has a unique `trace_id`, a `schema_version`, a `scope_boundary`,
  and ordered records with unique `item_id` values. A source reference is
  `<trace_id>/<item_id>`. Cross-trace duplicate references are invalid.
- A projected view must keep every record in its original order with the same
  ID, kind, parent, scope, subject, and evaluation. It may change `content`.
  Original records remain retrievable by reference.
- An independently attributable non-evaluation leaf requires scope. An `in`
  record also requires an identifiable subject. A parent without scope must
  have a scoped descendant. Evaluation values and targets are finite numbers
  in `[0, 1]`; weight, when present, is finite and positive.
- Observations, candidates, evaluation decisions, and no-proposal results
  cite only resolvable source references. A candidate's `componentId` must
  match the subject ID of at least one `in` record. Invalid input or stage
  output throws a descriptive error; insufficient evidence returns a
  no-proposal result.
- A revision pass receives only the goal, completed session results, and the
  evaluator's feedback. The evaluator gets fresh copies on each pass. If the
  third proposal is not accepted, the call returns no proposal with the last
  evaluation reason.

## Non-goals for this first version

- No built-in model provider, prompt, statistical estimator, or claim of
  generic business reasoning. The host must supply the three reasoning stages.
- No DSH adapter, OpenTelemetry parser, database, service, CLI, scheduled job,
  implementation adapter, or post-implementation experiment runner.
- No remote Git repository or package publication.

## Acceptance contract

- A small fake harness can produce a cited Issue/Proposal/Predict spec through
  the public API without importing DSH.
- Sessions process concurrently, while returned views retain input order and
  item order. The default projector compacts tool results without changing the
  original trace or its source lookup.
- Replacing one named stage affects one call and leaves the other stages in
  place. The evaluator sees all selected views and can find contrary original
  items beyond the candidate's citations.
- Acceptance returns a spec; rejection, unsupported evidence, and exhausted
  revisions return explained no-proposal results. Invalid scope, reference,
  boundary, or projected identity fails clearly.
- `pnpm test`, `pnpm typecheck`, and `git diff --check` pass on the new repo.

## Implementation sequence

1. Write tests for a valid trace, default projection, source lookup, and one
   accepted spec. Observe failure because the public module is absent. Add
   the smallest types, validation, and pipeline to pass.
2. Add tests for parallel sessions, stage replacement isolation, rejection,
   revision, and the attempt limit. Implement only the control flow needed.
3. Add tests for incomplete scope, out-of-scope component, unresolved source
   reference, mismatched boundary, and altered projection identity. Complete
   validation and run the full suite and typecheck.

Only the public exports, implementation, tests, package setup, and README
needed for those behaviors belong in this initial repository commit.
