import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MockLanguageModelV3 } from 'ai/test'
import { createDreamer } from '../src/index.ts'
import { createRunDirectory } from './run-directory.ts'

const traceId = 'a'.repeat(32)
const rootId = '1'.repeat(16)
const skillId = '2'.repeat(16)
const resultId = '3'.repeat(16)
const evaluationId = '5'.repeat(16)

// One completed OTLP JSON trace export. Scope belongs to each attributable item;
// the score is a separate span in the same trace.
const trace = {
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
            },
            {
              traceId,
              spanId: '4'.repeat(16),
              parentSpanId: rootId,
              name: 'requirement',
              startTimeUnixNano: '110',
              endTimeUnixNano: '115',
              attributes: [{ key: 'harness_rsi.scope', value: { stringValue: 'out' } }],
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
                  value: { stringValue: 'Review spec already in context' },
                },
              ],
            },
            {
              traceId,
              spanId: evaluationId,
              parentSpanId: rootId,
              name: 'gen_ai.evaluation.result',
              startTimeUnixNano: '250',
              endTimeUnixNano: '250',
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
      ],
    },
  ],
}

const resultRef = { trace_id: traceId, span_id: resultId }
const outputs = [
  {
    result: {
      issue: 'The review skill repeats a search',
      proposal: 'Let the review skill skip the search when the spec is in context',
      predict: 'Search efficiency improves while review correctness stays intact',
      baseHarnessVersion: 'review-harness@1',
      references: [
        { trace_id: traceId, span_id: skillId },
        resultRef,
        { trace_id: traceId, span_id: evaluationId },
      ],
    },
  },
  { kind: 'accept', reason: 'The trace supports a bounded search change', references: [] },
]
let next = 0
// This SDK mock keeps the example offline. A host supplies a provider model.
const model = new MockLanguageModelV3({
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
const dreamer = createDreamer({ model })

const workspaceDirectory = await createRunDirectory()
const result = await dreamer.dream([trace], { workspaceDirectory })
await writeFile(join(workspaceDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
console.log(`Run files: ${workspaceDirectory}`)
