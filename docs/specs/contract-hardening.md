# Contract hardening

Status: resolved and approved migration. The `contract-hardening` worktree is
updated to current `main` at `ceefe74`. Its previous uncommitted implementation
is preserved in recovery stash `3e437236cf5f41ff1445e4abd8c76a84ea4b7c34`.
Port that implementation into the current module owners while retaining main's
strict checks, agent runner and context compaction. Main remains untouched;
ported changes remain uncommitted. No dependencies or public exports are added.

## Behavior

- List every text/JSON file using stable sorted relative paths. `offset` defaults
  to 0, `limit` to 200 (1–200). Return `files`, exact `total`, and `nextOffset`
  (`null` at the end). No files disappear because of a total-count cap.
- Search literal text by default or opt into case-insensitive JavaScript regular
  expressions. Optional `path` selects an existing exact file or directory
  prefix, confined to the workspace. `contextLines` defaults to 0 (0–5).
  `offset` defaults to 0, `limit` to 100 (1–100). Return matches with path,
  one-based line, text, surrounding context including the match; exact `total`,
  `nextOffset`, and `truncated` for additional result pages. All files/lines are
  searched. Invalid regexes produce an actionable error.
- Read at most 200 lines per page, defaulting to line 1 and 200 lines. Each line
  over 200 Unicode code points shows its first 100, an omitted-character marker,
  and last 100. Return `truncatedLines` (one-based), `truncated` for previews,
  and `nextLine` (`null` at the end). `fullLines: true` preserves the selected
  lines completely; there is no aggregate character cap. `getSource` remains
  unlimited and returns the original record or null.
- Both reasoning prompts instruct the model to list all pages and read each
  projection from beginning to end, one file at a time. Search and source
  retrieval aid inspection of relevant evidence and compacted items. The
  projection's existing `[compacted]` marker remains unchanged.
- Validate merged stage implementations before workspace creation, including
  empty runs. An explicit undefined/null/nonfunction override is rejected;
  omitted overrides inherit defaults. Invalid override containers are rejected.
- `ValidationError.category` distinguishes `shape`, `invariant`, and `reference`.
  Default proposal validation retries reference errors, including unresolved
  `no_proposal` citations, saving proposal and feedback and skipping evaluation.
  Candidates also require nonempty citations and at least one in-scope citation;
  `no_proposal` may omit citations.
  Custom proposal errors fail immediately. Revision/rejection uses existing
  attempt limits. Other exceptions and schema/semantic errors fail immediately.
- Zod owns supported OTLP/Codex input shapes, domain data, serializable options,
  and tool inputs/outputs; domain types are inferred. Semantic identity, graph,
  enrichment, and source-resolution rules remain with their existing owners.
  Callback signatures/provider types stay native TypeScript. Recursive OTLP
  AnyValue needs an explicit TypeScript annotation for Zod's lazy recursion;
  runtime shapes are validated by Zod. Arbitrary attribute dictionaries use a
  Zod custom object validator without reconstruction, preserving `__proto__`.
- Attribute and nested KV dictionaries accept arbitrary own keys, including
  `constructor` and `__proto__`. Actual duplicate keys fail. OTLP extra standard
  fields remain tolerated; unsupported Codex record kinds remain omitted.
  Recognized supported payloads in completed turns are validated, including
  rejection of missing or invalid message roles. Unfinished payloads are excluded first.
- The example shares call/result association and counts equal read contents for
  a path precisely, even when a later result changes. These observations and
  scripted acceptance remain demonstrations, not measured harness improvement.

## Closed change surface and ownership

- `src/domain/schemas.ts` and `types.ts`: domain shapes and inferred types.
- `src/domain/validation.ts`: categorized ValidationError, invalid, references,
  trace and proposal/decision semantic validation.
- `src/contracts.ts`: setup/options schemas, inferred stage inputs/services and
  executable stage contracts, with stage validation before filesystem effects.
- `src/dream.ts`: early override validation and categorized candidate retry,
  preserving context-window configuration and source indexing from main.
- New `src/trace/schemas.ts`: OtelAnyValue, recursive AnyValue/attribute/OTLP
  schemas. `src/trace/otel.ts`: parsing, decoding and safe dictionaries.
- `src/agent/tools/file-tools.ts`: file input/output schemas, pagination, search,
  previews/full reads. `source-tool.ts`: source schemas and preserved lookup.
- `src/stages/{enrich-trace,project-session,propose-spec,evaluate-spec}.ts`:
  schema validation and reading instructions; construction stays in run-agent.
- `examples/codex-test-set.ts` and existing tests for codex-adapter, codex-test-set,
  default-stages, dream, otel and workspace: reconcile behavior with new paths,
  schemas and checked fixtures from tests/helpers.ts.
- README, initial-framework and this spec: reconcile ownership/reading contracts.
- Remove obsolete root schemas/types/validation/otel files and stage tool locations.

Keep current main's index exports, source index, trace formatter, agent runner,
checkpoint, compactor, tracing and strict configuration. Restore the pending
Codex adapter implementation. The separately confirmed typing repair in
`extensions/codex/session-to-otel.ts:convertSession` uses parsed metadata rather
than a non-null assertion, preserving adapter behavior.
Unlimited fullLines/source outputs retain
existing semantics; context-budget failure on oversized retained output is a
known integration limitation, not a new pagination API in this migration.

No cancellation, budget redesign, provider configuration, citation layout change,
new dependencies or automatic commit is in scope. After resolving conflicts,
leave the worktree based on main with uncommitted hardening changes and retain
its recovery stash. Do not modify the primary checkout.

## Confirmed follow-up fixes

Reuse this dirty worktree on `contract-hardening`; preserve the recovery stash
and leave main untouched. In `extensions/codex/session-to-otel.ts:convertSession`,
dispatch messages by payload type so the existing message schema rejects missing
or invalid roles only in completed turns. In `src/dream.ts:createDreamer().dream`,
route default `no_proposal` reference failures through the existing proposal
artifact, feedback, and bounded retry path. Keep custom validation failures and
non-reference errors immediate. Update `tests/codex-adapter.test.ts` and
`tests/default-stages.test.ts` with regressions for completed/unfinished invalid
roles, successful retry, attempt exhaustion, custom fail-fast, and malformed
output fail-fast, including artifacts and skipped evaluation. Update README and
this spec. No other files, symbols, dependencies, or abstractions are added;
leave the changes uncommitted.

## Acceptance

Regression tests must cover 201 files and pagination, filtered regex/context
search, long-line preview/full-read recovery, invalid overrides before filesystem
side effects, arbitrary/nested attribute keys and real duplicate rejection,
completed-turn Codex payload checks, categorized citation errors, and exact
matching-result counts. Existing stage orchestration tests remain green.
Typecheck, Biome checks, declaration build, and the offline inspection CLI must
pass. The three offline cases retain spec/no-proposal/no-proposal judgments and
inspectable stage outputs. These checks verify behavior and schema consistency;
they do not measure improvement from an implemented harness change.


## Migration implementation and acceptance

Use existing main tests as the baseline; retain every hardening regression before
porting implementation, then obtain green combined tests. Resolve moved modules
and schemas within their owners, retaining main's typed runner and compactor.
Type repairs must omit absent option fields, match Zod optional semantics and
use checked fixture access; intentional malformed-input tests may bypass typing.
All combined tests, strict TypeScript typecheck, Biome check/format, declaration
build, offline case judgments and architecture boundaries must pass. Require no
conflict markers or obsolete imports, no new dependency/config relaxation, and
confirm primary main stays clean. Any extra file, behavior or abstraction needs
confirmation before editing.
