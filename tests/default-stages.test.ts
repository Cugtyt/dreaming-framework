import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLanguageModelV3 } from 'ai/test'
import { fileTools } from '../src/agent/tools/file-tools.ts'
import { ValidationError, validateCandidate } from '../src/domain/validation.ts'
import { createDreamer } from '../src/index.ts'
import { requireValue } from './helpers.ts'

const traceId = 'c'.repeat(32)
const rootId = '1'.repeat(16)
const skillId = '2'.repeat(16)
const resultId = '3'.repeat(16)
const skillRef = { trace_id: traceId, span_id: skillId }
const resultRef = { trace_id: traceId, span_id: resultId }
const scoreRef = { trace_id: traceId, span_id: rootId, event_index: 0 }
const workspaceDirectory = () => mkdtempSync(join(tmpdir(), 'dream-stages-'))

function modelTrace(directory: string, attempt: number, stage: 'proposer' | 'evaluator') {
  return readFileSync(join(directory, 'attempts', String(attempt), `${stage}-model.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

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
                    timeUnixNano: '250',
                    attributes: [
                      {
                        key: 'gen_ai.evaluation.name',
                        value: { stringValue: 'search_efficiency/v1' },
                      },
                      { key: 'gen_ai.evaluation.score.value', value: { doubleValue: 0.3 } },
                      { key: 'harness_rsi.evaluation.target', value: { doubleValue: 1 } },
                      { key: 'harness_rsi.evaluation.weight', value: { doubleValue: 2 } },
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
                    value: { stringValue: 'Review spec already available' },
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

function mockModel(outputs: unknown[]) {
  let next = 0
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: JSON.stringify(outputs[next++]) }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

test('one default proposer explores projections and receives evaluator feedback', async () => {
  const trace = otelTrace()
  requireValue(
    requireValue(requireValue(trace.resourceSpans[0]).scopeSpans[0]).spans[0],
  ).attributes.push({
    key: 'gen_ai.message.content',
    value: { stringValue: 'Raw user request for searching' },
  } as never)
  const candidate = {
    issue: 'Repeated search',
    proposal: 'Revise the review skill',
    predict: 'Search efficiency improves without reducing correctness',
    baseHarnessVersion: 'review-harness@1',
    references: [skillRef, resultRef, scoreRef],
  }
  const model = mockModel([
    { result: candidate },
    { kind: 'reject', reason: 'Check the out-of-scope result', references: [] },
    { result: candidate },
    { kind: 'accept', reason: 'Expected improvement is supported', references: [] },
  ])
  const directory = workspaceDirectory()
  const result = await createDreamer({ model }).dream([trace], { workspaceDirectory: directory })
  assert.equal(result.kind, 'spec')
  assert.equal(model.doGenerateCalls.length, 4)
  const requests = model.doGenerateCalls.map((call) => JSON.stringify(call.prompt))
  const firstRequest = requireValue(requests[0])
  const secondRequest = requireValue(requests[1])
  const thirdRequest = requireValue(requests[2])
  assert.match(firstRequest, /score|target/i)
  assert.match(firstRequest, /searchFiles/)
  assert.match(firstRequest, /follow nextOffset until null/)
  assert.match(firstRequest, /beginning to end/)
  assert.match(firstRequest, /partial page/)
  assert.match(firstRequest, /causal link/)
  assert.match(secondRequest, /unrelated error/)
  assert.doesNotMatch(firstRequest, /Raw user request for searching|\[compacted\]/)
  assert.match(firstRequest, /projections/)
  const firstPrompt = requireValue(model.doGenerateCalls[0]).prompt
  const firstUserMessage = firstPrompt.find((message) => message.role === 'user')
  assert.equal(firstUserMessage?.content[0]?.type, 'text')
  if (firstUserMessage?.content[0]?.type === 'text') {
    assert.equal(firstUserMessage.content[0].text, directory)
  }
  const projection = readFileSync(join(directory, 'projections', `${traceId}.txt`), 'utf8')
  assert.match(projection, /Raw user request for searching/)
  assert.match(
    projection,
    new RegExp(`<trace trace_id="${traceId}" harness_version="review-harness@1">`),
  )
  assert.match(projection, new RegExp(`<item span_id="${rootId}"`))
  assert.match(
    projection,
    /<evaluation .*name="search_efficiency\/v1" score="0.3" target="1" weight="2"\/>/,
  )
  assert.match(
    readFileSync(join(directory, 'attempts', '1', 'feedback.json'), 'utf8'),
    /Check the out-of-scope result/,
  )
  assert.doesNotMatch(thirdRequest, /Check the out-of-scope result/)
  for (const stage of ['proposer', 'evaluator'] as const) {
    const events = modelTrace(directory, 1, stage)
    assert.equal(events[0]?.event, 'model_call_start')
    assert.match(String(events[0]?.instructions), /projections/)
    assert.match(JSON.stringify(events[0]?.messages), /dream-stages-/)
    assert.match(JSON.stringify(events[0]?.tools), /readFile/)
    assert.ok(events.some((event) => event.event === 'model_call_end'))
    assert.ok(events.some((event) => event.event === 'result'))
  }
  assert.equal(modelTrace(directory, 2, 'proposer').at(-1)?.event, 'result')
  assert.equal(modelTrace(directory, 2, 'evaluator').at(-1)?.event, 'result')
  const listFiles = requireValue(fileTools(directory).listFiles.execute)
  const listed = await listFiles({}, { toolCallId: 'test', messages: [], context: undefined })
  assert.ok('files' in listed)
  assert.equal(
    listed.files.some((path) => path.endsWith('.jsonl')),
    false,
  )
})

test('default proposer retries an invalid citation without running the evaluator', async () => {
  const candidate = {
    issue: 'Repeated search',
    proposal: 'Change the skill',
    predict: 'Score improves',
    baseHarnessVersion: 'review-harness@1',
    references: [{ ...skillRef, event_index: 19 }],
  }
  const model = mockModel([
    { result: candidate },
    { result: { ...candidate, references: [skillRef, scoreRef] } },
    { kind: 'accept', reason: 'Supported', references: [] },
  ])
  const directory = workspaceDirectory()
  const result = await createDreamer({ model }).dream([otelTrace()], {
    workspaceDirectory: directory,
  })
  assert.equal(result.kind, 'spec')
  assert.equal(model.doGenerateCalls.length, 3)
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, 'attempts', '1', 'proposal.json'), 'utf8')),
    candidate,
  )
  assert.match(
    readFileSync(join(directory, 'attempts', '1', 'feedback.json'), 'utf8'),
    /unresolved reference/,
  )
  assert.equal(existsSync(join(directory, 'attempts', '1', 'evaluation.json')), false)
  assert.equal(existsSync(join(directory, 'attempts', '1', 'evaluator-model.jsonl')), false)
  assert.match(
    JSON.stringify(requireValue(model.doGenerateCalls[1]).prompt),
    /attempts\/1\/feedback.json/,
  )
  assert.equal(modelTrace(directory, 2, 'evaluator').at(-1)?.event, 'result')
})

test('invalid default citations stop at the attempt limit with feedback in each round', async () => {
  const candidate = {
    issue: 'Uncited issue',
    proposal: 'Change the skill',
    predict: 'Score improves',
    baseHarnessVersion: 'review-harness@1',
    references: [],
  }
  const directory = workspaceDirectory()
  const result = await createDreamer({
    model: mockModel([{ result: candidate }, { result: candidate }]),
    maxProposalAttempts: 2,
  }).dream([otelTrace()], { workspaceDirectory: directory })
  assert.equal(result.kind, 'no_proposal')
  assert.match(result.reason, /candidate needs source references/)
  for (const attempt of [1, 2]) {
    assert.equal(existsSync(join(directory, 'attempts', String(attempt), 'proposal.json')), true)
    assert.equal(existsSync(join(directory, 'attempts', String(attempt), 'feedback.json')), true)
    assert.equal(existsSync(join(directory, 'attempts', String(attempt), 'evaluation.json')), false)
  }
})

test('default no-proposal reference errors retry with saved feedback and skip evaluation', async () => {
  const invalid = {
    kind: 'no_proposal',
    reason: 'No bounded change is supported',
    references: [{ ...scoreRef, event_index: 19 }],
  }
  const valid = { ...invalid, references: [scoreRef] }
  const model = mockModel([{ result: invalid }, { result: valid }])
  const directory = workspaceDirectory()
  const result = await createDreamer({ model }).dream([otelTrace()], {
    workspaceDirectory: directory,
  })
  assert.deepEqual(result, valid)
  assert.equal(model.doGenerateCalls.length, 2)
  assert.deepEqual(
    JSON.parse(readFileSync(join(directory, 'attempts', '1', 'proposal.json'), 'utf8')),
    invalid,
  )
  assert.match(
    readFileSync(join(directory, 'attempts', '1', 'feedback.json'), 'utf8'),
    /unresolved reference/,
  )
  assert.match(
    JSON.stringify(requireValue(model.doGenerateCalls[1]).prompt),
    /attempts\/1\/feedback.json/,
  )
  for (const attempt of [1, 2]) {
    assert.equal(existsSync(join(directory, 'attempts', String(attempt), 'evaluation.json')), false)
    assert.equal(
      existsSync(join(directory, 'attempts', String(attempt), 'evaluator-model.jsonl')),
      false,
    )
    assert.equal(modelTrace(directory, attempt, 'proposer').at(-1)?.event, 'result')
  }
})

test('default no-proposal reference errors stop at the attempt limit', async () => {
  const invalid = {
    kind: 'no_proposal',
    reason: 'No bounded change is supported',
    references: [{ ...scoreRef, event_index: 19 }],
  }
  const model = mockModel([{ result: invalid }, { result: invalid }])
  const directory = workspaceDirectory()
  const result = await createDreamer({ model, maxProposalAttempts: 2 }).dream([otelTrace()], {
    workspaceDirectory: directory,
  })
  assert.equal(result.kind, 'no_proposal')
  assert.match(result.reason, /Proposal attempt limit reached:.*unresolved reference/)
  assert.equal(model.doGenerateCalls.length, 2)
  for (const attempt of [1, 2]) {
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(directory, 'attempts', String(attempt), 'proposal.json'), 'utf8'),
      ),
      invalid,
    )
    assert.match(
      readFileSync(join(directory, 'attempts', String(attempt), 'feedback.json'), 'utf8'),
      /unresolved reference/,
    )
    assert.equal(existsSync(join(directory, 'attempts', String(attempt), 'evaluation.json')), false)
    assert.equal(
      existsSync(join(directory, 'attempts', String(attempt), 'evaluator-model.jsonl')),
      false,
    )
  }
})

test('custom no-proposal reference errors fail immediately', async () => {
  let calls = 0
  const directory = workspaceDirectory()
  await assert.rejects(
    createDreamer({
      stages: {
        proposeSpec: () => {
          calls++
          return {
            kind: 'no_proposal',
            reason: 'Unsupported',
            references: [{ ...scoreRef, event_index: 19 }],
          }
        },
        evaluateSpec: () => {
          throw new Error('No proposal to evaluate')
        },
      },
    }).dream([otelTrace()], { workspaceDirectory: directory }),
    (error: unknown) => error instanceof ValidationError && error.category === 'reference',
  )
  assert.equal(calls, 1)
  for (const name of [
    'proposal.json',
    'feedback.json',
    'evaluation.json',
    'evaluator-model.jsonl',
  ]) {
    assert.equal(existsSync(join(directory, 'attempts', '1', name)), false)
  }
})

test('malformed default no-proposal output fails without retrying', async () => {
  const model = mockModel([
    { result: { kind: 'no_proposal', reason: '', references: [scoreRef] } },
    { result: { kind: 'no_proposal', reason: 'Supported', references: [scoreRef] } },
  ])
  const directory = workspaceDirectory()
  await assert.rejects(
    createDreamer({ model }).dream([otelTrace()], { workspaceDirectory: directory }),
  )
  assert.equal(model.doGenerateCalls.length, 1)
  assert.equal(modelTrace(directory, 1, 'proposer').at(-1)?.event, 'error')
  for (const name of [
    'proposal.json',
    'feedback.json',
    'evaluation.json',
    'evaluator-model.jsonl',
  ]) {
    assert.equal(existsSync(join(directory, 'attempts', '1', name)), false)
  }
})

test('default proposer may return no proposal through structured output', async () => {
  const model = mockModel([
    {
      result: {
        kind: 'no_proposal',
        reason: 'No bounded change is supported',
        references: [scoreRef],
      },
    },
  ])
  const result = await createDreamer({ model }).dream([otelTrace()], {
    workspaceDirectory: workspaceDirectory(),
  })
  assert.deepEqual(result, {
    kind: 'no_proposal',
    reason: 'No bounded change is supported',
    references: [scoreRef],
  })
})

test('default proposer can inspect compacted source through getSource', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls++
      return {
        content:
          calls === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'source-1',
                  toolName: 'getSource',
                  input: JSON.stringify({ reference: resultRef }),
                },
              ]
            : [
                {
                  type: 'text',
                  text: JSON.stringify({
                    result: {
                      kind: 'no_proposal',
                      reason: 'No supported change',
                      references: [resultRef],
                    },
                  }),
                },
              ],
        finishReason: { unified: calls === 1 ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  const result = await createDreamer({ model }).dream([otelTrace()], {
    workspaceDirectory: workspaceDirectory(),
  })
  assert.equal(result.kind, 'no_proposal')
  assert.match(
    JSON.stringify(requireValue(model.doGenerateCalls[1]).prompt),
    /Review spec already available/,
  )
})

test('default proposer reads projection files through the model file tool', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls++
      return {
        content:
          calls === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'file-1',
                  toolName: 'readFile',
                  input: JSON.stringify({ path: `projections/${traceId}.txt` }),
                },
              ]
            : [
                {
                  type: 'text',
                  text: JSON.stringify({
                    result: {
                      kind: 'no_proposal',
                      reason: 'No supported change',
                      references: [skillRef],
                    },
                  }),
                },
              ],
        finishReason: { unified: calls === 1 ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  const directory = workspaceDirectory()
  const result = await createDreamer({ model }).dream([otelTrace()], {
    workspaceDirectory: directory,
  })
  assert.equal(result.kind, 'no_proposal')
  const secondPrompt = JSON.stringify(requireValue(model.doGenerateCalls[1]).prompt)
  assert.match(secondPrompt, /\[compacted\]/)
  assert.match(secondPrompt, /scope=/)
  const events = modelTrace(directory, 1, 'proposer')
  assert.ok(
    events.some(
      (event) => event.event === 'tool_result' && JSON.stringify(event).includes('scope='),
    ),
  )
})

test('failed default agent keeps its model trace', async () => {
  const directory = workspaceDirectory()
  const model = mockModel([{ invalid: true }])
  await assert.rejects(
    createDreamer({ model }).dream([otelTrace()], { workspaceDirectory: directory }),
  )
  assert.equal(modelTrace(directory, 1, 'proposer').at(-1)?.event, 'error')
})

test('default evaluator reads the candidate written by a custom proposer', async () => {
  let calls = 0
  const candidate = {
    issue: 'Repeated search',
    proposal: 'Revise the review skill',
    predict: 'Search efficiency improves',
    baseHarnessVersion: 'review-harness@1',
    references: [skillRef, scoreRef],
  }
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls++
      return {
        content:
          calls === 1
            ? [
                {
                  type: 'tool-call',
                  toolCallId: 'candidate-1',
                  toolName: 'readFile',
                  input: JSON.stringify({ path: 'attempts/1/proposal.json' }),
                },
              ]
            : [
                {
                  type: 'text',
                  text: JSON.stringify({
                    kind: 'accept',
                    reason: 'Supported',
                    references: [skillRef],
                  }),
                },
              ],
        finishReason: { unified: calls === 1 ? 'tool-calls' : 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  const result = await createDreamer({ model, stages: { proposeSpec: () => candidate } }).dream(
    [otelTrace()],
    { workspaceDirectory: workspaceDirectory() },
  )
  assert.equal(result.kind, 'spec')
  assert.match(JSON.stringify(requireValue(model.doGenerateCalls[1]).prompt), /Repeated search/)
})

for (const stage of ['proposer', 'evaluator'] as const) {
  test(`default ${stage} continues after compaction with its original output schema`, async () => {
    const directory = workspaceDirectory()
    const candidate = {
      issue: 'Repeated search',
      proposal: 'Revise the review skill',
      predict: 'Search efficiency improves',
      baseHarnessVersion: 'review-harness@1',
      references: [skillRef, scoreRef],
    }
    let normalCalls = 0
    let summaries = 0
    const model = new MockLanguageModelV3({
      doGenerate: async (call) => {
        const isSummary =
          call.responseFormat?.type === 'json' && call.responseFormat.name === 'ContextSummary'
        if (isSummary) summaries++
        else normalCalls++
        const useTool = !isSummary && normalCalls <= 2
        return {
          content: useTool
            ? [
                {
                  type: 'tool-call',
                  toolCallId: `read-${normalCalls}`,
                  toolName: 'readFile',
                  input: JSON.stringify({ path: `projections/${traceId}.txt` }),
                },
              ]
            : [
                {
                  type: 'text',
                  text: JSON.stringify(
                    isSummary
                      ? {
                          fullyReadFiles: [],
                          inProgress: [
                            {
                              path: `projections/${traceId}.txt`,
                              readThroughLine: 1,
                              remainingWork: 'Verify sources',
                            },
                          ],
                          findings: [
                            { conclusion: 'Preserve successful searches', references: [skillRef] },
                          ],
                          currentSpec: stage === 'evaluator' ? candidate : null,
                          rejectedIdeas: ['An unrelated error does not establish a cause'],
                          nextSteps: ['Complete verification'],
                        }
                      : stage === 'proposer'
                        ? { result: candidate }
                        : { kind: 'accept', reason: 'Supported', references: [skillRef] },
                  ),
                },
              ],
          finishReason: { unified: useTool ? 'tool-calls' : 'stop', raw: undefined },
          usage: {
            inputTokens: {
              total: normalCalls === 1 ? 1 : 20_000,
              noCache: normalCalls === 1 ? 1 : 20_000,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }
      },
    })
    const result = await createDreamer({
      model,
      contextWindowTokens: 30_000,
      stages:
        stage === 'proposer'
          ? { evaluateSpec: () => ({ kind: 'accept', reason: 'Supported' }) }
          : { proposeSpec: () => candidate },
    }).dream([otelTrace()], { workspaceDirectory: directory })
    assert.equal(result.kind, 'spec')
    assert.equal(summaries, 1)
    assert.equal(normalCalls, 3)
    const finalPrompt = JSON.stringify(model.doGenerateCalls.at(-1)?.prompt)
    assert.match(finalPrompt, /Prior progress/)
    assert.match(finalPrompt, /read-2/)
    assert.doesNotMatch(finalPrompt, /read-1/)
    assert.match(
      finalPrompt,
      stage === 'proposer' ? /Explore all projected sessions/ : /Evaluate the candidate/,
    )
    const events = modelTrace(directory, 1, stage)
    assert.equal(events.filter((event) => event.event === 'context_compaction').length, 1)
    assert.equal(events.at(-1)?.event, 'result')
    const summaryRequest = requireValue(
      model.doGenerateCalls.find(
        (call) =>
          call.responseFormat?.type === 'json' && call.responseFormat.name === 'ContextSummary',
      ),
    )
    assert.match(JSON.stringify(summaryRequest.prompt), /read-1/)
    assert.doesNotMatch(JSON.stringify(summaryRequest.prompt), /read-2/)
  })
}

test('citation retry errors have stable categories independent of message matching', () => {
  const candidate = {
    issue: 'issue',
    proposal: 'proposal',
    predict: 'predict',
    baseHarnessVersion: 'h@1',
    references: [],
  }
  for (const references of [
    [],
    [{ trace_id: 'trace', span_id: 'missing' }],
    [{ trace_id: 'trace', span_id: 'missing', extra: true }],
  ]) {
    assert.throws(
      () => validateCandidate({ ...candidate, references }, new Map(), new Set(), 'h@1'),
      (error: unknown) => error instanceof ValidationError && error.category === 'reference',
    )
  }
  assert.throws(
    () => validateCandidate({ ...candidate, issue: '' }, new Map(), new Set(), 'h@1'),
    (error: unknown) => error instanceof ValidationError && error.category === 'shape',
  )
  assert.throws(
    () =>
      validateCandidate({ ...candidate, baseHarnessVersion: 'h@2' }, new Map(), new Set(), 'h@1'),
    (error: unknown) => error instanceof ValidationError && error.category === 'invariant',
  )
})
