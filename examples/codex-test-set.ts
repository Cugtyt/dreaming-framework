import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LanguageModel } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { codexAdapter } from '../extensions/codex/index.ts'
import { validateTrace } from '../src/domain/validation.ts'
import {
  createDreamer,
  type DreamResult,
  type TraceRecord,
  type TraceSession,
} from '../src/index.ts'
import { defaultProjectSession } from '../src/stages/project-session.ts'
import { parseOtelTrace } from '../src/trace/otel.ts'
import { prepareWorkspace } from '../src/workspace.ts'
import { enrichUserFeedback } from './dream-with-feedback.ts'
import { createRunDirectory } from './run-directory.ts'

export const caseDefinitions = [
  { name: 'repeated-read', fixture: 'repeated-read.jsonl', expectedJudgment: 'spec' },
  { name: 'efficient-read', fixture: 'efficient-read.jsonl', expectedJudgment: 'no_proposal' },
  {
    name: 'ambiguous-feedback',
    fixture: 'ambiguous-feedback.jsonl',
    expectedJudgment: 'no_proposal',
  },
] as const

function readRecords(session: TraceSession) {
  const results = new Map<string, TraceRecord>()
  for (const record of session.records) {
    if (record.kind !== 'gen_ai.tool.call.result' || record.parent_id === undefined) continue
    results.set(record.parent_id, record)
  }
  return session.records
    .filter(
      (record) =>
        record.kind === 'gen_ai.tool.call' && record.attributes?.['gen_ai.tool.name'] === 'read',
    )
    .map((call) => {
      let path = '<unknown>'
      const raw = call.attributes?.['gen_ai.tool.call.arguments']
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as { path?: unknown }
          if (typeof parsed.path === 'string') path = parsed.path
        } catch {
          // The adapter preserves malformed tool arguments as source text.
        }
      }
      return { call, path, result: results.get(call.span_id) }
    })
}

export function reviewCase(
  definition: (typeof caseDefinitions)[number],
  trace: TraceSession,
  dreamResult: DreamResult,
  modelMode: 'scripted_mock' | 'caller_supplied',
  evaluatedAttempts: number,
) {
  const reads = readRecords(trace)
  const byPath: Record<string, number> = Object.create(null)
  for (const read of reads) byPath[read.path] = (byPath[read.path] ?? 0) + 1
  const feedbackScores = trace.records
    .filter((record) => record.kind === 'gen_ai.evaluation.result')
    .map((record) => record.attributes?.['gen_ai.evaluation.score.value'])
    .filter((score): score is number => typeof score === 'number')
  const byReadPath = new Map<string, typeof reads>()
  for (const read of reads) {
    byReadPath.set(read.path, [...(byReadPath.get(read.path) ?? []), read])
  }
  let repeatedUnchangedReadEvidence: {
    detected: boolean
    path?: string
    result?: string
    occurrences?: number
    interpretation: string
  } = {
    detected: false,
    interpretation: 'No repeated unchanged read was observed in this synthetic fixture.',
  }
  for (const [path, occurrences] of byReadPath) {
    const counts = new Map<string, number>()
    for (const read of occurrences) {
      const content = read.result?.content
      if (typeof content === 'string') counts.set(content, (counts.get(content) ?? 0) + 1)
    }
    const repeated = [...counts].find(([, count]) => count >= 2)
    if (repeated !== undefined) {
      repeatedUnchangedReadEvidence = {
        detected: true,
        path,
        result: repeated[0],
        occurrences: repeated[1],
        interpretation:
          'Observed equality in this synthetic fixture; this is not a general unchanged-file guarantee.',
      }
      break
    }
  }
  return {
    observations: {
      readCounts: { total: reads.length, byPath },
      feedbackScores,
      repeatedUnchangedReadEvidence,
    },
    expectedJudgment: { kind: definition.expectedJudgment },
    manualChecks: {
      grounding:
        dreamResult.kind === 'spec'
          ? 'Manually inspect every cited source record and the original tool result.'
          : 'Manually inspect whether the evidence supports any bounded candidate.',
      scope: 'Manually confirm that proposed change targets use in-scope records only.',
      prediction: 'Manually check predicted score movement against the named evaluation.',
      regression: 'Manually verify the one-read healthy session remains a preserved outcome.',
      evaluator:
        evaluatedAttempts > 0
          ? `Evaluator executed in ${evaluatedAttempts} attempt(s); inspect its candidate and projection reads.`
          : 'Evaluator skipped; no evaluator artifacts are expected.',
    },
    modelMode,
    evidenceLevel:
      modelMode === 'scripted_mock' ? 'synthetic_scripted_demonstration' : 'model_prediction',
  }
}

export function createCaseModel(
  name: (typeof caseDefinitions)[number]['name'],
  trace: TraceSession,
): LanguageModel {
  type MockGenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>
  const usage = () => ({
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  })
  const toolCall = (toolName: string, input: unknown, toolCallId: string): MockGenerateResult => ({
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: usage(),
    warnings: [],
  })
  const textResponse = (value: unknown): MockGenerateResult => ({
    content: [{ type: 'text', text: JSON.stringify(value) }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: usage(),
    warnings: [],
  })
  const sourceReference = (record: TraceRecord) => ({
    trace_id: trace.trace_id,
    span_id: record.span_id,
    ...(record.event_index === undefined ? {} : { event_index: record.event_index }),
  })
  const reads = readRecords(trace)
  const references = reads.flatMap(({ call, result }) => [
    sourceReference(call),
    ...(result === undefined ? [] : [sourceReference(result)]),
  ])
  const evaluation = trace.records.find((record) => record.kind === 'gen_ai.evaluation.result')
  if (evaluation !== undefined) references.push(sourceReference(evaluation))
  const firstResult = reads[0]?.result
  const projectionPath = `projections/${trace.trace_id}.txt`
  const responses: Array<ReturnType<typeof toolCall> | ReturnType<typeof textResponse>> = []
  if (name === 'repeated-read' && firstResult !== undefined && references.length > 0) {
    responses.push(toolCall('readFile', { path: projectionPath }, 'proposer-projection'))
    responses.push(
      toolCall('getSource', { reference: sourceReference(firstResult) }, 'proposer-source'),
    )
    responses.push(
      textResponse({
        result: {
          issue: 'The completed task reads the same unchanged file twice.',
          proposal:
            'Reuse an unchanged read result during one task while preserving rereads after an edit.',
          predict:
            'The explicit feedback score should move toward its target without changing the answer behavior.',
          baseHarnessVersion: trace.harness_version,
          references,
        },
      }),
    )
    responses.push(
      toolCall('readFile', { path: 'attempts/1/proposal.json' }, 'evaluator-candidate'),
    )
    responses.push(toolCall('readFile', { path: projectionPath }, 'evaluator-projection'))
    responses.push(
      textResponse({
        kind: 'accept',
        reason: 'The cited repeated unchanged read supports a bounded proposal.',
        references,
      }),
    )
  } else {
    responses.push(toolCall('readFile', { path: projectionPath }, 'proposer-projection'))
    responses.push(
      textResponse({
        result: {
          kind: 'no_proposal',
          reason:
            name === 'ambiguous-feedback'
              ? 'Negative feedback has no supported cause in the completed session.'
              : 'The healthy one-read session provides no bounded regression to fix.',
          references: [],
        },
      }),
    )
  }
  let index = 0
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const response = responses[index++]
      if (response === undefined)
        throw new Error(`Scripted ${name} model received an unexpected call`)
      return response
    },
  })
}

export async function runCodexTestSet(
  options: { model?: LanguageModel; outputDirectory?: string } = {},
) {
  const outputDirectory =
    options.outputDirectory === undefined
      ? await createRunDirectory()
      : await prepareWorkspace(options.outputDirectory)
  const writeJson = (path: string, value: unknown) =>
    writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
  const fixtureDirectory = fileURLToPath(new URL('./data/', import.meta.url))
  const cases: Array<{
    name: string
    directory: string
    dreamResult: DreamResult
    review: ReturnType<typeof reviewCase>
  }> = []
  for (const definition of caseDefinitions) {
    const caseDirectory = join(outputDirectory, definition.name)
    await mkdir(caseDirectory)
    const session = await readFile(join(fixtureDirectory, definition.fixture), 'utf8')
    const adapterOutput = codexAdapter.convertSession(session)
    const trace = validateTrace(parseOtelTrace(adapterOutput[0]))
    let enrichedTrace: TraceSession | undefined
    const projectSession = (input: TraceSession) => {
      enrichedTrace = structuredClone(input)
      return defaultProjectSession(input)
    }
    const model = options.model ?? createCaseModel(definition.name, trace)
    const modelMode = options.model === undefined ? 'scripted_mock' : 'caller_supplied'
    const dreamResult = await createDreamer({
      model,
      stages: { enrichTrace: enrichUserFeedback, projectSession },
    }).dream(adapterOutput, { workspaceDirectory: caseDirectory })
    if (enrichedTrace === undefined)
      throw new Error(`No enriched trace captured for ${definition.name}`)
    await writeJson(join(caseDirectory, 'adapter-output.json'), adapterOutput)
    await writeJson(join(caseDirectory, 'enriched-trace.json'), [enrichedTrace])
    let evaluatedAttempts = 0
    try {
      const attempts = await readdir(join(caseDirectory, 'attempts'), { withFileTypes: true })
      for (const attempt of attempts) {
        if (!attempt.isDirectory()) continue
        try {
          await readFile(join(caseDirectory, 'attempts', attempt.name, 'evaluation.json'))
          evaluatedAttempts++
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const review = reviewCase(definition, enrichedTrace, dreamResult, modelMode, evaluatedAttempts)
    await writeJson(join(caseDirectory, 'result.json'), { dreamResult, review })
    cases.push({ name: definition.name, directory: caseDirectory, dreamResult, review })
  }
  return { outputDirectory, cases }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runCodexTestSet()
  console.log(`Codex inspection artifacts: ${result.outputDirectory}`)
  for (const entry of result.cases) {
    console.log(`${entry.name}: ${entry.dreamResult.kind}`)
  }
}
