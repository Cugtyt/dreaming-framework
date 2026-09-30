import type { Tool } from 'ai'
import { tool } from 'ai'
import { z } from 'zod'
import { sourceReferenceSchema } from '../../domain/schemas.ts'
import type { SourceLookup, SourceReference, TraceRecord } from '../../domain/types.ts'

export function sourceTool(
  getSource: SourceLookup,
): Tool<{ reference: SourceReference }, TraceRecord | null> {
  return tool({
    description:
      'Read an original trace item by its source reference when compacted evidence is needed.',
    inputSchema: z.object({
      reference: sourceReferenceSchema,
    }),
    execute: async ({ reference }) => getSource(reference) ?? null,
  })
}
