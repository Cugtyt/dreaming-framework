import { createHash } from 'node:crypto'
import type { StageImplementations } from '../contracts.ts'
import { sourceKey } from '../domain/sources.ts'
import type { TraceDraft, TraceRecord } from '../domain/types.ts'
import { invalid, object, text } from '../domain/validation.ts'

export const defaultEnrichTrace: StageImplementations['enrichTrace'] = () => ({})

function score(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${name} must be between 0 and 1`)
  }
}

export function applyTraceAdditions(draft: TraceDraft, additions: unknown): TraceDraft {
  if (
    !object(additions) ||
    Object.keys(additions).some((key) => !['harnessVersion', 'scopes', 'evaluations'].includes(key))
  ) {
    invalid('enrichTrace must return trace additions')
  }
  const enriched = structuredClone(draft)
  if (additions.harnessVersion !== undefined) {
    text(additions.harnessVersion, 'harness version addition')
    if (enriched.harness_version !== undefined) invalid('enrichment cannot replace harness version')
    enriched.harness_version = additions.harnessVersion
  }
  if (additions.scopes !== undefined) {
    if (!Array.isArray(additions.scopes)) invalid('scope additions must be an array')
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
    for (const entry of additions.scopes) {
      if (!object(entry) || !object(entry.reference)) invalid('scope addition needs a reference')
      const reference = entry.reference
      if (
        reference.trace_id !== enriched.trace_id ||
        typeof reference.span_id !== 'string' ||
        (reference.event_index !== undefined &&
          (!Number.isInteger(reference.event_index) || (reference.event_index as number) < 0))
      ) {
        invalid('scope addition has an invalid source reference')
      }
      const record = records.get(
        sourceKey({
          trace_id: enriched.trace_id,
          span_id: reference.span_id,
          event_index: reference.event_index as number | undefined,
        }),
      )
      if (!record) invalid('scope addition has an unresolved source reference')
      if (record.kind === 'gen_ai.evaluation.result') invalid('evaluation cannot have scope')
      if (record.attributes?.['harness_rsi.scope'] !== undefined)
        invalid('enrichment cannot replace scope')
      if (entry.scope !== 'in' && entry.scope !== 'out') invalid('scope must be in or out')
      record.attributes ??= {}
      record.attributes['harness_rsi.scope'] = entry.scope
    }
  }
  if (additions.evaluations !== undefined) {
    if (!Array.isArray(additions.evaluations)) invalid('evaluation additions must be an array')
    const spanIds = new Set(enriched.records.map((record) => record.span_id))
    for (const [index, entry] of additions.evaluations.entries()) {
      if (!object(entry)) invalid('evaluation addition must be an object')
      text(entry.name, 'evaluation name')
      score(entry.value, 'evaluation value')
      score(entry.target, 'evaluation target')
      if (
        entry.weight !== undefined &&
        (typeof entry.weight !== 'number' || !Number.isFinite(entry.weight) || entry.weight <= 0)
      ) {
        invalid('evaluation weight must be positive')
      }
      if (typeof entry.time !== 'string' || !/^\d+$/.test(entry.time)) {
        invalid('evaluation time must be an OTLP nanosecond timestamp')
      }
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
