# DSH session adapter

## Goal and interface

The optional `extensions/dsh/` adapter converts one uncompressed DSH Session
JSONL log into an array containing one completed OTLP JSON trace. The core
framework remains independent of DSH and continues to receive OTLP exports.

```ts
import { dshAdapter } from 'dreaming-framework/extensions/dsh'

const traces = dshAdapter.convertSession(jsonl, {
  harnessVersion: 'dsh@0.2.0-rc.2',
})

const sameTraces = await dshAdapter.readSession('/path/to/session.v4.jsonl', {
  harnessVersion: 'dsh@0.2.0-rc.2',
})
```

`harnessVersion` is required because the Session format version identifies storage
compatibility, not harness behavior. Supply the deployed DSH release, build, or
configuration identifier so traces from behaviorally different builds cannot be
mistaken for one harness version.

## Getting an input log

In DSH, choose **Download session log** from the Session Header menu or run
`/export`. Extract the downloaded ZIP and pass its `session.v3.jsonl` or
`session.v4.jsonl` file to `readSession`. The archive can also contain descendant
sessions and attachments; convert each desired Session JSONL separately.

DSH's internal persistence defaults to concatenated Zstandard frames. The
adapter deliberately does not decode `.jsonl.zstd` storage files because they
are backend-owned artifacts with migration and recovery semantics. If such a
path is passed, `readSession` directs the caller to the supported export flow.

## Conversion contract

- The first line must be a DSH `type: "session"` header with a nonempty `id`, a
  nonnegative `createdAt`, and released format version 3 or 4.
- Remaining rows must have contiguous zero-based `seq` values, millisecond
  timestamps, an event type, and an object `data` payload.
- Only events between a matching `turn/start` and a `turn/end` whose
  `reason.kind` is `completed` are converted. Aborted, failed, interrupted, and
  unfinished turns contribute no records.
- Append-origin `system/message`, `developer/message`, `user/message`, and
  `assistant/message` events become message spans. System, developer, and user
  messages are out of scope; assistant messages are in scope.
- Assistant reasoning is omitted from assistant message spans. Embedded
  `tool-call` blocks become in-scope `gen_ai.tool.call` spans at request time,
  including calls that never start. A matching explicit `tool/call` marks the
  request as started and must agree on name and arguments; an execution event
  without a request still becomes a call span.
- Append-origin `tool/result` events become out-of-scope
  `gen_ai.tool.call.result` spans. A result is parented to the matching requested
  or started call in the same turn and step, or to the Session root when no
  earlier call exists. Duplicate calls/results and calls appearing after their
  result are rejected.
- Surface replacement messages and results become in-scope
  `dsh.surface.replacement` spans, retaining replacement content, range, and
  source event type. This keeps model-history compaction and offloading behavior
  available as harness evidence without replacing the append-origin transcript.
- Surface operations are validated for append/replacement shape, ordered range,
  and strictly ordered prior `sourceEventSeqs` covering the range endpoints.
  Tool-result role and identity rules are validated for v3 and v4, including
  matching source, message, and content-block call IDs.
- Text and primitive or structured result content are retained without
  truncation. Non-text message blocks and structured tool arguments/results are
  serialized as JSON. Private assistant reasoning, unsupported events, and
  events outside turns are omitted.
- Event `seq` is authoritative chronology. Millisecond timestamps are converted
  to monotonic nanosecond timestamps in sequence order, even if the source clock
  moves backward. Trace and span IDs are deterministic hashes of Session
  identity, event sequence, and block identity. The generated spans also retain
  DSH Session, event, turn, step, message, call, surface, and format metadata.
- Conversion produces no evaluation scores. A host can use `enrichTrace`, such
  as the feedback enricher in `examples/dream-with-feedback.ts`, before dreaming.
  Conversion and file reading do not modify or redact the source log. Callers
  must sanitize exported messages, tool arguments, results, replacements, and
  metadata before conversion or model submission.

## Implementation and acceptance

`index.ts` exports the `dshAdapter` namespace and `DshAdapterOptions` type.
`session-to-otel.ts` owns parsing, completed-turn filtering, OTLP construction,
and file loading. `examples/dream-dsh-session.ts` connects the adapter to the
existing feedback enricher and framework. The adapter adds no DSH runtime or
package dependency.

Synthetic tests cover stable identities, completed and aborted turns, canonical
sequence ordering under clock drift, requested and started tool calls, v3/v4
result identities, primitive result retention, surface replacement evidence and
validation, malformed inputs, compressed-log guidance, source-file preservation,
and framework integration.
