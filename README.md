# Dreaming Framework

A callable TypeScript framework that turns completed OpenTelemetry traces into a
reviewable harness improvement spec. The host chooses when to run it, whether to
implement a proposal, and how to measure the actual improvement.

The pipeline enriches trace labels and evaluations, projects each session, and
runs separate proposal and evaluation agents. All four stages can be replaced.
The package includes optional Codex and DSH session adapters; the host supplies
an AI SDK model or both custom reasoning stages.

## Quick start

Node.js 24 or newer is required:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm typecheck
pnpm build
node examples/hello.ts
```

The [hello-world example](examples/hello.ts) runs offline with a synthetic trace
and mock model. It prints a fresh run directory under `results/` and saves the
returned outcome as `result.json`. Scripted responses demonstrate pipeline
behavior, not proposal quality.

## API

```ts
import { createDreamer } from 'dreaming-framework'

const dreamer = createDreamer({ model }) // Host-supplied AI SDK LanguageModel.
const result = await dreamer.dream(otelTraces, {
  workspaceDirectory: '/path/to/empty/run-directory',
})
```

`otelTraces` is an in-memory list of OTLP JSON exports. A trace folder path is also
accepted; each immediate `.json` file must contain one export with one trace ID.
Traces in a run must have the same harness version. Each call requires an empty
output directory.

The result is an accepted `spec` with an evaluator decision, or `no_proposal`
with a reason. Core writes projections and proposal-attempt artifacts and returns
the outcome; callers decide whether to persist it as `result.json`.

Codex and DSH JSONL sessions need their respective adapters before calling
`dream()`. DSH conversion requires an explicit `harnessVersion` identifying the
actual release, build, or configuration. Adapters produce no evaluation scores;
provide scored traces or an enrichment stage. With no evaluations, the framework
returns `no_proposal`.

## Architecture

```text
Session JSONL ── optional adapter ──┐
OTLP export list / JSON folder ─────┤
                                   ▼
                       load → parse → enrich → validate
                                   │
                       original source index + projections
                                   │
                       propose → validate citations → evaluate
                                   │                        │
                           spec / no_proposal      retry with feedback
```

| Location | Owner |
| --- | --- |
| `src/index.ts`, `contracts.ts` | Public exports and stage/configuration contracts |
| `src/dream.ts` | Pipeline, independent validation and retry policy |
| `src/domain/` | Shared schemas, data types, invariants and source indexing |
| `src/trace/` | Input loading, OTLP decoding and projection text formatting |
| `src/stages/` | Four stage implementations and reasoning instructions |
| `src/agent/` | Shared agent execution, context management, logging and tools |
| `src/workspace.ts` | Empty run directory preparation and confined artifact writes |
| `extensions/` | Harness-specific session conversion, outside core |

See the [architecture guide](docs/architecture.md) for file/function ownership and
executable dependency rules. [Architecture tests](tests/architecture.test.ts)
protect those boundaries.

## Guides and contracts

- [Usage guide](docs/usage.md): trace inputs, Codex/DSH adapters, examples, custom
  stages, investigation tools, artifacts, context management and data handling.
- [Framework contract](docs/specs/initial-framework.md): behavior and acceptance.
- [Project boundaries](docs/specs/project-boundaries.md): ownership contract.
- [Codex adapter](docs/specs/codex-adapter.md) and
  [DSH adapter](docs/specs/dsh-adapter.md): conversion rules.
- [Context management](docs/specs/context-management.md): budgets and compaction.

Adapters preserve supported source content without redaction. Sanitize sensitive
trace content before submitting it to the caller's model provider; projections
can still retrieve originals through `getSource`. See
[data handling](docs/usage.md#data-handling).

The package uses the [MIT license](LICENSE). Build emits JavaScript and declarations
to `dist/`. Publication and API stability are separate release decisions.
