import type { Tool } from 'ai'
import { tool } from 'ai'
import { z } from 'zod'
import { sourceReferenceSchema, traceRecordSchema } from '../../domain/schemas.ts'
import type { SourceLookup, SourceReference, TraceRecord } from '../../domain/types.ts'

export const sourceToolInputSchema = z.object({ reference: sourceReferenceSchema })
export const sourceToolOutputSchema = traceRecordSchema.nullable()

export function sourceTool(
  getSource: SourceLookup,
): Tool<{ reference: SourceReference }, TraceRecord | null> {
  return tool({
    description:
      'Read an original trace item by its source reference when compacted evidence is needed.',
    inputSchema: sourceToolInputSchema,
    execute: async (input) => {
      const { reference } = sourceToolInputSchema.parse(input)
      const result = getSource(reference) ?? null
      sourceToolOutputSchema.parse(result)
      return result
    },
  })
}
