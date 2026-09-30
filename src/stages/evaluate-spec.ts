import type { LanguageModel } from 'ai'
import { Output } from 'ai'
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../agent/context-management.ts'
import { runAgent } from '../agent/run-agent.ts'
import type { StageImplementations } from '../contracts.ts'
import { evaluationDecisionSchema } from '../domain/schemas.ts'

const INSTRUCTIONS = `Evaluate the candidate improvement spec against every supplied session and evaluation item.
Use the file tools to read the candidate and every tagged text projection file. Evaluation tags carry score, target, and weight (default 1). Infer whether the proposal would move observed scores toward their targets, taking weights and already-met outcomes into account.
Inspect contrary or compacted source evidence through getSource. Check that the proposal for the next harness version changes only behavior supported by in-scope trace items.
Independently check the causal link between the proposed change and each named score it claims to improve. Read the relevant user request and tool actions with the file tools or getSource. Reject a proposal that fixes an unrelated error, or that predicts a score gain without evidence that the measured behavior would change. A cited failed score is not itself proof of the proposed cause.
Return { kind: "accept" | "revise" | "reject", reason, references }. Cite records with { trace_id, span_id }, adding event_index only for an event; use an empty references array if none apply.
Accept only with trace-supported predicted gain and preserved constraints; otherwise give specific feedback for another proposal attempt.
This is a prediction from past traces, not a measurement of an implemented change.`

export function defaultEvaluateSpec(
  model: LanguageModel,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
): StageImplementations['evaluateSpec'] {
  return async (_, services) => {
    const { attempt } = services
    const result = await runAgent({
      model,
      contextWindowTokens,
      stage: 'evaluator',
      services,
      instructions: `${INSTRUCTIONS}\nRead attempts/${attempt}/proposal.json and projections/*.txt.`,
      output: Output.object({ schema: evaluationDecisionSchema.required({ references: true }) }),
      traceResult: (value) => value,
    })
    return result
  }
}
