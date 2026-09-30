import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MockLanguageModelV3 } from 'ai/test'
import { caseDefinitions, reviewCase, runCodexTestSet } from '../examples/codex-test-set.ts'

const temporaryOutput = () => mkdtempSync(join(tmpdir(), 'codex-test-set-'))

test('offline Codex test set runs all fixtures and captures stage artifacts', async () => {
  const outputDirectory = temporaryOutput()
  const result = await runCodexTestSet({ outputDirectory })
  assert.equal(result.outputDirectory, outputDirectory)
  assert.deepEqual(
    result.cases.map((entry) => entry.name),
    ['repeated-read', 'efficient-read', 'ambiguous-feedback'],
  )
  assert.deepEqual(
    result.cases.map((entry) => entry.dreamResult.kind),
    ['spec', 'no_proposal', 'no_proposal'],
  )
  assert.deepEqual(
    result.cases.map((entry) => entry.review.observations.feedbackScores),
    [[0], [1], [0]],
  )
  assert.deepEqual(
    result.cases.map((entry) => entry.review.observations.readCounts.total),
    [2, 1, 0],
  )
  const repeated = join(outputDirectory, 'repeated-read')
  assert.deepEqual(readdirSync(repeated).includes('projected-view.json'), false)
  assert.deepEqual(readdirSync(repeated).includes('review.json'), false)
  assert.equal(existsSync(join(repeated, 'adapter-output.json')), true)
  assert.equal(existsSync(join(repeated, 'enriched-trace.json')), true)
  assert.equal(existsSync(join(repeated, 'projections')), true)
  assert.equal(existsSync(join(repeated, 'attempts', '1', 'proposal.json')), true)
  assert.equal(existsSync(join(repeated, 'attempts', '1', 'evaluation.json')), true)
  assert.equal(
    existsSync(join(outputDirectory, 'efficient-read', 'attempts', '1', 'evaluation.json')),
    false,
  )
  assert.equal(
    existsSync(join(outputDirectory, 'ambiguous-feedback', 'attempts', '1', 'evaluation.json')),
    false,
  )
  assert.match(result.cases[0]!.review.manualChecks.evaluator, /executed/)
  assert.match(result.cases[1]!.review.manualChecks.evaluator, /skipped/)
  assert.match(result.cases[2]!.review.manualChecks.evaluator, /skipped/)
  assert.equal(result.cases[0]!.review.observations.repeatedUnchangedReadEvidence.detected, true)
  assert.match(
    result.cases[0]!.review.observations.repeatedUnchangedReadEvidence.interpretation,
    /synthetic fixture/,
  )
  const projectionPath = join(
    repeated,
    'projections',
    readdirSync(join(repeated, 'projections'))[0]!,
  )
  const projection = readFileSync(projectionPath, 'utf8')
  assert.match(projection, /\[compacted\]/)
  assert.doesNotMatch(projection, /Synthetic guide: preserve the cited steps\./)
  const proposerEvents = readFileSync(
    join(repeated, 'attempts', '1', 'proposer-model.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  assert.ok(
    proposerEvents.some(
      (event) =>
        event.event === 'tool_result' &&
        (event.toolCall as { toolName?: unknown } | undefined)?.toolName === 'getSource' &&
        JSON.stringify(event.toolOutput).includes('Synthetic guide: preserve the cited steps.'),
    ),
  )
  const evaluatorEvents = readFileSync(
    join(repeated, 'attempts', '1', 'evaluator-model.jsonl'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const evaluatorReads = evaluatorEvents
    .filter(
      (event) =>
        event.event === 'tool_result' &&
        (event.toolCall as { toolName?: unknown } | undefined)?.toolName === 'readFile',
    )
    .map((event) => JSON.stringify(event.toolOutput))
  assert.ok(evaluatorReads.some((output) => output.includes('attempts/1/proposal.json')))
  assert.ok(evaluatorReads.some((output) => output.includes('projections/')))
  const merged = JSON.parse(readFileSync(join(repeated, 'result.json'), 'utf8')) as {
    dreamResult?: unknown
    review?: unknown
  }
  assert.ok(merged.dreamResult)
  assert.ok(merged.review)
  const enriched = JSON.parse(
    readFileSync(join(repeated, 'enriched-trace.json'), 'utf8'),
  ) as Array<{
    records: Array<{ content?: unknown }>
  }>
  assert.equal(
    enriched[0]!.records.some(
      (record) => record.content === 'Synthetic guide: preserve the cited steps.',
    ),
    true,
  )
})

test('caller-supplied model uses default stages without expected judgments in its prompt', async () => {
  const outputDirectory = temporaryOutput()
  const snapshotsUnavailableDuringDream: boolean[] = []
  const caseNames = ['repeated-read', 'efficient-read', 'ambiguous-feedback']
  let modelCalls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const prompt = JSON.stringify(options.prompt)
      const workspace = join(outputDirectory, caseNames[modelCalls++]!)
      snapshotsUnavailableDuringDream.push(
        !existsSync(join(workspace, 'adapter-output.json')) &&
          !existsSync(join(workspace, 'enriched-trace.json')) &&
          !existsSync(join(workspace, 'result.json')),
      )
      assert.doesNotMatch(prompt, /expectedJudgment|synthetic_scripted_demonstration/)
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              result: {
                kind: 'no_proposal',
                reason: 'Supplied model found no supported change',
                references: [],
              },
            }),
          },
        ],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  const result = await runCodexTestSet({ model, outputDirectory })
  assert.deepEqual(
    result.cases.map((entry) => entry.dreamResult.kind),
    ['no_proposal', 'no_proposal', 'no_proposal'],
  )
  assert.equal(modelCalls, 3)
  assert.deepEqual(snapshotsUnavailableDuringDream, [true, true, true])
  assert.ok(result.cases.every((entry) => existsSync(join(entry.directory, 'result.json'))))
  assert.ok(result.cases.every((entry) => entry.review.modelMode === 'caller_supplied'))
})

test('review reports an executed evaluator even when the final result has no proposal', () => {
  const review = reviewCase(
    caseDefinitions[1],
    { trace_id: 'a'.repeat(32), harness_version: 'synthetic', records: [] },
    { kind: 'no_proposal', reason: 'Attempt limit reached' },
    'caller_supplied',
    1,
  )
  assert.match(review.manualChecks.evaluator, /executed in 1 attempt/)
})
