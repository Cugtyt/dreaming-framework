# Default-agent context management

## Start point and accepted goal

Implement the user-confirmed contract on branch `context-compaction` in
`/Users/bytedance/MyWork/dreaming-framework-context-compaction`, based on clean
`main` at `c115d8d`. Leave the primary checkout and other worktrees untouched.
Default proposer and evaluator agents continue in the same tool loop after
older conversation history is replaced with a structured summary. Each stage
owns independent context; no proposer reasoning is passed to the evaluator.

## Scope and ownership

- `src/contracts.ts`: `DreamerSetup` includes optional `contextWindowTokens`.
- `src/dream.ts`: `createDreamer` validates and passes the setting to defaults.
- `src/agent/context-management.ts`: budget constants, `estimateContextTokens`,
  and `createContextManagement` own estimates, complete-round splitting,
  summarization and active-message replacement. Tool schemas and output format
  are resolved once for the invocation. Tools/output settings are required.
- `src/agent/checkpoint.ts`: `ContextSummary`, `summarySchema` and
  `SUMMARY_INSTRUCTIONS` own progress content, reusing domain reference/spec schemas.
- `src/agent/run-agent.ts`: `runAgent` constructs and executes the default agents
  and attaches context/tracing hooks. `defaultProposeSpec` and `defaultEvaluateSpec`
  provide their business instructions and structured outputs.
- `src/agent/model-trace.ts`: `createModelTrace` and `ModelTrace` own model/tool
  logs, summary calls and compaction boundaries. The compactor depends only on
  the summary callbacks and boundary recorder.
- `src/agent/tools/` owns confined file access and original source access.
- `tests/context-management.test.ts` covers budgets, splitting, repeated
  compaction, summary validation and failure behavior. Default-stage tests cover
  integration; workspace tests retain tool behavior checks.
- README, this spec and initial-framework document the resulting behavior;
  [project-boundaries.md](project-boundaries.md) defines module ownership.

No dependencies, provider integrations, progress trackers, session systems,
public summary types or source-pagination APIs are added. Each default agent
invocation owns independent context-management state.

## Behavior

1. `contextWindowTokens` defaults to 128,000 and must be a safe integer greater
   than 14,000, leaving room for the 10,000-token margin and bounded summary.
2. Before every normal model call, estimate the next input including instructions,
   messages, tool definitions, and output schema. Prefer reported input usage
   from the previous normal call, including cached tokens, plus an estimate for
   newly added content. When unavailable, estimate the full request. Estimates
   are approximate; cumulative usage is not a context-size measurement.
3. Trigger compaction at an estimated input of `contextWindowTokens - 10,000`.
   Split at a complete assistant/tool round boundary. Keep the latest complete
   round verbatim and outside the summary request. Reject open or mismatched
   calls at the split rather than producing invalid model messages.
   With only the first complete round there is no older work to summarize;
   reaching the threshold fails explicitly rather than consuming the 10,000-token
   headroom or dropping that round.
4. A separate, tools-disabled call to the same model uses structured output
   and at most 4,000 output tokens. The summary contains fully read files,
   in-progress files/ranges/work, findings with native references, current spec,
   rejected ideas including contrary evidence, and next steps. These are model
   reports, not mechanically verified coverage. Incomplete/truncated reads must
   not be described as complete. Include the previous summary in the older
   prefix on later compactions.
5. Preserve stage instructions and original task messages. Inject the validated
   summary in a user message after the original task and before the retained
   round, explicitly marking it as prior progress and requesting continuation.
   `prepareStep` message overrides carry forward in AI SDK 7.0.118.
6. Record summary model calls and a boundary containing the parsed summary and
   before/after estimates in the existing proposer/evaluator model JSONL log.
   No additional workspace files are introduced. Summary calls are not used to
   calibrate subsequent normal-agent usage.
7. Summary failure/invalid output aborts through the existing stage error path
   without replacing history. If the summary request or replacement cannot fit,
   abort explicitly; do not loop on compaction or truncate source evidence.
8. The existing 12-step normal-agent limit is unchanged, as are proposal retries,
   final schemas, source lookup, and custom stage behavior. Compaction calls add
   cost but do not reset normal-agent steps or proposal attempts.

## Limitations and protected behavior

The host supplies the actual window if the default does not match its model.
Token estimates cannot guarantee that a provider will accept every request.
File/search enumeration limits and unbounded `getSource` responses are preserved;
a large source or retained round can prevent continuation and fail explicitly.
No resumability or append-only logging redesign is included.

## Acceptance and implementation

Write mock-model tests first and observe failure before implementing the helper.
Tests must demonstrate no compaction below threshold, exact threshold triggering,
usage-based and missing-usage estimates, complete call/result retention,
exclusion of the recent round from summary input, original task preservation,
multiple compactions without old history reappearing, invalid/failed summaries,
oversized contexts, independent proposer/evaluator continuation, existing final
output schemas, compaction logs, configuration validation, and unchanged step
limits. The integration tests use existing default-stage fixtures.

Run `pnpm check`, `pnpm test`, `pnpm typecheck`, `pnpm build`, and
`git diff --check`. Inspect the final diff for files and symbols outside scope.
Any expansion requires renewed user confirmation before edits.
