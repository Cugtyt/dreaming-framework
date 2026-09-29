import type { LanguageModel } from 'ai'
import { Output, stepCountIs, ToolLoopAgent } from 'ai'
import { z } from 'zod'
import type { EvaluationDecision, StageImplementations, TraceRecord } from '../types.ts'
import { invalid, object, references, text } from '../validation.ts'
import { fileTools } from './file-tools.ts'
import { createModelTrace } from './model-trace.ts'
import { sourceTool } from './source-tool.ts'

const INSTRUCTIONS = `Evaluate the candidate improvement spec against every supplied session and evaluation item.
Use the file tools to read the candidate and every tagged text projection file. Evaluation tags carry score, target, and weight (default 1). Infer whether the proposal would move observed scores toward their targets, taking weights and already-met outcomes into account.
Inspect contrary or compacted source evidence through getSource. Check that the proposal for the next harness version changes only behavior supported by in-scope trace items.
Independently check the causal link between the proposed change and each named score it claims to improve. Read the relevant user request and tool actions with the file tools or getSource. Reject a proposal that fixes an unrelated error, or that predicts a score gain without evidence that the measured behavior would change. A cited failed score is not itself proof of the proposed cause.
Return { kind: "accept" | "revise" | "reject", reason, references }. Cite records with { trace_id, span_id }, adding event_index only for an event; use an empty references array if none apply.
Accept only with trace-supported predicted gain and preserved constraints; otherwise give specific feedback for another proposal attempt.
This is a prediction from past traces, not a measurement of an implemented change.`

const referenceSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  event_index: z.number().int().nonnegative().optional(),
})
const decisionSchema = z.object({
  kind: z.enum(['accept', 'revise', 'reject']),
  reason: z.string(),
  references: z.array(referenceSchema),
})

export function defaultEvaluateSpec(model: LanguageModel): StageImplementations['evaluateSpec'] {
  return async (_, { getSource, workspaceDirectory, attempt }) => {
    const trace = createModelTrace(workspaceDirectory, attempt, 'evaluator')
    const agent = new ToolLoopAgent({
      model,
      id: 'dreaming.evaluator',
      instructions: `${INSTRUCTIONS}\nRead attempts/${attempt}/proposal.json and projections/*.txt.`,
      output: Output.object({ schema: decisionSchema }),
      tools: { ...fileTools(workspaceDirectory), getSource: sourceTool(getSource) },
      stopWhen: stepCountIs(12),
      ...trace.callbacks,
    })
    let generation: Awaited<ReturnType<typeof agent.generate>>
    try {
      generation = await agent.generate({ prompt: workspaceDirectory })
    } catch (error) {
      await trace.writeError(error)
      throw error
    }
    await trace.writeResult(generation.output)
    return generation.output
  }
}

export function validateDecision(
  value: unknown,
  sources: Map<string, TraceRecord>,
): asserts value is EvaluationDecision {
  if (!object(value) || !['accept', 'revise', 'reject'].includes(String(value.kind))) {
    invalid('evaluateSpec must accept, revise, or reject')
  }
  text(value.reason, 'evaluation reason')
  if (value.references !== undefined) references(value.references, 'evaluation decision', sources)
}
