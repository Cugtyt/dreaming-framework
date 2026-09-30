import { createHash } from 'node:crypto'
import type { StageImplementations } from '../contracts.ts'
import { traceAdditionsSchema } from '../domain/schemas.ts'
import { sourceKey } from '../domain/sources.ts'
import type { TraceDraft, TraceRecord } from '../domain/types.ts'
import { invalid } from '../domain/validation.ts'

export const defaultEnrichTrace: StageImplementations['enrichTrace'] = () => ({})

export function applyTraceAdditions(draft: TraceDraft, additions: unknown): TraceDraft {
  const parsed = traceAdditionsSchema.safeParse(additions)
  if (!parsed.success)
    invalid(`enrichTrace must return trace additions: ${parsed.error.message}`, 'shape')
  const data = parsed.data
  const enriched = structuredClone(draft)
  if (data.harnessVersion !== undefined) {
    if (enriched.harness_version !== undefined) invalid('enrichment cannot replace harness version')
    enriched.harness_version = data.harnessVersion
  }
  if (data.scopes !== undefined) {
    const records = new Map(
      enriched.records.map((record) => [
        sourceKey({
          trace_id: enriched.trace_id,
          span_id: record.span_id,
          event_index: record.event_index,
        }),
        record,
      ]),
    )
    for (const entry of data.scopes) {
      const reference = entry.reference
      if (reference.trace_id !== enriched.trace_id)
        invalid('scope addition has an invalid source reference')
      const record = records.get(sourceKey(reference))
      if (!record) invalid('scope addition has an unresolved source reference')
      if (record.kind === 'gen_ai.evaluation.result') invalid('evaluation cannot have scope')
      if (record.attributes?.['harness_rsi.scope'] !== undefined)
        invalid('enrichment cannot replace scope')
      record.attributes ??= {}
      record.attributes['harness_rsi.scope'] = entry.scope
    }
  }
  if (data.evaluations !== undefined) {
    const spanIds = new Set(enriched.records.map((record) => record.span_id))
    for (const [index, entry] of data.evaluations.entries()) {
      let collision = 0
      let spanId: string
      do {
        spanId = createHash('sha256')
          .update(`${enriched.trace_id}:${entry.name}:${entry.time}:${index}:${collision++}`)
          .digest('hex')
          .slice(0, 16)
      } while (spanIds.has(spanId) || /^0+$/.test(spanId))
      spanIds.add(spanId)
      const attributes: Record<string, unknown> = {
        'gen_ai.evaluation.name': entry.name,
        'gen_ai.evaluation.score.value': entry.value,
        'harness_rsi.evaluation.target': entry.target,
      }
      if (entry.weight !== undefined) attributes['harness_rsi.evaluation.weight'] = entry.weight
      const evaluation: TraceRecord = {
        span_id: spanId,
        kind: 'gen_ai.evaluation.result',
        time: entry.time,
        attributes,
      }
      enriched.records.push(evaluation)
    }
    enriched.records.sort((a, b) => {
      const left = BigInt(a.time ?? '0')
      const right = BigInt(b.time ?? '0')
      return left < right ? -1 : left > right ? 1 : 0
    })
  }
  return enriched
}
