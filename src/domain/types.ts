import type { z } from 'zod'
import type * as schemas from './schemas.ts'

export type Scope = z.infer<typeof schemas.scopeSchema>
export type TraceRecord = z.infer<typeof schemas.traceRecordSchema>
export type TraceSession = z.infer<typeof schemas.traceSessionSchema>
export type TraceDraft = z.infer<typeof schemas.traceDraftSchema>
export type TraceAdditions = z.infer<typeof schemas.traceAdditionsSchema>
export type SessionView = TraceSession
export type SourceReference = z.infer<typeof schemas.sourceReferenceSchema>
export type ImprovementSpec = z.infer<typeof schemas.improvementSpecSchema>
export type NoProposal = z.infer<typeof schemas.noProposalSchema>
export type EvaluationDecision = z.infer<typeof schemas.evaluationDecisionSchema>
export type DreamResult = z.infer<typeof schemas.dreamResultSchema>
export type SourceLookup = (reference: SourceReference) => TraceRecord | undefined
