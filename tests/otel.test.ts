import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOtelTrace } from '../src/otel.ts'
import { applyTraceAdditions } from '../src/stages/enrich-trace.ts'
import { validateTrace } from '../src/validation.ts'

const traceId = 'a'.repeat(32)
const rootId = '1'.repeat(16)
const skillId = '2'.repeat(16)
const resultId = '3'.repeat(16)

function otelTrace() {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'harness_rsi.harness.version', value: { stringValue: 'review-harness@1' } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: rootId,
                name: 'invoke_agent',
                startTimeUnixNano: '100',
                endTimeUnixNano: '300',
                attributes: [],
                events: [
                  {
                    name: 'gen_ai.evaluation.result',
                    timeUnixNano: '200',
                    attributes: [
                      {
                        key: 'gen_ai.evaluation.name',
                        value: { stringValue: 'search_efficiency/v1' },
                      },
                      { key: 'gen_ai.evaluation.score.value', value: { doubleValue: 0.3 } },
                      { key: 'harness_rsi.evaluation.target', value: { doubleValue: 1 } },
                    ],
                  },
                ],
              },
              {
                traceId,
                spanId: skillId,
                parentSpanId: rootId,
                name: 'skill.load',
                startTimeUnixNano: '120',
                endTimeUnixNano: '130',
                attributes: [{ key: 'harness_rsi.scope', value: { stringValue: 'in' } }],
              },
              {
                traceId,
                spanId: resultId,
                parentSpanId: rootId,
                name: 'tool.result',
                startTimeUnixNano: '140',
                endTimeUnixNano: '150',
                attributes: [
                  { key: 'harness_rsi.scope', value: { stringValue: 'out' } },
                  {
                    key: 'gen_ai.tool.call.result',
                    value: { stringValue: 'Spec already available' },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

test('parses OTLP JSON spans and score events into cited, ordered items', () => {
  const input = otelTrace()
  const session = parseOtelTrace(input)
  assert.equal(session.trace_id, traceId)
  assert.equal(session.harness_version, 'review-harness@1')
  assert.equal('scope_boundary' in session, false)
  assert.deepEqual(
    session.records.map((record) => record.span_id),
    [rootId, skillId, resultId, rootId],
  )
  assert.equal(session.records[2]?.content, 'Spec already available')
  assert.equal(session.records[1]?.attributes?.['harness_rsi.scope'], 'in')
  assert.equal('harness_rsi.scope' in session.records[1]!, false)
  assert.equal('subject' in session.records[1]!, false)
  assert.equal('harness_rsi.evaluation' in session.records[3]!, false)
  assert.deepEqual(session.records[3]?.attributes, {
    'gen_ai.evaluation.name': 'search_efficiency/v1',
    'gen_ai.evaluation.score.value': 0.3,
    'harness_rsi.evaluation.target': 1,
  })
  assert.equal(input.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.events![0]!.attributes.length, 3)
})

test('parses a dedicated evaluation span as its own unscoped item', () => {
  const input = otelTrace()
  const spans = input.resourceSpans[0]!.scopeSpans[0]!.spans
  spans[0]!.events!.length = 0
  const evaluationId = '4'.repeat(16)
  spans.push({
    traceId,
    spanId: evaluationId,
    parentSpanId: rootId,
    name: 'gen_ai.evaluation.result',
    startTimeUnixNano: '200',
    endTimeUnixNano: '200',
    attributes: [
      { key: 'gen_ai.evaluation.name', value: { stringValue: 'search_efficiency/v1' } },
      { key: 'gen_ai.evaluation.score.value', value: { doubleValue: 0.3 } },
      { key: 'harness_rsi.evaluation.target', value: { doubleValue: 1 } },
      { key: 'harness_rsi.evaluation.weight', value: { doubleValue: 2 } },
      { key: 'custom.metric.source', value: { stringValue: 'reviewer' } },
    ],
  } as never)

  const session = parseOtelTrace(input)
  assert.deepEqual(
    session.records.map((record) => record.span_id),
    [rootId, skillId, resultId, evaluationId],
  )
  assert.equal(session.records[3]?.parent_id, rootId)
  assert.equal(session.records[3]?.attributes?.['harness_rsi.scope'], undefined)
  assert.equal('harness_rsi.evaluation' in session.records[3]!, false)
  assert.deepEqual(session.records[3]?.attributes, {
    'gen_ai.evaluation.name': 'search_efficiency/v1',
    'gen_ai.evaluation.score.value': 0.3,
    'harness_rsi.evaluation.target': 1,
    'harness_rsi.evaluation.weight': 2,
    'custom.metric.source': 'reviewer',
  })
})

test('enrichment adds missing labels and multiple scores without changing source evidence', () => {
  const original = otelTrace()
  original.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.attributes.splice(0, 1)
  const unchanged = structuredClone(original)
  const parsed = parseOtelTrace(original)
  const enriched = applyTraceAdditions(parsed, {
    scopes: [{ reference: { trace_id: traceId, span_id: resultId }, scope: 'out' }],
    evaluations: [
      { name: 'task_correctness/v1', value: 1, target: 1, time: '220' },
      { name: 'user_feedback/v1', value: 0, target: 1, time: '230' },
    ],
  })
  assert.doesNotThrow(() => validateTrace(enriched))
  assert.deepEqual(original, unchanged)
  assert.equal(parsed.records.length, 4)
  assert.equal(enriched.records.length, 6)
  assert.equal(enriched.records[2]?.attributes?.['harness_rsi.scope'], 'out')
  const added = enriched.records.filter(
    (record) => record.kind === 'gen_ai.evaluation.result' && record.event_index === undefined,
  )
  assert.deepEqual(
    added.map((record) => record.attributes?.['gen_ai.evaluation.score.value']),
    [1, 0],
  )
  assert.equal(new Set(added.map((record) => record.span_id)).size, 2)
  assert.deepEqual(enriched.records[1], parsed.records[1])
  assert.throws(
    () =>
      applyTraceAdditions(parsed, {
        scopes: [{ reference: { trace_id: traceId, span_id: skillId }, scope: 'out' }],
      }),
    /cannot replace scope/,
  )
})

test('requires one harness version after enrichment and preserves any declared version', () => {
  const original = otelTrace()
  original.resourceSpans[0]!.resource.attributes.length = 0
  const parsed = parseOtelTrace(original)
  assert.equal(parsed.harness_version, undefined)
  assert.throws(() => validateTrace(parsed), /missing a harness version/)
  const enriched = applyTraceAdditions(parsed, { harnessVersion: 'review-harness@1' })
  assert.equal(validateTrace(enriched).harness_version, 'review-harness@1')
  assert.equal(original.resourceSpans[0]!.resource.attributes.length, 0)
  assert.throws(
    () => applyTraceAdditions(parseOtelTrace(otelTrace()), { harnessVersion: 'changed' }),
    /cannot replace harness version/,
  )

  const mixed = otelTrace()
  const secondResource = structuredClone(mixed.resourceSpans[0]!)
  secondResource.resource.attributes[0]!.value.stringValue = 'review-harness@2'
  secondResource.scopeSpans[0]!.spans.length = 0
  mixed.resourceSpans.push(secondResource)
  assert.throws(() => parseOtelTrace(mixed), /different harness versions/)
})

test('enrichment accepts only scoped additions and independent evaluation records', () => {
  const original = otelTrace()
  original.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.events!.length = 0
  const parsed = parseOtelTrace(original)
  const evaluation = { name: 'search_efficiency/v1', value: 0.3, target: 1, time: '200' }
  const enriched = applyTraceAdditions(parsed, { evaluations: [evaluation] })
  const added = enriched.records.at(-1)!
  assert.equal(added.kind, 'gen_ai.evaluation.result')
  assert.match(added.span_id, /^[0-9a-f]{16}$/)
  assert.equal(added.attributes?.['harness_rsi.scope'], undefined)
  assert.equal(added.attributes?.['gen_ai.evaluation.score.value'], 0.3)
  assert.deepEqual(applyTraceAdditions(parsed, { evaluations: [evaluation] }), enriched)
  assert.throws(
    () => applyTraceAdditions(parsed, { evaluations: [{ ...evaluation, value: 2 }] }),
    /between 0 and 1/,
  )
  assert.throws(
    () => applyTraceAdditions(parsed, { resourceSpans: [] }),
    /must return trace additions/,
  )
  assert.throws(
    () => applyTraceAdditions(parsed, { evaluations: [{ ...evaluation, time: 'bad' }] }),
    /timestamp/,
  )
})

test('rejects malformed OTLP trace identity and duplicate spans', () => {
  const malformed = otelTrace()
  malformed.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.traceId = 'run-1'
  assert.throws(() => parseOtelTrace(malformed), /traceId/)

  const duplicate = otelTrace()
  duplicate.resourceSpans[0]!.scopeSpans[0]!.spans[1]!.spanId = rootId
  assert.throws(() => parseOtelTrace(duplicate), /duplicate spanId/)

  const mixed = otelTrace()
  mixed.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.traceId = 'b'.repeat(32)
  assert.throws(() => parseOtelTrace(mixed), /multiple traceIds/)
})

test('preserves valid empty and large OTLP attribute values', () => {
  const input = otelTrace()
  const result = input.resourceSpans[0]!.scopeSpans[0]!.spans[2]!
  result.attributes[1]!.value.stringValue = ''
  result.attributes.push({
    key: 'large_count',
    value: { intValue: '9007199254740993' },
  } as never)
  const parsed = parseOtelTrace(input)
  assert.equal(parsed.records[2]?.content, '')
  assert.equal(parsed.records[2]?.attributes?.large_count, '9007199254740993')
})

test('keeps scope on an individual event beneath a mixed span', () => {
  const input = otelTrace()
  input.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.events!.push({
    name: 'prompt.apply',
    timeUnixNano: '125',
    attributes: [{ key: 'harness_rsi.scope', value: { stringValue: 'in' } }],
  } as never)
  const parsed = parseOtelTrace(input)
  const prompt = parsed.records.find((record) => record.kind === 'prompt.apply')
  assert.equal(prompt?.span_id, rootId)
  assert.equal(prompt?.event_index, 1)
  assert.equal(prompt?.parent_id, rootId)
  assert.equal(prompt?.attributes?.['harness_rsi.scope'], 'in')
  assert.equal('harness_rsi.scope' in prompt!, false)
  assert.equal('subject' in prompt!, false)
  assert.equal(parsed.records[0]?.attributes?.['harness_rsi.scope'], undefined)
})
