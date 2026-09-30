import type { SourceLookup, SourceReference, TraceRecord, TraceSession } from './types.ts'

export function sourceKey(reference: SourceReference): string {
  return JSON.stringify([reference.trace_id, reference.span_id, reference.event_index ?? null])
}

export function createSourceIndex(traces: readonly TraceSession[]) {
  const sources = new Map<string, TraceRecord>()
  const inSources = new Set<string>()
  const evaluations: Array<{ reference: SourceReference; record: TraceRecord }> = []
  for (const trace of traces) {
    for (const item of trace.records) {
      const reference: SourceReference = {
        trace_id: trace.trace_id,
        span_id: item.span_id,
        ...(item.event_index === undefined ? {} : { event_index: item.event_index }),
      }
      const key = sourceKey(reference)
      sources.set(key, structuredClone(item))
      if (item.attributes?.['harness_rsi.scope'] === 'in') inSources.add(key)
      if (item.kind === 'gen_ai.evaluation.result') {
        const record = structuredClone(item)
        record.attributes ??= {}
        record.attributes['harness_rsi.evaluation.weight'] ??= 1
        evaluations.push({ reference, record })
      }
    }
  }
  const getSource: SourceLookup = (reference) => {
    const record = sources.get(sourceKey(reference))
    return record === undefined ? undefined : structuredClone(record)
  }
  return { sources, inSources, evaluations, getSource }
}
