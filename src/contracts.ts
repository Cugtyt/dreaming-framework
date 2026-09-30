import type { LanguageModel } from 'ai'
import type {
  EvaluationDecision,
  ImprovementSpec,
  NoProposal,
  SessionView,
  SourceLookup,
  SourceReference,
  TraceAdditions,
  TraceDraft,
  TraceRecord,
  TraceSession,
} from './domain/types.ts'
import { invalid } from './domain/validation.ts'

export type MaybePromise<T> = T | Promise<T>

export interface ReasoningServices {
  getSource: SourceLookup
  workspaceDirectory: string
  attempt: number
}

export interface ProposalInput {
  views: SessionView[]
  feedback?: string
}

export interface SpecEvaluationInput {
  candidate: ImprovementSpec
  views: SessionView[]
  evaluations: Array<{ reference: SourceReference; record: TraceRecord }>
}

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

export interface DreamOptions {
  workspaceDirectory: string
  stages?: StageOverrides
}

type ReasoningImplementations = Pick<StageImplementations, 'proposeSpec' | 'evaluateSpec'>

export type DreamerSetup =
  | {
      model: LanguageModel
      contextWindowTokens?: number
      stages?: StageOverrides
      maxProposalAttempts?: number
    }
  | {
      model?: never
      contextWindowTokens?: number
      stages: ReasoningImplementations & StageOverrides
      maxProposalAttempts?: number
    }

export function assertStageImplementations(
  value: Partial<StageImplementations>,
): asserts value is StageImplementations {
  const names = ['enrichTrace', 'projectSession', 'proposeSpec', 'evaluateSpec'] as const
  for (const name of names) {
    if (typeof value[name] !== 'function') invalid(`${name} must be a function`)
  }
}
