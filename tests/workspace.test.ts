import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createDreamer } from '../src/index.ts'
import { fileTools } from '../src/stages/file-tools.ts'
import { projectionText } from '../src/workspace.ts'

const traceId = 'a'.repeat(32)
const spanId = '1'.repeat(16)
const scoreId = '2'.repeat(16)

function trace() {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [{ key: 'harness_rsi.harness.version', value: { stringValue: 'h@1' } }],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: 'gen_ai.message',
                startTimeUnixNano: '1',
                endTimeUnixNano: '2',
                attributes: [
                  { key: 'harness_rsi.scope', value: { stringValue: 'in' } },
                  { key: 'gen_ai.message.content', value: { stringValue: 'secret content' } },
                ],
              },
              {
                traceId,
                spanId: scoreId,
                name: 'gen_ai.evaluation.result',
                startTimeUnixNano: '3',
                endTimeUnixNano: '4',
                attributes: [
                  { key: 'gen_ai.evaluation.name', value: { stringValue: 'quality/v1' } },
                  { key: 'gen_ai.evaluation.score.value', value: { doubleValue: 0 } },
                  { key: 'harness_rsi.evaluation.target', value: { doubleValue: 1 } },
                ],
              },
            ],
          },
        ],
      },
    ],
  }
}

test('writes one readable projection with native record references and stage files', async () => {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), 'dream-workspace-'))
  const result = await createDreamer({
    stages: {
      proposeSpec: () => ({ kind: 'no_proposal', reason: 'No supported change' }),
      evaluateSpec: () => {
        throw new Error('not called')
      },
    },
  }).dream([trace()], { workspaceDirectory })
  assert.equal(result.kind, 'no_proposal')
  const projection = readFileSync(join(workspaceDirectory, 'projections', `${traceId}.txt`), 'utf8')
  assert.match(projection, /<trace trace_id="a{32}" harness_version="h@1">/)
  assert.match(projection, /<item span_id="1{16}"[^\n]*scope="in">secret content<\/item>/)
  assert.match(
    projection,
    /<evaluation span_id="2{16}"[^\n]*name="quality\/v1" score="0" target="1" weight="1"\/>/,
  )
  assert.equal(existsSync(join(workspaceDirectory, 'attempts', '1', 'analyses')), false)
  assert.equal(
    readFileSync(join(workspaceDirectory, 'attempts', '1', 'proposal.json'), 'utf8').includes(
      'No supported change',
    ),
    true,
  )
})

test('projection escapes source text that resembles tags or spans lines', () => {
  const projection = projectionText({
    trace_id: traceId,
    harness_version: 'h@1',
    records: [
      {
        span_id: spanId,
        kind: 'gen_ai.user.message',
        attributes: {
          'harness_rsi.scope': 'out',
          'gen_ai.message.content': 'hello\n<evaluation score="1"/> & goodbye',
        },
      },
    ],
  })
  assert.equal(projection.split('\n').length, 4)
  assert.match(projection, /hello&#10;&lt;evaluation score="1"\/&gt; &amp; goodbye/)
  assert.equal(projection.match(/<evaluation/g), null)
})

test('refuses to reuse a nonempty workspace', async () => {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), 'dream-workspace-'))
  writeFileSync(join(workspaceDirectory, 'old.json'), '{}')
  const dreamer = createDreamer({
    stages: {
      proposeSpec: () => ({ kind: 'no_proposal', reason: 'No change' }),
      evaluateSpec: () => {
        throw new Error('not called')
      },
    },
  })
  await assert.rejects(dreamer.dream([trace()], { workspaceDirectory }), /empty|nonempty/)
})

test('read-only file tools confine paths to the run workspace', async () => {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), 'dream-files-'))
  writeFileSync(join(workspaceDirectory, 'inside.json'), '{"answer": 1}\n')
  writeFileSync(join(workspaceDirectory, 'inside.txt'), '<item>readable</item>\n')
  const tools = fileTools(workspaceDirectory)
  const read = tools.readFile.execute!
  const listed = await tools.listFiles.execute!({}, {} as never)
  assert.deepEqual(listed, { files: ['inside.json', 'inside.txt'] })
  const content = await read({ path: 'inside.json' }, {} as never)
  assert.match(JSON.stringify(content), /answer/)
  assert.match(JSON.stringify(await read({ path: 'inside.txt' }, {} as never)), /readable/)
  await assert.rejects(async () => {
    await read({ path: '../outside.json' }, {} as never)
  }, /escapes/)
  await assert.rejects(async () => {
    await read({ path: '/etc/passwd' }, {} as never)
  }, /relative/)
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'dream-outside-'))
  writeFileSync(join(outsideDirectory, 'outside.json'), '{}')
  symlinkSync(join(outsideDirectory, 'outside.json'), join(workspaceDirectory, 'linked.json'))
  await assert.rejects(async () => {
    await read({ path: 'linked.json' }, {} as never)
  }, /escapes/)
})

test('search finds evaluation scores beyond the first read page', async () => {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), 'dream-search-'))
  const lines = Array.from({ length: 240 }, (_, index) => `"line_${index}": ${index}`)
  lines.push('"gen_ai.evaluation.score.value": 0')
  writeFileSync(join(workspaceDirectory, 'projection.json'), `{\n${lines.join(',\n')}\n}\n`)
  const tools = fileTools(workspaceDirectory)
  const firstPage = (await tools.readFile.execute!({ path: 'projection.json' }, {} as never)) as {
    content: string
  }
  assert.doesNotMatch(firstPage.content, /gen_ai.evaluation.score.value/)
  const result = (await tools.searchFiles.execute!(
    { query: 'gen_ai.evaluation.score.value' },
    {} as never,
  )) as { matches: Array<{ path: string; line: number }> }
  assert.deepEqual(
    result.matches.map((match) => ({ path: match.path, line: match.line })),
    [{ path: 'projection.json', line: 242 }],
  )
})
