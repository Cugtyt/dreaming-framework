export type Scope = 'in' | 'out'

export interface TraceRecord {
  item_id: string
  parent_id?: string
  kind: string
  time?: string
  subject?: { id: string; version?: string }
  content?: unknown
  'harness_rsi.scope'?: Scope
  'harness_rsi.evaluation'?: {
    name: string
    value: number
    target: number
    weight?: number
  }
}

export interface TraceSession {
  trace_id: string
  schema_version: string
  scope_boundary: string
  records: TraceRecord[]
}

export interface Goal {
  boundary: string
  question: string
  constraints?: string[]
}

export type SessionView = TraceSession

export interface Observation {
  text: string
  references: string[]
}

export interface SessionResult {
  view: SessionView
  observations: Observation[]
}

export interface ImprovementSpec {
  issue: string
  proposal: string
  predict: string
  componentId: string
  references: string[]
}

export interface NoProposal {
  kind: 'no_proposal'
  reason: string
  references?: string[]
}

export interface EvaluationDecision {
  kind: 'accept' | 'revise' | 'reject'
  reason: string
  references?: string[]
}

export type DreamResult =
  | { kind: 'spec'; spec: ImprovementSpec; evaluation: EvaluationDecision }
  | NoProposal

export type SourceLookup = (reference: string) => TraceRecord | undefined
export type MaybePromise<T> = T | Promise<T>

export interface StageImplementations {
  mapTrace: (input: unknown) => MaybePromise<TraceSession>
  projectSession: (
    trace: TraceSession,
    context: { goal: Goal; getSource: SourceLookup },
  ) => MaybePromise<SessionView>
  analyzeSession: (
    view: SessionView,
    context: { goal: Goal; getSource: SourceLookup },
  ) => MaybePromise<Observation[]>
  proposeSpec: (input: {
    goal: Goal
    sessions: SessionResult[]
    feedback?: string
    getSource: SourceLookup
  }) => MaybePromise<ImprovementSpec | NoProposal>
  evaluateSpec: (input: {
    goal: Goal
    candidate: ImprovementSpec
    sessions: SessionResult[]
    evaluations: Array<{ reference: string; record: TraceRecord }>
    getSource: SourceLookup
  }) => MaybePromise<EvaluationDecision>
}

export type StageOverrides = Partial<StageImplementations>

export type BaseStages = Pick<
  StageImplementations,
  'analyzeSession' | 'proposeSpec' | 'evaluateSpec'
> & Partial<Pick<StageImplementations, 'mapTrace' | 'projectSession'>>

export interface DreamerOptions {
  maxProposalAttempts?: number
}
