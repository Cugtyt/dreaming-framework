import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { type ModelMessage, Output, stepCountIs, ToolLoopAgent, tool } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import { createContextManagement, estimateContextTokens } from '../src/agent/context-management.ts'
import { createModelTrace } from '../src/agent/model-trace.ts'
import { createDreamer } from '../src/index.ts'
import { requireValue } from './helpers.ts'

const summary = {
  fullyReadFiles: ['old.txt'],
  inProgress: [
    { path: 'recent.txt', readThroughLine: 20, remainingWork: 'Inspect contrary evidence' },
  ],
  findings: [{ conclusion: 'Preserve the contrary evidence', references: [] }],
  currentSpec: null,
  rejectedIdeas: ['Do not infer causes from a score alone'],
  nextSteps: ['Verify original sources'],
}

const usage = (inputTokens: number | undefined) => ({
  inputTokens: {
    total: inputTokens,
    noCache: inputTokens,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
})

type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>

function response(
  content: MockGenerateResult['content'],
  inputTokens: number | undefined,
  toolCalls = false,
): MockGenerateResult {
  return {
    content,
    finishReason: { unified: toolCalls ? 'tool-calls' : 'stop', raw: undefined },
    usage: usage(inputTokens),
    warnings: [],
  }
}

async function run(options: {
  rounds?: number
  inputTokens?: number
  failSummary?: boolean
  invalidSummary?: boolean
  payload?: string
  window?: number
  firstInputTokens?: number
}) {
  let normalCalls = 0
  let summaryCalls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async (call) => {
      const isSummary =
        call.responseFormat?.type === 'json' && call.responseFormat.name === 'ContextSummary'
      if (isSummary) {
        summaryCalls++
        assert.equal(call.tools?.length ?? 0, 0)
        assert.equal(call.maxOutputTokens, 4_000)
        if (options.failSummary) throw new Error('summary unavailable')
        return response(
          [{ type: 'text', text: JSON.stringify(options.invalidSummary ? {} : summary) }],
          999_999,
        )
      }
      normalCalls++
      if (normalCalls > (options.rounds ?? 2)) {
        return response([{ type: 'text', text: '{"done":true}' }], 1)
      }
      return response(
        [
          {
            type: 'tool-call',
            toolCallId: `call-${normalCalls}`,
            toolName: 'read',
            input: JSON.stringify({ round: normalCalls }),
          },
        ],
        normalCalls === 1 ? (options.firstInputTokens ?? 1) : options.inputTokens,
        true,
      )
    },
  })
  const tools = {
    read: tool({
      inputSchema: z.object({ round: z.number() }),
      execute: async ({ round }) => ({ content: options.payload ?? `evidence-${round}` }),
    }),
  }
  const directory = mkdtempSync(join(tmpdir(), 'dream-context-'))
  const trace = createModelTrace(directory, 1, 'proposer')
  const output = Output.object({ schema: z.object({ done: z.boolean() }) })
  const context = createContextManagement(options.window ?? 20_000, trace, { tools, output })
  const agent = new ToolLoopAgent({
    model,
    instructions: 'Original stage instructions',
    output,
    tools,
    stopWhen: stepCountIs(12),
    prepareStep: context.prepareStep,
    onLanguageModelCallStart: (event) => {
      context.onLanguageModelCallStart(event)
      trace.callbacks.onLanguageModelCallStart(event)
    },
    onLanguageModelCallEnd: (event) => {
      context.onLanguageModelCallEnd(event)
      trace.callbacks.onLanguageModelCallEnd(event)
    },
    onToolExecutionEnd: trace.callbacks.onToolExecutionEnd,
  })
  try {
    const result = await agent.generate({ prompt: 'Original task' })
    await trace.writeResult(result.output)
    return { model, result, normalCalls, summaryCalls, directory }
  } catch (error) {
    await trace.writeError(error)
    throw error
  }
}

test('below threshold preserves history without a summary call', async () => {
  const result = await run({ inputTokens: 1 })
  assert.equal(result.summaryCalls, 0)
  assert.match(JSON.stringify(result.model.doGenerateCalls.at(-1)?.prompt), /evidence-1/)
})

test('reported input usage triggers compaction and excludes the latest complete tool round', async () => {
  const result = await run({ inputTokens: 10_000 })
  assert.ok(result.summaryCalls >= 1)
  const summaryRequest = requireValue(
    result.model.doGenerateCalls.find(
      (call) =>
        call.responseFormat?.type === 'json' && call.responseFormat.name === 'ContextSummary',
    ),
  )
  assert.match(JSON.stringify(summaryRequest.prompt), /Original task|Original stage instructions/)
  assert.match(JSON.stringify(summaryRequest.prompt), /evidence-1/)
  assert.doesNotMatch(JSON.stringify(summaryRequest.prompt), /evidence-2/)
  const finalPrompt = requireValue(result.model.doGenerateCalls.at(-1)).prompt
  assert.equal(finalPrompt[0]?.role, 'system')
  assert.match(JSON.stringify(finalPrompt), /Original task|Original stage instructions/)
  assert.match(JSON.stringify(finalPrompt), /prior progress|Prior progress/i)
  assert.match(JSON.stringify(finalPrompt), /evidence-2/)
  assert.doesNotMatch(JSON.stringify(finalPrompt), /evidence-1/)
  assert.ok(
    finalPrompt.some(
      (message) => message.role === 'assistant' && JSON.stringify(message).includes('call-2'),
    ),
  )
  assert.ok(
    finalPrompt.some(
      (message) => message.role === 'tool' && JSON.stringify(message).includes('call-2'),
    ),
  )
  const events = readFileSync(join(result.directory, 'attempts/1/proposer-model.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(
    events.some(
      (event) =>
        event.event === 'context_compaction' && event.summary.fullyReadFiles[0] === 'old.txt',
    ),
  )
  assert.ok(events.some((event) => event.event === 'model_call_end' && event.purpose === 'summary'))
})

test('later compactions include the previous summary without restoring discarded history', async () => {
  const result = await run({ rounds: 4, inputTokens: 10_000 })
  const summaries = result.model.doGenerateCalls.filter(
    (call) => call.responseFormat?.type === 'json' && call.responseFormat.name === 'ContextSummary',
  )
  assert.ok(summaries.length >= 2)
  assert.match(JSON.stringify(summaries.at(-1)?.prompt), /Preserve the contrary evidence/)
  assert.doesNotMatch(JSON.stringify(summaries.at(-1)?.prompt), /evidence-1/)
  assert.deepEqual(result.result.output, { done: true })
})

test('summary calls do not contaminate normal-agent token accounting', async () => {
  // Every summary reports enormous usage, but a small subsequent normal call must continue.
  const result = await run({ inputTokens: 10_000 })
  assert.deepEqual(result.result.output, { done: true })
})

test('missing provider usage falls back to estimates for newly added tool output', async () => {
  const result = await run({ payload: 'x'.repeat(22_000), rounds: 3, window: 30_000 })
  assert.ok(result.summaryCalls > 0)
})

test('failed or invalid summaries abort the generation', async () => {
  await assert.rejects(run({ inputTokens: 10_000, failSummary: true }), /summary unavailable/)
  await assert.rejects(run({ inputTokens: 10_000, invalidSummary: true }))
})

test('oversized retained rounds fail instead of repeatedly compacting', async () => {
  await assert.rejects(run({ payload: 'x'.repeat(100_000), window: 20_000 }), /context|fit|budget/i)
})

test('the first retained round cannot bypass the 10k headroom threshold', async () => {
  await assert.rejects(
    run({ firstInputTokens: 123_000, window: 128_000 }),
    /10000 tokens of headroom/,
  )
})

test('compaction does not reset the twelve-step limit', async () => {
  await assert.rejects(run({ rounds: 20, inputTokens: 10_000 }))
})

test('configuration defaults to 128k and rejects invalid context windows', () => {
  const stages = {
    proposeSpec: () => ({ kind: 'no_proposal' as const, reason: 'No change' }),
    evaluateSpec: () => ({ kind: 'accept' as const, reason: 'Supported' }),
  }
  assert.doesNotThrow(() => createDreamer({ stages }))
  for (const contextWindowTokens of [
    0,
    -1,
    14_000,
    20_000.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(() => createDreamer({ stages, contextWindowTokens }), /contextWindowTokens/)
  }
})

test('estimator uses reported input plus new content and counts full request without usage', () => {
  const messages: ModelMessage[] = [{ role: 'user', content: 'task' }]
  const baseline = estimateContextTokens({
    instructions: 'rules',
    messages,
    tools: [],
    outputSchema: {},
  })
  const next = estimateContextTokens({
    instructions: 'rules',
    messages: [...messages, { role: 'assistant', content: 'new answer' }],
    tools: [],
    outputSchema: {},
    previous: { messages, inputTokens: 10_000 },
  })
  assert.ok(baseline > 0)
  assert.ok(next > 10_000)
})

test('compaction rejects incomplete or mismatched tool rounds before requesting a summary', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('must not call model')
    },
  })
  const trace = createModelTrace(mkdtempSync(join(tmpdir(), 'dream-context-')), 1, 'proposer')
  const output = Output.object({ schema: z.object({ done: z.boolean() }) })
  const context = createContextManagement(20_000, trace, { tools: {}, output })
  const messages: ModelMessage[] = [
    { role: 'user', content: 'x'.repeat(35_000) },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'open', toolName: 'read', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'wrong',
          toolName: 'read',
          output: { type: 'text', value: 'result' },
        },
      ],
    },
  ]
  const original = structuredClone(messages)
  await assert.rejects(
    async () =>
      context.prepareStep({
        steps: [],
        stepNumber: 1,
        messages,
        initialMessages: [requireValue(messages[0])],
        responseMessages: [],
        instructions: 'rules',
        initialInstructions: 'rules',
        model,
        toolsContext: {},
        runtimeContext: {},
      }),
    /complete recent tool round/,
  )
  assert.deepEqual(messages, original)
  assert.equal(model.doGenerateCalls.length, 0)
})

test('a failed summary leaves the supplied conversation intact', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw new Error('summary failed')
    },
  })
  const trace = createModelTrace(mkdtempSync(join(tmpdir(), 'dream-context-')), 1, 'proposer')
  const output = Output.object({ schema: z.object({ done: z.boolean() }) })
  const context = createContextManagement(30_000, trace, { tools: {}, output })
  const messages: ModelMessage[] = [
    { role: 'user', content: 'original task' },
    { role: 'assistant', content: 'x'.repeat(61_000) },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'recent', toolName: 'read', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'recent',
          toolName: 'read',
          output: { type: 'text', value: 'result' },
        },
      ],
    },
  ]
  const original = structuredClone(messages)
  await assert.rejects(
    async () =>
      context.prepareStep({
        steps: [],
        stepNumber: 1,
        messages,
        initialMessages: [requireValue(messages[0])],
        responseMessages: [],
        instructions: 'rules',
        initialInstructions: 'rules',
        model,
        toolsContext: {},
        runtimeContext: {},
      }),
    /summary failed/,
  )
  assert.deepEqual(messages, original)
})
