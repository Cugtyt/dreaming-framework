import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDreamer, type DreamerSetup, type StageOverrides } from '../src/index.ts'
import { requireValue } from './helpers.ts'

const firstId = 'a'.repeat(32)
const secondId = 'b'.repeat(32)
const rootId = '1'.repeat(16)
const skillId = '2'.repeat(16)
const resultId = '3'.repeat(16)
const skillRef = { trace_id: firstId, span_id: skillId }
const resultRef = { trace_id: firstId, span_id: resultId }
const scoreRef = { trace_id: firstId, span_id: rootId, event_index: 0 }

function createWithStages(
  stages: StageOverrides & Pick<Required<StageOverrides>, 'proposeSpec' | 'evaluateSpec'>,
) {
  const dreamer = createDreamer({ stages })
  return {
    dream: (inputs: readonly unknown[], overrides?: StageOverrides) =>
      dreamer.dream(inputs, {
        workspaceDirectory: mkdtempSync(join(tmpdir(), 'dream-test-')),
        ...(overrides === undefined ? {} : { stages: overrides }),
      }),
  }
}

test('a model is required when a reasoning stage has no implementation', () => {
  const setup = {
    stages: {
      proposeSpec: () => ({ kind: 'no_proposal', reason: 'No candidate' }),
    },
  } as unknown as DreamerSetup
  assert.throws(() => createDreamer(setup), /model|evaluateSpec/)
})

test('invalid stage implementations fail at setup', () => {
  const setup = {
    stages: {
      proposeSpec: () => ({ kind: 'no_proposal', reason: 'No candidate' }),
      evaluateSpec: () => ({ kind: 'reject', reason: 'No candidate' }),
      projectSession: null,
    },
  } as unknown as DreamerSetup
  assert.throws(() => createDreamer(setup), /projectSession/)
})

function otelTrace(traceId = firstId, harnessVersion = 'review-harness@1') {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'harness_rsi.harness.version', value: { stringValue: harnessVersion } },
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
                    value: { stringValue: 'The spec was already available' },
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

const candidate = {
  issue: 'The review skill repeats a search',
  proposal: 'Skip the search when the spec is in context',
  predict: 'Search efficiency rises without reducing correctness',
  baseHarnessVersion: 'review-harness@1',
  references: [skillRef, resultRef, scoreRef],
}

test('accepts a cited spec from OTel input and keeps full source after projection', async () => {
  const trace = otelTrace()
  const firstResource = requireValue(trace.resourceSpans[0])
  const firstScope = requireValue(firstResource.scopeSpans[0])
  requireValue(firstScope.spans[0]).attributes.push({
    key: 'gen_ai.message.content',
    value: { stringValue: 'Original user request' },
  } as never)
  requireValue(firstScope.spans[1]).attributes.push({
    key: 'gen_ai.tool.call.arguments',
    value: { stringValue: 'Original tool arguments' },
  } as never)
  const original = structuredClone(trace)
  const dreamer = createWithStages({
    proposeSpec: ({ views }, { getSource }) => {
      const view = requireValue(views[0])
      const resultRecord = requireValue(view.records.find((item) => item.span_id === resultId))
      const skillRecord = requireValue(view.records.find((item) => item.span_id === skillId))
      assert.equal(resultRecord.content, '[compacted]')
      assert.equal(resultRecord.span_id, resultId)
      assert.equal(skillRecord.attributes?.['harness_rsi.scope'], 'in')
      assert.equal('harness_rsi.scope' in skillRecord, false)
      assert.equal(
        view.records.find((item) => item.span_id === rootId)?.attributes?.[
          'gen_ai.message.content'
        ],
        'Original user request',
      )
      assert.equal(
        view.records.find((item) => item.span_id === skillId)?.attributes?.[
          'gen_ai.tool.call.arguments'
        ],
        'Original tool arguments',
      )
      assert.equal(
        getSource({ trace_id: firstId, span_id: rootId })?.attributes?.['gen_ai.message.content'],
        'Original user request',
      )
      assert.equal(
        getSource(skillRef)?.attributes?.['gen_ai.tool.call.arguments'],
        'Original tool arguments',
      )
      return candidate
    },
    evaluateSpec: ({ evaluations }, { getSource }) => {
      assert.deepEqual(evaluations[0]?.reference, scoreRef)
      assert.equal(evaluations[0]?.record.attributes?.['harness_rsi.evaluation.weight'], 1)
      assert.equal(getSource(resultRef)?.content, 'The spec was already available')
      const copy = requireValue(getSource(resultRef))
      copy.content = 'changed locally'
      assert.equal(getSource(resultRef)?.content, 'The spec was already available')
      return { kind: 'accept', reason: 'The score and evidence support the change' }
    },
  })
  const result = await dreamer.dream([trace])
  assert.equal(result.kind, 'spec')
  if (result.kind === 'spec') assert.deepEqual(result.spec, candidate)
  assert.deepEqual(trace, original)
})

test('event index distinguishes events inside the same span', async () => {
  const trace = otelTrace()
  const firstResource = requireValue(trace.resourceSpans[0])
  const firstScope = requireValue(firstResource.scopeSpans[0])
  const rootSpan = requireValue(firstScope.spans[0])
  const events = requireValue(rootSpan.events)
  const second = structuredClone(requireValue(events[0]))
  second.timeUnixNano = '210'
  const evaluationName = requireValue(second.attributes[0])
  evaluationName.value.stringValue = 'task_correctness/v1'
  events.push(second)
  const secondRef = { trace_id: firstId, span_id: rootId, event_index: 1 }
  const result = await createWithStages({
    proposeSpec: (_, { getSource }) => {
      assert.equal(
        getSource(scoreRef)?.attributes?.['gen_ai.evaluation.name'],
        'search_efficiency/v1',
      )
      assert.equal(
        getSource(secondRef)?.attributes?.['gen_ai.evaluation.name'],
        'task_correctness/v1',
      )
      assert.equal(getSource({ trace_id: firstId, span_id: rootId })?.kind, 'invoke_agent')
      return { kind: 'no_proposal', reason: 'Lookup verified' }
    },
    evaluateSpec: () => {
      throw new Error('No proposal to evaluate')
    },
  }).dream([trace])
  assert.equal(result.kind, 'no_proposal')
})

test('one proposer receives all projected sessions in input order', async () => {
  let proposals = 0
  const dreamer = createWithStages({
    proposeSpec: ({ views }) => {
      proposals++
      assert.deepEqual(
        views.map((view) => view.trace_id),
        [firstId, secondId],
      )
      return candidate
    },
    evaluateSpec: ({ views, evaluations }) => {
      assert.deepEqual(
        views.map((view) => view.trace_id),
        [firstId, secondId],
      )
      assert.equal(evaluations.length, 2)
      return { kind: 'accept', reason: 'Supported across sessions' }
    },
  })
  const result = await dreamer.dream([otelTrace(), otelTrace(secondId)])
  assert.equal(result.kind, 'spec')
  assert.equal(proposals, 1)
})

test('rejects traces from different harness versions in one call', async () => {
  const dreamer = createWithStages({
    proposeSpec: () => candidate,
    evaluateSpec: () => ({ kind: 'accept', reason: 'Supported' }),
  })
  await assert.rejects(
    dreamer.dream([otelTrace(), otelTrace(secondId, 'review-harness@2')]),
    /different harness version/,
  )
})

test('a one-call enrichment fills a missing label and leaves later calls unchanged', async () => {
  const incomplete = otelTrace()
  const attributes = requireValue(
    requireValue(requireValue(incomplete.resourceSpans[0]).scopeSpans[0]).spans[2],
  ).attributes
  attributes.splice(0, 1)
  const dreamer = createWithStages({
    proposeSpec: () => ({ kind: 'no_proposal', reason: 'No candidate' }),
    evaluateSpec: () => {
      throw new Error('No candidate should be evaluated')
    },
  })
  await dreamer.dream([incomplete], {
    enrichTrace: () => ({ scopes: [{ reference: resultRef, scope: 'out' }] }),
  })
  await assert.rejects(dreamer.dream([incomplete]), /missing scope/)
})

test('enrichment cannot edit parsed source evidence', async () => {
  const dreamer = createWithStages({
    proposeSpec: () => ({ kind: 'no_proposal', reason: 'No candidate' }),
    evaluateSpec: () => ({ kind: 'reject', reason: 'No candidate' }),
  })
  await assert.rejects(
    dreamer.dream([otelTrace()], {
      enrichTrace: (trace) => {
        requireValue(trace.records[1]).kind = 'changed'
        return {}
      },
    }),
    /changed existing trace data/,
  )
})

test('enrichment can supply the harness version for one call', async () => {
  const incomplete = otelTrace()
  requireValue(incomplete.resourceSpans[0]).resource.attributes.length = 0
  const dreamer = createWithStages({
    proposeSpec: ({ views }) => {
      assert.equal(views[0]?.harness_version, 'review-harness@1')
      return { kind: 'no_proposal', reason: 'No candidate' }
    },
    evaluateSpec: () => {
      throw new Error('No candidate should be evaluated')
    },
  })
  await dreamer.dream([incomplete], {
    enrichTrace: () => ({ harnessVersion: 'review-harness@1' }),
  })
  await assert.rejects(dreamer.dream([incomplete]), /missing a harness version/)
})

test('enrichment inserts a standalone evaluation item for dreaming', async () => {
  const trace = otelTrace()
  requireValue(
    requireValue(requireValue(requireValue(trace.resourceSpans[0]).scopeSpans[0]).spans[0]).events,
  ).length = 0
  let evaluationRef: { trace_id: string; span_id: string } | undefined
  const dreamer = createWithStages({
    proposeSpec: ({ views }) => {
      const evaluation = views[0]?.records.at(-1)
      assert.equal(evaluation?.kind, 'gen_ai.evaluation.result')
      const evaluationRecord = requireValue(evaluation)
      assert.match(evaluationRecord.span_id, /^[0-9a-f]{16}$/)
      evaluationRef = { trace_id: firstId, span_id: evaluationRecord.span_id }
      return { ...candidate, references: [skillRef, evaluationRef] }
    },
    evaluateSpec: ({ evaluations }, { getSource }) => {
      assert.deepEqual(evaluations[0]?.reference, evaluationRef)
      assert.equal(evaluations[0]?.record.attributes?.['harness_rsi.evaluation.weight'], 1)
      const evaluationReference = requireValue(evaluationRef)
      assert.equal(getSource(evaluationReference)?.attributes?.['harness_rsi.evaluation.target'], 1)
      return { kind: 'accept', reason: 'The evaluation supports the change' }
    },
  })

  const result = await dreamer.dream([trace], {
    enrichTrace: () => ({
      evaluations: [{ name: 'search_efficiency/v1', value: 0.3, target: 1, time: '200' }],
    }),
  })
  assert.equal(result.kind, 'spec')
})

test('rejection feedback starts a fresh proposal pass but does not reproject', async () => {
  const feedbacks: Array<string | undefined> = []
  let projections = 0
  let evaluations = 0
  const result = await createWithStages({
    projectSession: (trace) => {
      projections++
      return trace
    },
    proposeSpec: ({ feedback, views }) => {
      feedbacks.push(feedback)
      assert.equal(views.length, 1)
      return candidate
    },
    evaluateSpec: () => {
      evaluations++
      return evaluations === 1
        ? { kind: 'reject', reason: 'Inspect the original tool result' }
        : { kind: 'accept', reason: 'Contrary evidence checked' }
    },
  }).dream([otelTrace()])
  assert.equal(result.kind, 'spec')
  assert.deepEqual(feedbacks, [undefined, 'Inspect the original tool result'])
  assert.equal(projections, 1)
})

test('stops when there is no target, no proposal, or the attempt limit is reached', async () => {
  const noScore = otelTrace()
  requireValue(
    requireValue(requireValue(requireValue(noScore.resourceSpans[0]).scopeSpans[0]).spans[0])
      .events,
  ).length = 0
  const stages = {
    proposeSpec: () => candidate,
    evaluateSpec: () => ({ kind: 'reject' as const, reason: 'Not supported yet' }),
  }
  const missingTarget = await createWithStages(stages).dream([noScore])
  assert.equal(missingTarget.kind, 'no_proposal')
  if (missingTarget.kind === 'no_proposal') assert.match(missingTarget.reason, /evaluation target/)

  const unsupported = await createWithStages({
    ...stages,
    proposeSpec: () => ({ kind: 'no_proposal', reason: 'No supported candidate' }),
  }).dream([otelTrace()])
  assert.deepEqual(unsupported, { kind: 'no_proposal', reason: 'No supported candidate' })

  let proposals = 0
  const exhausted = await createWithStages({
    ...stages,
    proposeSpec: () => {
      proposals++
      return candidate
    },
  }).dream([otelTrace()])
  assert.equal(proposals, 3)
  assert.equal(exhausted.kind, 'no_proposal')
  if (exhausted.kind === 'no_proposal') assert.match(exhausted.reason, /limit/)
})

test('rejects incomplete labels, invalid citations, and changed projections', async () => {
  const stages = {
    proposeSpec: () => candidate,
    evaluateSpec: () => ({ kind: 'accept' as const, reason: 'Supported' }),
  }
  const missingScope = otelTrace()
  requireValue(
    requireValue(requireValue(missingScope.resourceSpans[0]).scopeSpans[0]).spans[2],
  ).attributes.splice(0, 1)
  await assert.rejects(createWithStages(stages).dream([missingScope]), /missing scope/)
  await assert.rejects(
    createWithStages({
      ...stages,
      proposeSpec: () => ({
        ...candidate,
        references: [{ trace_id: firstId, span_id: '9'.repeat(16) }],
      }),
    }).dream([otelTrace()]),
    /unresolved reference/,
  )
  await assert.rejects(
    createWithStages({
      ...stages,
      proposeSpec: () => ({ ...candidate, references: [resultRef, scoreRef] }),
    }).dream([otelTrace()]),
    /in-scope source reference/,
  )
  await assert.rejects(
    createWithStages({
      ...stages,
      proposeSpec: () => ({ ...candidate, baseHarnessVersion: 'review-harness@2' }),
    }).dream([otelTrace()]),
    /base harness version/,
  )
  await assert.rejects(
    createWithStages(stages).dream([otelTrace()], {
      projectSession: (trace) => {
        const view = structuredClone(trace)
        requireValue(view.records[0]).span_id = 'changed'
        return view
      },
    }),
    /changed record identity/,
  )
  await assert.rejects(
    createWithStages(stages).dream([otelTrace()], {
      projectSession: (trace) => {
        const view = structuredClone(trace)
        const lastRecord = requireValue(view.records.at(-1))
        const attributes = requireValue(lastRecord.attributes)
        attributes['gen_ai.evaluation.score.value'] = 1
        return view
      },
    }),
    /changed record identity/,
  )
  await assert.rejects(
    createWithStages(stages).dream([otelTrace()], {
      projectSession: (trace) => ({ ...trace, harness_version: 'review-harness@2' }),
    }),
    /changed trace identity/,
  )
})
