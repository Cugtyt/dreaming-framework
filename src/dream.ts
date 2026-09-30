import { isDeepStrictEqual } from 'node:util'
import {
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  TRIGGER_MARGIN_TOKENS,
} from './agent/context-management.ts'
import {
  assertStageImplementations,
  type DreamerSetup,
  type DreamOptions,
  dreamOptionsSchema,
  type StageImplementations,
  setupOptionsSchema,
} from './contracts.ts'
import { createSourceIndex } from './domain/sources.ts'
import type { DreamResult, SessionView } from './domain/types.ts'
import {
  invalid,
  isNoProposal,
  object,
  ValidationError,
  validateCandidate,
  validateDecision,
  validateNoProposal,
  validateTrace,
} from './domain/validation.ts'
import { applyTraceAdditions, defaultEnrichTrace } from './stages/enrich-trace.ts'
import { defaultEvaluateSpec } from './stages/evaluate-spec.ts'
import { defaultProjectSession, validateView } from './stages/project-session.ts'
import { defaultProposeSpec } from './stages/propose-spec.ts'
import { parseOtelTrace } from './trace/otel.ts'
import { projectionText } from './trace/projection.ts'
import { prepareWorkspace, writeWorkspaceJson, writeWorkspaceText } from './workspace.ts'

const DEFAULT_ATTEMPTS = 3

export function createDreamer(setup: DreamerSetup) {
  if (!object(setup)) invalid('createDreamer requires setup')
  if (setup.stages !== undefined && !object(setup.stages))
    invalid('setup stages must be an object', 'shape')
  const contextWindowTokens = setup.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
  if (
    !Number.isSafeInteger(contextWindowTokens) ||
    contextWindowTokens <= TRIGGER_MARGIN_TOKENS + SUMMARY_MAX_OUTPUT_TOKENS
  ) {
    invalid('contextWindowTokens must be a safe integer greater than 14000')
  }
  if (
    setup.model === undefined &&
    (typeof setup.stages?.proposeSpec !== 'function' ||
      typeof setup.stages?.evaluateSpec !== 'function')
  ) {
    invalid('createDreamer requires a model or both reasoning stages')
  }
  const maxProposalAttempts = setup.maxProposalAttempts ?? DEFAULT_ATTEMPTS
  if (!setupOptionsSchema.safeParse({ maxProposalAttempts }).success) {
    invalid('maxProposalAttempts must be a positive integer', 'shape')
  }
  const defaults: Partial<StageImplementations> = {
    enrichTrace: defaultEnrichTrace,
    projectSession: defaultProjectSession,
    ...(setup.model === undefined
      ? {}
      : {
          proposeSpec: defaultProposeSpec(setup.model, contextWindowTokens),
          evaluateSpec: defaultEvaluateSpec(setup.model, contextWindowTokens),
        }),
    ...setup.stages,
  }
  assertStageImplementations(defaults)

  return {
    async dream(inputs: readonly unknown[], options: DreamOptions): Promise<DreamResult> {
      if (!Array.isArray(inputs)) invalid('traces must be an array')
      if (!object(options)) invalid('dream requires workspaceDirectory')
      if (!dreamOptionsSchema.safeParse(options).success)
        invalid('dream requires workspaceDirectory', 'shape')
      if (options.stages !== undefined && !object(options.stages))
        invalid('run stages must be an object', 'shape')
      const stages = { ...defaults, ...options.stages }
      assertStageImplementations(stages)
      const workspaceDirectory = await prepareWorkspace(options.workspaceDirectory)
      if (inputs.length === 0)
        return { kind: 'no_proposal', reason: 'No completed traces were supplied' }
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
      const firstTrace = traces[0]
      if (firstTrace === undefined) invalid('No completed traces were parsed')
      const harnessVersion = firstTrace.harness_version
      const traceIds = new Set<string>()
      for (const trace of traces) {
        if (trace.harness_version !== harnessVersion) {
          invalid(`trace ${trace.trace_id} has a different harness version`)
        }
        if (traceIds.has(trace.trace_id)) invalid(`duplicate trace_id ${trace.trace_id}`)
        traceIds.add(trace.trace_id)
      }
      const { sources, inSources, evaluations, getSource } = createSourceIndex(traces)
      if (evaluations.length === 0) {
        return { kind: 'no_proposal', reason: 'No evaluation target was supplied' }
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
            ...(feedback === undefined ? {} : { feedback }),
          },
          {
            getSource,
            workspaceDirectory,
            attempt: attemptNumber,
          },
        )
        if (defaultProposer) {
          await writeWorkspaceJson(
            workspaceDirectory,
            `attempts/${attemptNumber}/proposal.json`,
            proposal,
          )
        }
        try {
          if (isNoProposal(proposal)) validateNoProposal(proposal, sources)
          else validateCandidate(proposal, sources, inSources, harnessVersion)
        } catch (error) {
          if (
            !defaultProposer ||
            !(error instanceof ValidationError) ||
            error.category !== 'reference'
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
        if (isNoProposal(proposal)) return structuredClone(proposal)
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
