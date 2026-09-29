# Feedback enrichment example

## Goal

Show how a host supplies completed OTLP traces and an AI SDK model to the
dreaming framework. The host's `enrichTrace` stage adds business-specific
evaluations; the framework projects the enriched traces and runs its proposal
and evaluation agents.

## Input and boundary

`dreamWithFeedback(traces, model, workspaceDirectory)` accepts traces already
prepared by the caller. Each trace contains a harness version on its OTLP
Resource and `harness_rsi.scope` labels on relevant items. The caller supplies
an empty run directory. This example does not collect sessions or convert
another trace format.

## Feedback rule

`enrichUserFeedback` reads parsed user-message records that follow assistant-message
records in trace order. Explicit complaints about hostility, complexity,
quality, correctness, or confusion score `0`. An unqualified message beginning
“ok”, “right”, “fine”, “yes”, or “looks better” scores `1`. Quoted lines, fenced
code, synthetic prompts, and phrases introduced as examples do not count.
Unmatched messages receive no score. These rules are a narrow proxy for user
feedback; they do not measure satisfaction or explain its cause.

For every scored message, enrichment returns an independent evaluation addition
with name `explicit_user_feedback/v1`, value `0` or `1`, target `1`, and a trace
timestamp. A trace may contain several such evaluations. The framework assigns
span IDs and applies the additions. The original OTLP input remains intact.
The framework then creates one
text projection per trace and lets its agents inspect compacted content or
retrieve source items.

## Acceptance

- The example starts with supplied OTLP traces and calls `dream()` with the
  supplied model and an `enrichTrace` implementation.
- Scored feedback produces independent evaluation records. Unmatched feedback
  does not add evaluations.
- The example contains no OTLP schema aliases, raw span traversal, or ID
  generation. It adds no dependency or collection/conversion step.
