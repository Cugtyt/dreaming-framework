import type { LanguageModel } from 'ai'
import { z } from 'zod'
import {
  improvementSpecSchema,
  nonemptyTextSchema,
  sourceReferenceSchema,
  traceRecordSchema,
  traceSessionSchema,
} from './domain/schemas.ts'
import type {
  EvaluationDecision,
  ImprovementSpec,
  NoProposal,
  SessionView,
  SourceLookup,
  TraceAdditions,
  TraceDraft,
  TraceSession,
} from './domain/types.ts'
import { invalid } from './domain/validation.ts'

export const proposalInputSchema = z.object({
  views: z.array(traceSessionSchema),
  feedback: z.string().optional(),
})
export const specEvaluationInputSchema = z.object({
  candidate: improvementSpecSchema,
  views: z.array(traceSessionSchema),
  evaluations: z.array(z.object({ reference: sourceReferenceSchema, record: traceRecordSchema })),
})
export const reasoningContextSchema = z.object({
  workspaceDirectory: nonemptyTextSchema,
  attempt: z.number().int().positive(),
})
export const dreamOptionsSchema = z.object({ workspaceDirectory: nonemptyTextSchema })
export const setupOptionsSchema = z.object({
  maxProposalAttempts: z.number().int().positive().optional(),
})

export type MaybePromise<T> = T | Promise<T>

export type ReasoningServices = z.infer<typeof reasoningContextSchema> & { getSource: SourceLookup }
export type ProposalInput = z.infer<typeof proposalInputSchema>
export type SpecEvaluationInput = z.infer<typeof specEvaluationInputSchema>

export interface StageImplementations {
  enrichTrace: (trace: Readonly<TraceDraft>) => MaybePromise<TraceAdditions>
  projectSession: (trace: TraceSession) => MaybePromise<SessionView>
  proposeSpec: (
    input: ProposalInput,
    services: ReasoningServices,
  ) => MaybePromise<ImprovementSpec | NoProposal>
  evaluateSpec: (
    input: SpecEvaluationInput,
    services: ReasoningServices,
  ) => MaybePromise<EvaluationDecision>
}

export type StageOverrides = Partial<StageImplementations>

export type DreamOptions = z.infer<typeof dreamOptionsSchema> & { stages?: StageOverrides }

type ReasoningImplementations = Pick<StageImplementations, 'proposeSpec' | 'evaluateSpec'>

export type DreamerSetup =
  | {
      model: LanguageModel
      contextWindowTokens?: number
      stages?: StageOverrides
      maxProposalAttempts?: z.infer<typeof setupOptionsSchema>['maxProposalAttempts']
    }
  | {
      model?: never
      contextWindowTokens?: number
      stages: ReasoningImplementations & StageOverrides
      maxProposalAttempts?: z.infer<typeof setupOptionsSchema>['maxProposalAttempts']
    }

export function assertStageImplementations(
  value: Partial<StageImplementations>,
): asserts value is StageImplementations {
  const names = ['enrichTrace', 'projectSession', 'proposeSpec', 'evaluateSpec'] as const
  for (const name of names) {
    if (typeof value[name] !== 'function') invalid(`${name} must be a function`)
  }
}
