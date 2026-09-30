import { evaluationAttributesSchema, nonemptyTextSchema, scopeSchema } from '../domain/schemas.ts'
import type { TraceDraft, TraceRecord } from '../domain/types.ts'
import { invalid } from '../domain/validation.ts'
import { type OtelAnyValue, otelTraceSchema } from './schemas.ts'

type RecordObject = Record<string, unknown>

function anyValue(value: OtelAnyValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.bytesValue !== undefined) return value.bytesValue
  if (value.boolValue !== undefined) return value.boolValue
  if (value.intValue !== undefined) {
    const integer = BigInt(value.intValue)
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(integer)
      : integer.toString()
  }
  if (value.doubleValue !== undefined) return value.doubleValue
  if (value.arrayValue !== undefined) return value.arrayValue.values.map(anyValue)
  const result: RecordObject = {}
  if (value.kvlistValue === undefined) invalid('OTLP AnyValue must contain one value')
  for (const entry of value.kvlistValue.values) {
    if (Object.hasOwn(result, entry.key)) invalid(`duplicate kvlistValue key ${entry.key}`)
    Object.defineProperty(result, entry.key, {
      value: anyValue(entry.value),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}

function attributes(
  value: Array<{ key: string; value: OtelAnyValue }> | undefined,
  name: string,
): RecordObject {
  const result: RecordObject = {}
  for (const entry of value ?? []) {
    if (Object.hasOwn(result, entry.key)) invalid(`${name} has duplicate attribute ${entry.key}`)
    Object.defineProperty(result, entry.key, {
      value: anyValue(entry.value),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}

function baseRecord(
  spanId: string,
  parentId: string | undefined,
  kind: string,
  timestamp: string,
  values: RecordObject,
  eventIndex?: number,
): TraceRecord {
  const scope = values['harness_rsi.scope']
  if (scope !== undefined && !scopeSchema.safeParse(scope).success) {
    invalid(`item ${spanId} has invalid scope`)
  }
  const { 'gen_ai.tool.call.result': content, ...metadata } = values
  return {
    span_id: spanId,
    ...(eventIndex === undefined ? {} : { event_index: eventIndex }),
    ...(parentId === undefined ? {} : { parent_id: parentId }),
    kind,
    time: timestamp,
    ...(content === undefined ? {} : { content }),
    attributes: metadata,
  }
}

function validateEvaluation(record: TraceRecord): void {
  const values = record.attributes ?? {}
  if (values['harness_rsi.scope'] !== undefined)
    invalid(`evaluation ${record.span_id} cannot have scope`)
  const parsed = evaluationAttributesSchema.safeParse(values)
  if (!parsed.success) invalid(`evaluation ${record.span_id}: ${parsed.error.message}`, 'shape')
}

export function parseOtelTrace(input: unknown): TraceDraft {
  const parsed = otelTraceSchema.safeParse(input)
  if (!parsed.success) invalid(`OTLP trace export: ${parsed.error.message}`, 'shape')

  const ordered: Array<{ record: TraceRecord; time: bigint; order: number }> = []
  const spanIds = new Set<string>()
  let traceId: string | undefined
  let harnessVersion: string | undefined
  let order = 0
  for (const resource of parsed.data.resourceSpans) {
    const resourceValues = attributes(resource.resource?.attributes, 'resource')
    if (resourceValues['harness_rsi.harness.version'] !== undefined) {
      const version = nonemptyTextSchema.safeParse(resourceValues['harness_rsi.harness.version'])
      if (!version.success) invalid(`harness version: ${version.error.message}`, 'shape')
      const declared = version.data
      if (harnessVersion !== undefined && declared !== harnessVersion) {
        invalid('trace has different harness versions')
      }
      harnessVersion = declared
    }
    for (const group of resource.scopeSpans) {
      for (const span of group.spans) {
        const spanTraceId = span.traceId.toLowerCase()
        if (traceId !== undefined && spanTraceId !== traceId)
          invalid('OTLP export contains multiple traceIds')
        traceId = spanTraceId
        const spanId = span.spanId.toLowerCase()
        if (spanIds.has(spanId)) invalid(`duplicate spanId ${spanId}`)
        spanIds.add(spanId)
        const parentId =
          span.parentSpanId === undefined || span.parentSpanId === ''
            ? undefined
            : span.parentSpanId.toLowerCase()
        const name = span.name
        const start = span.startTimeUnixNano
        const values = attributes(span.attributes, `span ${spanId}`)
        const spanRecord = baseRecord(spanId, parentId, name, start, values)
        if (name === 'gen_ai.evaluation.result') validateEvaluation(spanRecord)
        ordered.push({
          record: spanRecord,
          time: BigInt(start),
          order: order++,
        })
        const events = span.events ?? []
        for (let index = 0; index < events.length; index++) {
          const event = events[index]
          if (event === undefined) invalid(`span ${spanId} event must be an object`)
          const eventName = event.name
          const eventTime = event.timeUnixNano
          const record = baseRecord(
            spanId,
            spanId,
            eventName,
            eventTime,
            attributes(event.attributes, `event ${spanId}/${index}`),
            index,
          )
          if (eventName === 'gen_ai.evaluation.result') validateEvaluation(record)
          ordered.push({ record, time: BigInt(eventTime), order: order++ })
        }
      }
    }
  }
  if (traceId === undefined) invalid('OTLP trace export contains no spans')
  ordered.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.order - b.order))
  return {
    trace_id: traceId,
    ...(harnessVersion === undefined ? {} : { harness_version: harnessVersion }),
    records: ordered.map((item) => item.record),
  }
}
