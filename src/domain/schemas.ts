import { z } from 'zod'

export const nonemptyTextSchema = z
  .string()
  .refine((value) => value.trim() !== '', 'must be a nonempty string')
const text = nonemptyTextSchema
export const scopeSchema = z.enum(['in', 'out'])
export const timestampSchema = z.string().regex(/^\d+$/, 'must be an OTLP nanosecond timestamp')
export const scoreSchema = z
  .number()
  .min(0, 'must be between 0 and 1')
  .max(1, 'must be between 0 and 1')
export const weightSchema = z.number().positive('weight must be positive')
// Validate dictionaries without replacing them: Zod record parsing may discard __proto__.
export const attributesSchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  'must be an attributes object',
)
export const sourceReferenceSchema = z.strictObject({
  trace_id: text,
  span_id: text,
  event_index: z.number().int().nonnegative().optional(),
})
export const traceRecordSchema = z.looseObject({
  span_id: text,
  event_index: z.number().int().nonnegative().optional(),
  parent_id: text.optional(),
  kind: text,
  time: timestampSchema.optional(),
  content: z.unknown().optional(),
  attributes: attributesSchema.optional(),
})
export const traceDraftSchema = z.object({
  trace_id: text,
  harness_version: text.optional(),
  records: z.array(traceRecordSchema),
})
export const traceSessionSchema = traceDraftSchema.extend({ harness_version: text })
export const evaluationAttributesSchema = z.object({
  'gen_ai.evaluation.name': text,
  'gen_ai.evaluation.score.value': scoreSchema,
  'harness_rsi.evaluation.target': scoreSchema,
  'harness_rsi.evaluation.weight': weightSchema.optional(),
})
export const traceAdditionsSchema = z.strictObject({
  harnessVersion: text.optional(),
  scopes: z.array(z.object({ reference: sourceReferenceSchema, scope: scopeSchema })).optional(),
  evaluations: z
    .array(
      z.object({
        name: text,
        value: scoreSchema,
        target: scoreSchema,
        weight: weightSchema.optional(),
        time: timestampSchema,
      }),
    )
    .optional(),
})
export const improvementSpecSchema = z.object({
  issue: text,
  proposal: text,
  predict: text,
  baseHarnessVersion: text,
  references: z.array(sourceReferenceSchema),
})
export const noProposalSchema = z.object({
  kind: z.literal('no_proposal'),
  reason: text,
  references: z.array(sourceReferenceSchema).optional(),
})
export const evaluationDecisionSchema = z.object({
  kind: z.enum(['accept', 'revise', 'reject']),
  reason: text,
  references: z.array(sourceReferenceSchema).optional(),
})
export const dreamResultSchema = z.union([
  z.object({
    kind: z.literal('spec'),
    spec: improvementSpecSchema,
    evaluation: evaluationDecisionSchema,
  }),
  noProposalSchema,
])
