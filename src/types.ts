import type { LanguageModel } from 'ai'

export type Scope = 'in' | 'out'

export interface TraceRecord {
  span_id: string
  event_index?: number
  parent_id?: string
  kind: string
  time?: string
  content?: unknown
  attributes?: Record<string, unknown>
}

export interface TraceSession {
  trace_id: string
  harness_version: string
  records: TraceRecord[]
}

export interface TraceDraft {
  trace_id: string
  harness_version?: string
  records: TraceRecord[]
}

export interface TraceAdditions {
  harnessVersion?: string
  scopes?: Array<{ reference: SourceReference; scope: Scope }>
  evaluations?: Array<{
    name: string
    value: number
    target: number
    weight?: number
    time: string
  }>
}

export type SessionView = TraceSession

export interface SourceReference {
  trace_id: string
  span_id: string
  event_index?: number
}

export interface ImprovementSpec {
  issue: string
  proposal: string
  predict: string
  baseHarnessVersion: string
  references: SourceReference[]
}

export interface NoProposal {
  kind: 'no_proposal'
  reason: string
  references?: SourceReference[]
}

export interface EvaluationDecision {
  kind: 'accept' | 'revise' | 'reject'
  reason: string
  references?: SourceReference[]
}

export type DreamResult =
  | { kind: 'spec'; spec: ImprovementSpec; evaluation: EvaluationDecision }
  | NoProposal

export type SourceLookup = (reference: SourceReference) => TraceRecord | undefined
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
      stages?: StageOverrides
      maxProposalAttempts?: number
    }
  | {
      model?: never
      stages: ReasoningImplementations & StageOverrides
      maxProposalAttempts?: number
    }
