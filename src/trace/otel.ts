import type { TraceDraft, TraceRecord } from '../domain/types.ts'
import { invalid, object } from '../domain/validation.ts'

type RecordObject = Record<string, unknown>

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) invalid(`${name} must be an array`)
  return value
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} must be a nonempty string`)
  return value
}

function identifier(value: unknown, name: string, length: number): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value) ||
    /^0+$/.test(value)
  )
    invalid(`${name} must be a nonzero ${length}-digit hexadecimal ID`)
  return value.toLowerCase()
}

function time(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    invalid(`${name} must be an OTLP nanosecond timestamp`)
  }
  return value
}

function anyValue(value: unknown): unknown {
  if (!object(value)) invalid('OTLP attribute value must be an AnyValue object')
  const present = [
    'stringValue',
    'boolValue',
    'intValue',
    'doubleValue',
    'bytesValue',
    'arrayValue',
    'kvlistValue',
  ].filter((key) => key in value)
  if (present.length !== 1) invalid('OTLP AnyValue must contain one value')
  const key = present[0]
  if (key === undefined) invalid('OTLP AnyValue must contain one value')
  const raw = value[key]
  if (key === 'stringValue' || key === 'bytesValue') {
    if (typeof raw !== 'string') invalid(`${key} must be a string`)
    return raw
  }
  if (key === 'boolValue') {
    if (typeof raw !== 'boolean') invalid('boolValue must be boolean')
    return raw
  }
  if (key === 'intValue') {
    if (
      (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) &&
      (typeof raw !== 'number' || !Number.isSafeInteger(raw))
    )
      invalid('intValue must be an integer')
    const integer = BigInt(raw as string | number)
    return integer <= BigInt(Number.MAX_SAFE_INTEGER) && integer >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(integer)
      : integer.toString()
  }
  if (key === 'doubleValue') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) invalid('doubleValue must be finite')
    return raw
  }
  if (!object(raw)) invalid(`${key} must be an object`)
  if (key === 'arrayValue') return array(raw.values, 'arrayValue.values').map(anyValue)
  const result: RecordObject = {}
  for (const entry of array(raw.values, 'kvlistValue.values')) {
    if (!object(entry)) invalid('kvlistValue entry must be an object')
    const entryKey = string(entry.key, 'kvlistValue key')
    if (entryKey in result) invalid(`duplicate kvlistValue key ${entryKey}`)
    result[entryKey] = anyValue(entry.value)
  }
  return result
}

function attributes(value: unknown, name: string): RecordObject {
  const result: RecordObject = {}
  for (const entry of array(value ?? [], `${name} attributes`)) {
    if (!object(entry)) invalid(`${name} attribute must be an object`)
    const key = string(entry.key, `${name} attribute key`)
    if (key in result) invalid(`${name} has duplicate attribute ${key}`)
    result[key] = anyValue(entry.value)
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
  if (scope !== undefined && scope !== 'in' && scope !== 'out') {
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
  string(values['gen_ai.evaluation.name'], `evaluation ${record.span_id} name`)
  const value = values['gen_ai.evaluation.score.value']
  const target = values['harness_rsi.evaluation.target']
  const weight = values['harness_rsi.evaluation.weight']
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`evaluation ${record.span_id} value must be between 0 and 1`)
  }
  if (typeof target !== 'number' || !Number.isFinite(target) || target < 0 || target > 1) {
    invalid(`evaluation ${record.span_id} target must be between 0 and 1`)
  }
  if (
    weight !== undefined &&
    (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)
  ) {
    invalid(`evaluation ${record.span_id} weight must be positive`)
  }
}

export function parseOtelTrace(input: unknown): TraceDraft {
  if (!object(input)) invalid('OTLP trace export must be an object')
  const ordered: Array<{ record: TraceRecord; time: bigint; order: number }> = []
  const spanIds = new Set<string>()
  let traceId: string | undefined
  let harnessVersion: string | undefined
  let order = 0
  for (const resource of array(input.resourceSpans, 'resourceSpans')) {
    if (!object(resource)) invalid('resourceSpans item must be an object')
    if (resource.resource !== undefined && !object(resource.resource))
      invalid('resource must be an object')
    const resourceValues = attributes(resource.resource?.attributes, 'resource')
    if (resourceValues['harness_rsi.harness.version'] !== undefined) {
      const declared = string(resourceValues['harness_rsi.harness.version'], 'harness version')
      if (harnessVersion !== undefined && declared !== harnessVersion) {
        invalid('trace has different harness versions')
      }
      harnessVersion = declared
    }
    for (const group of array(resource.scopeSpans, 'scopeSpans')) {
      if (!object(group)) invalid('scopeSpans item must be an object')
      for (const span of array(group.spans, 'spans')) {
        if (!object(span)) invalid('span must be an object')
        const spanTraceId = identifier(span.traceId, 'traceId', 32)
        if (traceId !== undefined && spanTraceId !== traceId)
          invalid('OTLP export contains multiple traceIds')
        traceId = spanTraceId
        const spanId = identifier(span.spanId, 'spanId', 16)
        if (spanIds.has(spanId)) invalid(`duplicate spanId ${spanId}`)
        spanIds.add(spanId)
        const parentId =
          span.parentSpanId === undefined || span.parentSpanId === ''
            ? undefined
            : identifier(span.parentSpanId, 'parentSpanId', 16)
        const name = string(span.name, `span ${spanId} name`)
        const start = time(span.startTimeUnixNano, `span ${spanId} startTimeUnixNano`)
        time(span.endTimeUnixNano, `span ${spanId} endTimeUnixNano`)
        const values = attributes(span.attributes, `span ${spanId}`)
        const spanRecord = baseRecord(spanId, parentId, name, start, values)
        if (name === 'gen_ai.evaluation.result') validateEvaluation(spanRecord)
        ordered.push({
          record: spanRecord,
          time: BigInt(start),
          order: order++,
        })
        const events = array(span.events ?? [], `span ${spanId} events`)
        for (let index = 0; index < events.length; index++) {
          const event = events[index]
          if (!object(event)) invalid(`span ${spanId} event must be an object`)
          const eventName = string(event.name, `span ${spanId} event name`)
          const eventTime = time(event.timeUnixNano, `span ${spanId} event timeUnixNano`)
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
