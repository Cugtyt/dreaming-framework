import assert from 'node:assert/strict'
import test from 'node:test'
import { createDreamer } from '../src/index.ts'

const goal = {
  boundary: 'coding-harness/v3',
  question: 'Find avoidable work while preserving review correctness',
}

const trace = {
  trace_id: 'run-17',
  schema_version: '2',
  scope_boundary: 'coding-harness/v3',
  records: [
    {
      item_id: '41',
      kind: 'requirement',
      'harness_rsi.scope': 'out',
      subject: { id: 'review-contract', version: '2' },
      content: 'Keep the review contract',
    },
    {
      item_id: '42',
      kind: 'skill.load',
      'harness_rsi.scope': 'in',
      subject: { id: 'review-skill', version: '7' },
      content: 'Always search for the spec',
    },
    {
      item_id: 'r1',
      kind: 'tool.result',
      'harness_rsi.scope': 'out',
      content: 'The relevant spec was already found',
    },
    {
      item_id: '45',
      kind: 'evaluation',
      'harness_rsi.evaluation': {
        name: 'search_efficiency/v2', value: 0.3, target: 1, weight: 2,
      },
    },
    {
      item_id: '46',
      kind: 'evaluation',
      'harness_rsi.evaluation': {
        name: 'task_correctness/v1', value: 1, target: 1,
      },
    },
  ],
}

test('produces a cited spec while retaining original evidence after projection', async () => {
  const input = structuredClone(trace)
  const dreamer = createDreamer({
    analyzeSession: async (view) => {
      assert.equal(view.records[2]?.content, '[compacted]')
      return [{ text: 'A search result already had the spec', references: ['run-17/r1'] }]
    },
    proposeSpec: async ({ sessions }) => {
      assert.equal(sessions[0]?.observations[0]?.references[0], 'run-17/r1')
      return {
        issue: 'The review skill requires an unnecessary search',
        proposal: 'Skip the search when the spec is already in context',
        predict: 'Search efficiency improves without lower correctness',
        componentId: 'review-skill',
        references: ['run-17/42', 'run-17/r1', 'run-17/45'],
      }
    },
    evaluateSpec: async ({ sessions, evaluations, getSource }) => {
      assert.equal(sessions.length, 1)
      assert.equal(evaluations[0]?.record['harness_rsi.evaluation']?.weight, 2)
      assert.equal(evaluations[1]?.record['harness_rsi.evaluation']?.weight, 1)
      assert.equal(getSource('run-17/r1')?.content, 'The relevant spec was already found')
      const mutableCopy = getSource('run-17/r1')
      mutableCopy!.content = 'changed by evaluator'
      assert.equal(getSource('run-17/r1')?.content, 'The relevant spec was already found')
      return { kind: 'accept', reason: 'The second search added no new evidence' }
    },
  })

  const result = await dreamer.dream([trace], goal)
  assert.equal(result.kind, 'spec')
  if (result.kind === 'spec') {
    assert.equal(result.spec.componentId, 'review-skill')
    assert.deepEqual(result.spec.references, ['run-17/42', 'run-17/r1', 'run-17/45'])
  }
  assert.deepEqual(trace, input)
})

test('analyzes sessions concurrently and returns them in input order', { timeout: 1000 }, async () => {
  const second = { ...structuredClone(trace), trace_id: 'run-21' }
  let entered = 0
  let release!: () => void
  const bothEntered = new Promise<void>((resolve) => { release = resolve })
  const dreamer = createDreamer({
    analyzeSession: async (view) => {
      entered++
      if (entered === 2) release()
      await bothEntered
      return [{ text: 'Observed skill', references: [`${view.trace_id}/42`] }]
    },
    proposeSpec: async ({ sessions }) => {
      assert.deepEqual(sessions.map((session) => session.view.trace_id), ['run-17', 'run-21'])
      return { kind: 'no_proposal', reason: 'No supported change yet' }
    },
    evaluateSpec: () => { throw new Error('No candidate should be evaluated') },
  })

  const result = await dreamer.dream([trace, second], goal)
  assert.equal(result.kind, 'no_proposal')
  assert.equal(entered, 2)
})

test('a projection replacement applies to only its call', async () => {
  const observed: unknown[] = []
  const dreamer = createDreamer({
    analyzeSession: (view) => {
      observed.push(view.records[2]?.content)
      return []
    },
    proposeSpec: () => ({ kind: 'no_proposal', reason: 'No proposal' }),
    evaluateSpec: () => { throw new Error('No candidate should be evaluated') },
  })

  await dreamer.dream([trace], goal, {
    projectSession: (source) => {
      const view = structuredClone(source)
      view.records[2]!.content = 'Task-specific summary'
      return view
    },
  })
  await dreamer.dream([trace], goal)
  assert.deepEqual(observed, ['Task-specific summary', '[compacted]'])
})

test('the evaluator can reject using an uncited item from another session', async () => {
  const second = structuredClone(trace)
  second.trace_id = 'run-21'
  second.records[2]!.content = 'The second search found a missing requirement'
  const result = await createDreamer({
    analyzeSession: () => [],
    proposeSpec: () => ({
      issue: 'Repeated search', proposal: 'Skip the second search',
      predict: 'Fewer calls', componentId: 'review-skill',
      references: ['run-17/42'],
    }),
    evaluateSpec: ({ sessions, getSource }) => {
      assert.equal(sessions.length, 2)
      assert.equal(getSource('run-21/r1')?.content, 'The second search found a missing requirement')
      return { kind: 'reject', reason: 'The search supplied unique information' }
    },
  }).dream([trace, second], goal)
  assert.deepEqual(result, {
    kind: 'no_proposal', reason: 'The search supplied unique information',
  })
})

test('passes evaluator feedback to a fresh proposal pass and bounds revision', async () => {
  const feedbacks: Array<string | undefined> = []
  let evaluations = 0
  const candidate = {
    issue: 'Repeated search', proposal: 'Revise skill', predict: 'Fewer calls',
    componentId: 'review-skill', references: ['run-17/42'],
  }
  const stages = {
    analyzeSession: () => [],
    proposeSpec: ({ feedback }: { feedback?: string }) => {
      feedbacks.push(feedback)
      return candidate
    },
    evaluateSpec: () => {
      evaluations++
      return evaluations === 1
        ? { kind: 'revise' as const, reason: 'Check correctness' }
        : { kind: 'accept' as const, reason: 'Correctness checked' }
    },
  }
  const result = await createDreamer(stages).dream([trace], goal)
  assert.equal(result.kind, 'spec')
  assert.deepEqual(feedbacks, [undefined, 'Check correctness'])

  let attempts = 0
  const exhausted = await createDreamer({
    ...stages,
    proposeSpec: () => { attempts++; return candidate },
    evaluateSpec: () => ({ kind: 'revise', reason: 'Still uncertain' }),
  }).dream([trace], goal)
  assert.equal(attempts, 3)
  assert.equal(exhausted.kind, 'no_proposal')
  if (exhausted.kind === 'no_proposal') assert.match(exhausted.reason, /revision limit/)
})

test('rejects missing scope, boundary mismatch, invalid references, and out-of-scope proposals', async () => {
  const candidate = {
    issue: 'Repeated search', proposal: 'Revise skill', predict: 'Fewer calls',
    componentId: 'review-skill', references: ['run-17/42'],
  }
  const stages = {
    analyzeSession: () => [],
    proposeSpec: () => candidate,
    evaluateSpec: () => ({ kind: 'accept' as const, reason: 'Supported' }),
  }
  const missingScope = structuredClone(trace) as { records: Array<Record<string, unknown>> }
  delete missingScope.records[2]!['harness_rsi.scope']
  await assert.rejects(createDreamer(stages).dream([missingScope], goal), /missing scope/)
  await assert.rejects(
    createDreamer(stages).dream([trace], { ...goal, boundary: 'another-harness' }),
    /different scope boundary/,
  )
  await assert.rejects(createDreamer({
    ...stages,
    proposeSpec: () => ({ ...candidate, references: ['run-17/missing'] }),
  }).dream([trace], goal), /unresolved reference/)
  await assert.rejects(createDreamer({
    ...stages,
    proposeSpec: () => ({ ...candidate, componentId: 'review-contract' }),
  }).dream([trace], goal), /not in scope/)
  await assert.rejects(createDreamer(stages).dream([trace], goal, {
    projectSession: (source) => {
      const view = structuredClone(source)
      view.records[0]!.item_id = 'changed'
      return view
    },
  }), /changed record identity/)
  await assert.rejects(createDreamer({
    ...stages,
    analyzeSession: () => [{ text: 'Uncited observation', references: [] }],
  }).dream([trace], goal), /observation needs source references/)

  const firstCollision = { ...structuredClone(trace), trace_id: 'run/part' }
  const secondCollision = { ...structuredClone(trace), trace_id: 'run' }
  secondCollision.records[0]!.item_id = 'part/41'
  await assert.rejects(
    createDreamer(stages).dream([firstCollision, secondCollision], goal),
    /duplicate source reference run\/part\/41/,
  )
})
