import type { z } from 'zod'
import type {
  evaluationDecisionSchema,
  improvementSpecSchema,
  noProposalSchema,
  sourceReferenceSchema,
} from './schemas.ts'

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

export type SourceReference = z.infer<typeof sourceReferenceSchema>
export type ImprovementSpec = z.infer<typeof improvementSpecSchema>
export type NoProposal = z.infer<typeof noProposalSchema>
export type EvaluationDecision = z.infer<typeof evaluationDecisionSchema>

export type DreamResult =
  | { kind: 'spec'; spec: ImprovementSpec; evaluation: EvaluationDecision }
  | NoProposal

export type SourceLookup = (reference: SourceReference) => TraceRecord | undefined
