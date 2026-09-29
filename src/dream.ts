import { isDeepStrictEqual } from 'node:util'
import { parseOtelTrace } from './otel.ts'
import { applyTraceAdditions, defaultEnrichTrace } from './stages/enrich-trace.ts'
import { defaultEvaluateSpec, validateDecision } from './stages/evaluate-spec.ts'
import { defaultProjectSession, validateView } from './stages/project-session.ts'
import {
  defaultProposeSpec,
  isNoProposal,
  validateCandidate,
  validateNoProposal,
} from './stages/propose-spec.ts'
import type {
  DreamerSetup,
  DreamOptions,
  DreamResult,
  SessionView,
  SourceLookup,
  SourceReference,
  StageImplementations,
  TraceRecord,
} from './types.ts'
import { assertStageImplementations, invalid, object, validateTrace } from './validation.ts'
import {
  prepareWorkspace,
  projectionText,
  writeWorkspaceJson,
  writeWorkspaceText,
} from './workspace.ts'

const DEFAULT_ATTEMPTS = 3

export function createDreamer(setup: DreamerSetup) {
  if (!object(setup)) invalid('createDreamer requires setup')
  if (
    setup.model === undefined &&
    (typeof setup.stages?.proposeSpec !== 'function' ||
      typeof setup.stages?.evaluateSpec !== 'function')
  ) {
    invalid('createDreamer requires a model or both reasoning stages')
  }
  const maxProposalAttempts = setup.maxProposalAttempts ?? DEFAULT_ATTEMPTS
  if (!Number.isInteger(maxProposalAttempts) || maxProposalAttempts < 1) {
    invalid('maxProposalAttempts must be a positive integer')
  }
  const defaults: Partial<StageImplementations> = {
    enrichTrace: defaultEnrichTrace,
    projectSession: defaultProjectSession,
    ...(setup.model === undefined
      ? {}
      : {
          proposeSpec: defaultProposeSpec(setup.model),
          evaluateSpec: defaultEvaluateSpec(setup.model),
        }),
    ...setup.stages,
  }
  assertStageImplementations(defaults)

  return {
    async dream(inputs: readonly unknown[], options: DreamOptions): Promise<DreamResult> {
      if (!Array.isArray(inputs)) invalid('traces must be an array')
      if (!object(options)) invalid('dream requires workspaceDirectory')
      const workspaceDirectory = await prepareWorkspace(options.workspaceDirectory)
      if (inputs.length === 0)
        return { kind: 'no_proposal', reason: 'No completed traces were supplied' }
      const stages: StageImplementations = { ...defaults, ...options.stages }
      const traces = await Promise.all(
        inputs.map(async (input) => {
          const draft = parseOtelTrace(input)
          const stageInput = structuredClone(draft)
          const additions = await stages.enrichTrace(stageInput)
          if (!isDeepStrictEqual(stageInput, draft))
            invalid('enrichTrace changed existing trace data')
          return validateTrace(applyTraceAdditions(draft, additions))
        }),
      )
      const harnessVersion = traces[0]!.harness_version
      const sources = new Map<string, TraceRecord>()
      const inSources = new Set<string>()
      const traceIds = new Set<string>()
      const evaluations: Array<{ reference: SourceReference; record: TraceRecord }> = []
      for (const trace of traces) {
        if (trace.harness_version !== harnessVersion) {
          invalid(`trace ${trace.trace_id} has a different harness version`)
        }
        if (traceIds.has(trace.trace_id)) invalid(`duplicate trace_id ${trace.trace_id}`)
        traceIds.add(trace.trace_id)
        for (const item of trace.records) {
          const ref: SourceReference = {
            trace_id: trace.trace_id,
            span_id: item.span_id,
            ...(item.event_index === undefined ? {} : { event_index: item.event_index }),
          }
          const key = JSON.stringify([ref.trace_id, ref.span_id, ref.event_index ?? null])
          sources.set(key, structuredClone(item))
          if (item.attributes?.['harness_rsi.scope'] === 'in') inSources.add(key)
          if (item.kind === 'gen_ai.evaluation.result') {
            const record = structuredClone(item)
            record.attributes ??= {}
            record.attributes['harness_rsi.evaluation.weight'] ??= 1
            evaluations.push({ reference: ref, record })
          }
        }
      }
      if (evaluations.length === 0) {
        return { kind: 'no_proposal', reason: 'No evaluation target was supplied' }
      }
      const getSource: SourceLookup = (ref) => {
        const item = sources.get(
          JSON.stringify([ref.trace_id, ref.span_id, ref.event_index ?? null]),
        )
        return item === undefined ? undefined : structuredClone(item)
      }
      const views: SessionView[] = await Promise.all(
        traces.map(async (trace) => {
          const view = await stages.projectSession(structuredClone(trace))
          validateView(view, trace)
          return structuredClone(view)
        }),
      )
      await Promise.all(
        views.map((view) =>
          writeWorkspaceText(
            workspaceDirectory,
            `projections/${view.trace_id}.txt`,
            projectionText(view),
          ),
        ),
      )

      let feedback: string | undefined
      const defaultProposer =
        setup.stages?.proposeSpec === undefined && options.stages?.proposeSpec === undefined
      for (let attempt = 0; attempt < maxProposalAttempts; attempt++) {
        const attemptNumber = attempt + 1
        const proposal = await stages.proposeSpec(
          {
            views: structuredClone(views),
            feedback,
          },
          {
            getSource,
            workspaceDirectory,
            attempt: attemptNumber,
          },
        )
        if (isNoProposal(proposal)) {
          validateNoProposal(proposal, sources)
          await writeWorkspaceJson(
            workspaceDirectory,
            `attempts/${attemptNumber}/proposal.json`,
            proposal,
          )
          return structuredClone(proposal)
        }
        if (defaultProposer) {
          await writeWorkspaceJson(
            workspaceDirectory,
            `attempts/${attemptNumber}/proposal.json`,
            proposal,
          )
        }
        try {
          validateCandidate(proposal, sources, inSources, harnessVersion)
        } catch (error) {
          if (
            !defaultProposer ||
            !(error instanceof Error) ||
            !/^candidate (?:has unresolved reference|needs source references|needs an in-scope source reference|must contain source references)/.test(
              error.message,
            )
          ) {
            throw error
          }
          feedback = error.message
          await writeWorkspaceJson(workspaceDirectory, `attempts/${attemptNumber}/feedback.json`, {
            reason: feedback,
          })
          continue
        }
        if (!defaultProposer) {
          await writeWorkspaceJson(
            workspaceDirectory,
            `attempts/${attemptNumber}/proposal.json`,
            proposal,
          )
        }
        const candidate = structuredClone(proposal)
        const decision = await stages.evaluateSpec(
          {
            candidate: structuredClone(candidate),
            views: structuredClone(views),
            evaluations: structuredClone(evaluations),
          },
          {
            getSource,
            workspaceDirectory,
            attempt: attemptNumber,
          },
        )
        validateDecision(decision, sources)
        await writeWorkspaceJson(
          workspaceDirectory,
          `attempts/${attemptNumber}/evaluation.json`,
          decision,
        )
        if (decision.kind === 'accept') {
          return { kind: 'spec', spec: candidate, evaluation: structuredClone(decision) }
        }
        feedback = decision.reason
        await writeWorkspaceJson(workspaceDirectory, `attempts/${attemptNumber}/feedback.json`, {
          reason: feedback,
        })
      }
      return { kind: 'no_proposal', reason: `Proposal attempt limit reached: ${feedback}` }
    },
  }
}
