import type { LanguageModel } from 'ai'
import { Output, stepCountIs, ToolLoopAgent } from 'ai'
import { z } from 'zod'
import type {
  ImprovementSpec,
  NoProposal,
  SourceReference,
  StageImplementations,
  TraceRecord,
} from '../types.ts'
import { invalid, object, references, text } from '../validation.ts'
import { fileTools } from './file-tools.ts'
import { createModelTrace } from './model-trace.ts'
import { sourceTool } from './source-tool.ts'

const INSTRUCTIONS = `Explore all projected sessions and generate one harness improvement spec from their evaluation scores and evidence.
Each projection is a chronological tagged text file. The trace tag gives trace_id and harness_version. Item tags give span_id, optional event_index, kind, scope, tool, and readable message or tool arguments. Evaluation tags are independent trace items with name, score, target, and weight (default 1). Meta tags hold other attributes. Use trace_id plus span_id and optional event_index as a native source reference.
For each evaluation item, compare score with target and use weight. Identify unmet targets and already-met outcomes that a change must preserve.
Projection files can be longer than one readFile page. First use listFiles to find every projection, then searchFiles for <evaluation. Read the matching lines and inspect all sessions before deciding whether evidence is missing. Never claim a score or target is absent from a projection based only on its first page.
Return { result: { issue, proposal, predict, baseHarnessVersion, references } } for one bounded change to the next version of the harness. Use the current harness version from the projection files as baseHarnessVersion.
Ground the change in items labeled in-scope and cite at least one of their native references. Use the file tools to inspect every projection. Use getSource to inspect the original text of relevant compacted items before claiming a cause. Treat out-of-scope items as evidence or constraints, not change targets.
Connect the proposed change to the named evaluation: identify the observed behavior that missed its target, cite its trace evidence, and explain how changing that behavior would move the score. A low score or an unrelated tool error alone does not establish the cause. If the causal link is unsupported, return no_proposal.
Predict which named scores should move toward their targets and which already-met outcomes must stay intact.
Read feedback from the previous attempt when present and revise the proposal. Before returning, verify each cited native reference with getSource. A span citation has trace_id and span_id; add event_index only for a span event.
If the evidence does not justify a specific change, return { result: { kind: "no_proposal", reason, references } } instead. Use an empty references array if none apply.`

const referenceSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  event_index: z.number().int().nonnegative().optional(),
})
const candidateSchema = z.object({
  issue: z.string(),
  proposal: z.string(),
  predict: z.string(),
  baseHarnessVersion: z.string(),
  references: z.array(referenceSchema),
})
const noProposalSchema = z.object({
  kind: z.literal('no_proposal'),
  reason: z.string(),
  references: z.array(referenceSchema),
})

export function defaultProposeSpec(model: LanguageModel): StageImplementations['proposeSpec'] {
  return async (_, { getSource, workspaceDirectory, attempt }) => {
    const trace = createModelTrace(workspaceDirectory, attempt, 'proposer')
    const agent = new ToolLoopAgent({
      model,
      id: 'dreaming.proposer',
      instructions: `${INSTRUCTIONS}\nRead projections/*.txt.${attempt > 1 ? ` Read attempts/${attempt - 1}/feedback.json.` : ''}`,
      output: Output.object({
        schema: z.object({ result: z.union([candidateSchema, noProposalSchema]) }),
      }),
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
    await trace.writeResult(generation.output.result)
    return generation.output.result
  }
}

export function isNoProposal(value: unknown): value is NoProposal {
  return object(value) && value.kind === 'no_proposal'
}

export function validateNoProposal(value: NoProposal, sources: Map<string, TraceRecord>): void {
  text(value.reason, 'no-proposal reason')
  if (value.references !== undefined) references(value.references, 'no-proposal', sources)
}

export function validateCandidate(
  value: unknown,
  sources: Map<string, TraceRecord>,
  inSources: Set<string>,
  harnessVersion: string,
): asserts value is ImprovementSpec {
  if (!object(value)) invalid('proposeSpec must return a candidate or no proposal')
  text(value.issue, 'Issue')
  text(value.proposal, 'Proposal')
  text(value.predict, 'Predict')
  text(value.baseHarnessVersion, 'base harness version')
  if (value.baseHarnessVersion !== harnessVersion)
    invalid('candidate has a different base harness version')
  references(value.references, 'candidate', sources)
  if (value.references.length === 0) invalid('candidate needs source references')
  if (
    !(value.references as SourceReference[]).some((reference) =>
      inSources.has(
        JSON.stringify([reference.trace_id, reference.span_id, reference.event_index ?? null]),
      ),
    )
  ) {
    invalid('candidate needs an in-scope source reference')
  }
}
