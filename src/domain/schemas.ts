import { z } from 'zod'

export const sourceReferenceSchema = z.object({
  trace_id: z.string(),
  span_id: z.string(),
  event_index: z.number().int().nonnegative().optional(),
})

export const improvementSpecSchema = z.object({
  issue: z.string(),
  proposal: z.string(),
  predict: z.string(),
  baseHarnessVersion: z.string(),
  references: z.array(sourceReferenceSchema),
})

export const noProposalSchema = z.object({
  kind: z.literal('no_proposal'),
  reason: z.string(),
  references: z.array(sourceReferenceSchema).optional(),
})

export const evaluationDecisionSchema = z.object({
  kind: z.enum(['accept', 'revise', 'reject']),
  reason: z.string(),
  references: z.array(sourceReferenceSchema).optional(),
})
