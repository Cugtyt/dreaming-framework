# Codex session adapter

## Goal and interface

The optional `extensions/codex/` adapter converts a local Codex session JSONL
record into an array containing one completed OTLP JSON trace. The core
framework continues to receive OTLP exports from any harness.

`codexAdapter.convertSession(jsonl)` converts a supplied string synchronously.
`codexAdapter.readSession(path)` reads one file and returns the same output.
Both are available from `dreaming-framework/extensions/codex`.

## Conversion contract

- Session metadata must contain a nonempty `session_id` or `id` and
  `cli_version`. The Resource declares `harness_rsi.harness.version` as
  `codex-cli@<cli_version>`.
- Only response items within turns closed by `task_complete` are included.
  An unfinished or aborted turn contributes no items. A session with no
  supported items in completed turns fails clearly.
- User, system, developer, and assistant text messages become message spans.
  Non-text message parts are omitted. User/system/developer messages carry
  scope `out`; assistant messages carry scope `in`.
- `function_call` and `custom_tool_call` become `gen_ai.tool.call` spans with
  scope `in`. Their outputs become `gen_ai.tool.call.result` spans with scope
  `out`. Results reference their matching call within the same turn; an
  unmatched result references the session root.
- Source timestamps and line order determine chronology. IDs are deterministic
  hashes of session identity and source position. Records need no `ordinal`
  field. Point records use a one-nanosecond span duration; the session root
  covers the converted records.
- Text and tool results are retained without truncation. Structured tool
  arguments/results are serialized as JSON. Reasoning, non-response records,
  and unsupported response item kinds are omitted.
- Conversion produces no evaluation scores. A host may supply `enrichTrace`
  to add them before dreaming. Conversion does not modify the source file.
- Invalid JSON, missing metadata, invalid timestamps on included records,
  and missing turn identifiers fail with an actionable error.

## Implementation and acceptance

The adapter owns Codex parsing and OTLP construction. `index.ts` exports it;
`session-to-otel.ts` owns the two conversion functions. The example
`dreamCodexSession(sessionPath, model, workspaceDirectory)` connects the adapter
to the existing feedback enricher and framework. No provider or dependency is
added. The runnable example uses a synthetic trace and mock model; historical
samples are excluded. The core stage APIs are unchanged.

Tests use synthetic Codex records to verify completed-turn filtering, message
and tool mapping, stable IDs, malformed-input errors, file reading, and use in
dreaming. Required checks are adapter tests, the full test suite, style checks,
type checking, build, compiled core/extension imports, and `git diff --check`.
