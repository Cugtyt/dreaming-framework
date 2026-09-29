import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLanguageModelV3 } from 'ai/test'
import { createDreamer } from '../src/index.ts'
import { fileTools } from '../src/stages/file-tools.ts'

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
  trace.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.push({
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
  assert.match(requests[0]!, /score|target/i)
  assert.match(requests[0]!, /searchFiles/)
  assert.match(requests[0]!, /first page/)
  assert.match(requests[0]!, /causal link/)
  assert.match(requests[1]!, /unrelated error/)
  assert.doesNotMatch(requests[0]!, /Raw user request for searching|\[compacted\]/)
  assert.match(requests[0]!, /projections/)
  const firstUserMessage = model.doGenerateCalls[0]!.prompt.find(
    (message) => message.role === 'user',
  )
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
  assert.doesNotMatch(requests[2]!, /Check the out-of-scope result/)
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
  const listed = (await fileTools(directory).listFiles.execute!({}, {} as never)) as {
    files: string[]
  }
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
  assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /attempts\/1\/feedback.json/)
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
  assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /Review spec already available/)
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
  const secondPrompt = JSON.stringify(model.doGenerateCalls[1]!.prompt)
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
  assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /Repeated search/)
})
