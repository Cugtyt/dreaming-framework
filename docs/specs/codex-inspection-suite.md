# Codex session inspection suite

## Start point and accepted goal

The TypeScript framework has a Codex JSONL adapter, feedback enrichment example,
default compacting projector, default proposal/evaluation agents, and an offline
mock-model example. The implementation baseline is `99b6f3c` on `main` in the
project checkout; approved license/package/example cleanup is present in the checkout and must be preserved.

Add a portable, offline inspection suite that runs three synthetic Codex sessions
through adapter, enrichment, projection, proposal, and evaluation where applicable.
Every run exposes stage artifacts and merges its final outcome with a review in
`result.json`. The suite demonstrates pipeline behavior and gives a caller a way
to inspect real-model proposals against known evidence. It does not claim measured
improvement from scripted model responses or authored before/after sessions.

## Scope and ownership

- `examples/data/repeated-read.jsonl`: completed synthetic turns showing the same
  unchanged file read twice, an answer, and explicit negative user feedback.
- `examples/data/efficient-read.jsonl`: the corresponding task completed with one
  read and positive user feedback. It represents behavior a proposal must preserve.
- `examples/data/ambiguous-feedback.jsonl`: negative feedback without sufficient
  evidence of its cause; expected behavior is no unsupported proposal.
- `examples/codex-test-set.ts`: `runCodexTestSet`, `createCaseModel`, `reviewCase`,
  case definitions, and CLI entry point own execution, scripted mock responses,
  observation reporting, and artifact capture.
- `tests/codex-test-set.test.ts`: meaningful integration checks for fixture
  conversion, scoring, compaction/source access, proposal/no-proposal behavior,
  and artifacts.
- `README.md`: command, output guide, caller-supplied model usage, and quality limits.
- This document owns the resolved implementation and acceptance contract.

Reuse `codexAdapter`, `enrichUserFeedback`, `defaultProjectSession`, `createDreamer`,
its default reasoning stages and file/source tools, and `createRunDirectory`.
All fixtures are synthetic and contain no personal history, credentials, or
provider endpoints. No core API, dependency, publication, harness implementation,
redaction mechanism, or unrelated cleanup belongs to this change.

## Runtime and outputs

The CLI runs offline with scripted AI SDK mock models. The exported runner accepts
a caller-supplied AI SDK `LanguageModel` to use the same default reasoning stages
with a real model. It creates a fresh run root, or uses a caller-supplied empty
output directory, with one isolated workspace per case.

Each case saves `adapter-output.json`, `enriched-trace.json`, the framework's
`projections/<trace_id>.txt`, applicable attempt artifacts and model logs, and a
merged `result.json` containing `dreamResult` and `review`. Do not produce
`projected-view.json` or `review.json`. Preserve the framework's empty-workspace
requirement; capture extra stage snapshots in memory and write them after dreaming
finishes. Expected judgments and review criteria remain unavailable to the model
until dreaming completes. The evaluator is skipped when the proposer returns
`no_proposal`; absence of its artifacts represents that skip.

The mock repeated-read case exercises model tools, including compacted-source
retrieval, and returns a cited proposal that reuses an unchanged read while
preserving rereads after edits. The evaluator exercises the candidate/projection
files and returns a scripted acceptance. Healthy and ambiguous cases return
scripted `no_proposal`. Mock outputs demonstrate plumbing rather than independent
reasoning. A caller-supplied model receives the normal stage instructions and
trace evidence, without expected judgments or scripted answers.

The merged review records observed file-read counts, repeated unchanged read
evidence, feedback scores, the expected judgment, and manual grounding/scope/
prediction/regression checks. It identifies model mode and evidence level. Do not
use brittle output keyword matching or evaluator agreement as proof of spec
quality. The paired synthetic sessions are illustrative observations, not a
causal experiment. Actual improvement requires implementing a proposal and
measuring the changed harness on held-out tasks.

## Acceptance and implementation contract

1. Add integration tests before the runner. Missing runner is the expected initial
   failure; use synthetic fixtures as the executable input contract.
2. Implement only the named files and symbols. No abstraction outside the example
   runner is necessary.
3. The CLI succeeds without network access or credentials, prints the artifact
   root, and includes all three cases.
4. Adapter output is valid OTLP; enrichment produces observed feedback scores of
   zero, one, and zero for the respective cases.
5. Projections compact tool results while original parsed source remains available
   through `getSource`. Existing identity/scope/evaluation validations remain intact.
6. The default mock path produces one accepted cited spec and two no-proposal
   results. Verify actual tool activity and saved stage outputs.
7. The supplied-model path is exercised without exposing expected judgments before
   dreaming completes. Importing the runner does not execute the CLI.
8. Validate focused tests, the full suite, typecheck, Biome, build, runnable example,
   output inspection, and `git diff --check`. Existing local binaries may run the
   package script equivalents if pnpm's dependency preflight fails locally.

Any expansion of files, symbols, dependencies, or core behavior requires renewed
user confirmation. Report acceptance evidence separately from this contract.
