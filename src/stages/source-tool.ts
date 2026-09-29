import type { Tool } from 'ai'
import { tool } from 'ai'
import { z } from 'zod'
import type { SourceLookup, SourceReference, TraceRecord } from '../types.ts'

export function sourceTool(
  getSource: SourceLookup,
): Tool<{ reference: SourceReference }, TraceRecord | null> {
  return tool({
    description:
      'Read an original trace item by its source reference when compacted evidence is needed.',
    inputSchema: z.object({
      reference: z.object({
        trace_id: z.string(),
        span_id: z.string(),
        event_index: z.number().int().nonnegative().optional(),
      }),
    }),
    execute: async ({ reference }) => getSource(reference) ?? null,
  })
}
