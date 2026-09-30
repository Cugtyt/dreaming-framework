import type { LanguageModel } from 'ai'
import { Output } from 'ai'
import { z } from 'zod'
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from '../agent/context-management.ts'
import { runAgent } from '../agent/run-agent.ts'
import type { StageImplementations } from '../contracts.ts'
import { improvementSpecSchema, noProposalSchema } from '../domain/schemas.ts'

const INSTRUCTIONS = `Explore all projected sessions and generate one harness improvement spec from their evaluation scores and evidence.
Each projection is a chronological tagged text file. The trace tag gives trace_id and harness_version. Item tags give span_id, optional event_index, kind, scope, tool, and readable message or tool arguments. Evaluation tags are independent trace items with name, score, target, and weight (default 1). Meta tags hold other attributes. Use trace_id plus span_id and optional event_index as a native source reference.
For each evaluation item, compare score with target and use weight. Identify unmet targets and already-met outcomes that a change must preserve.
First use listFiles and follow nextOffset until null to find every projection. Read each projection from beginning to end, one file at a time, following readFile.nextLine until null. For truncatedLines, reread those lines with fullLines true. Use searchFiles to locate relevant evidence, summaries, or compacted items after reading the projections. Never infer missing evidence from a partial page.
Return { result: { issue, proposal, predict, baseHarnessVersion, references } } for one bounded change to the next version of the harness. Use the current harness version from the projection files as baseHarnessVersion.
Ground the change in items labeled in-scope and cite at least one of their native references. Use the file tools to inspect every projection. Use getSource to inspect the original text of relevant compacted items before claiming a cause. Treat out-of-scope items as evidence or constraints, not change targets.
Connect the proposed change to the named evaluation: identify the observed behavior that missed its target, cite its trace evidence, and explain how changing that behavior would move the score. A low score or an unrelated tool error alone does not establish the cause. If the causal link is unsupported, return no_proposal.
Predict which named scores should move toward their targets and which already-met outcomes must stay intact.
Read feedback from the previous attempt when present and revise the proposal. Before returning, verify each cited native reference with getSource. A span citation has trace_id and span_id; add event_index only for a span event.
If the evidence does not justify a specific change, return { result: { kind: "no_proposal", reason, references } } instead. Use an empty references array if none apply.`

export function defaultProposeSpec(
  model: LanguageModel,
  contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS,
): StageImplementations['proposeSpec'] {
  return async (_, services) => {
    const { attempt } = services
    const result = await runAgent({
      model,
      contextWindowTokens,
      stage: 'proposer',
      services,
      instructions: `${INSTRUCTIONS}\nRead projections/*.txt.${attempt > 1 ? ` Read attempts/${attempt - 1}/feedback.json.` : ''}`,
      output: Output.object({
        schema: z.object({
          result: z.union([improvementSpecSchema, noProposalSchema.required({ references: true })]),
        }),
      }),
      traceResult: (value) => value.result,
    })
    return result.result
  }
}
