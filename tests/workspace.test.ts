import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  fileTools,
  listFilesOutputSchema,
  readFileOutputSchema,
  searchFilesOutputSchema,
} from '../src/agent/tools/file-tools.ts'
import { sourceTool } from '../src/agent/tools/source-tool.ts'
import { createDreamer } from '../src/index.ts'
import { projectionText } from '../src/trace/projection.ts'
import { requireValue } from './helpers.ts'

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
  const read = requireValue(tools.readFile.execute)
  const listFiles = requireValue(tools.listFiles.execute)
  const toolOptions = { toolCallId: 'test', messages: [], context: undefined }
  const listed = await listFiles({}, toolOptions)
  assert.deepEqual(listed, { files: ['inside.json', 'inside.txt'], total: 2, nextOffset: null })
  const content = await read({ path: 'inside.json' }, toolOptions)
  assert.match(JSON.stringify(content), /answer/)
  assert.match(JSON.stringify(await read({ path: 'inside.txt' }, toolOptions)), /readable/)
  await assert.rejects(async () => {
    await read({ path: '../outside.json' }, toolOptions)
  }, /escapes/)
  await assert.rejects(async () => {
    await read({ path: '/etc/passwd' }, toolOptions)
  }, /relative/)
  const outsideDirectory = mkdtempSync(join(tmpdir(), 'dream-outside-'))
  writeFileSync(join(outsideDirectory, 'outside.json'), '{}')
  symlinkSync(join(outsideDirectory, 'outside.json'), join(workspaceDirectory, 'linked.json'))
  await assert.rejects(async () => {
    await read({ path: 'linked.json' }, toolOptions)
  }, /escapes/)
})

test('search finds evaluation scores beyond the first read page', async () => {
  const workspaceDirectory = mkdtempSync(join(tmpdir(), 'dream-search-'))
  const lines = Array.from({ length: 240 }, (_, index) => `"line_${index}": ${index}`)
  lines.push('"gen_ai.evaluation.score.value": 0')
  writeFileSync(join(workspaceDirectory, 'projection.json'), `{\n${lines.join(',\n')}\n}\n`)
  const tools = fileTools(workspaceDirectory)
  const readFile = requireValue(tools.readFile.execute)
  const searchFiles = requireValue(tools.searchFiles.execute)
  const toolOptions = { toolCallId: 'test', messages: [], context: undefined }
  const firstPage = await readFile({ path: 'projection.json' }, toolOptions)
  assert.ok('content' in firstPage)
  assert.doesNotMatch(firstPage.content, /gen_ai.evaluation.score.value/)
  const result = await searchFiles({ query: 'gen_ai.evaluation.score.value' }, toolOptions)
  assert.ok('matches' in result)
  assert.deepEqual(
    result.matches.map((match) => ({ path: match.path, line: match.line })),
    [{ path: 'projection.json', line: 242 }],
  )
})

test('listing and searching reach every file through stable pages', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-pages-'))
  for (let index = 0; index < 201; index++) {
    writeFileSync(
      join(directory, `${String(index).padStart(3, '0')}.txt`),
      'before\nneedle 42\nafter',
    )
  }
  const tools = fileTools(directory)
  const toolOptions = { toolCallId: 'test', messages: [], context: undefined }
  const listFiles = requireValue(tools.listFiles.execute)
  const searchFiles = requireValue(tools.searchFiles.execute)
  const first = listFilesOutputSchema.parse(await listFiles({}, toolOptions))
  assert.equal(first.total, 201)
  assert.equal(first.files.length, 200)
  assert.equal(first.nextOffset, 200)
  const last = await listFiles({ offset: 200 }, toolOptions)
  assert.deepEqual(last, { files: ['200.txt'], total: 201, nextOffset: null })
  const matches = searchFilesOutputSchema.parse(
    await searchFiles({ query: 'needle', offset: 200 }, toolOptions),
  )
  assert.equal(matches.total, 201)
  assert.equal(matches.nextOffset, null)
  assert.equal(matches.matches[0]?.path, '200.txt')
  const filtered = searchFilesOutputSchema.parse(
    await searchFiles(
      { query: 'needle \\d+', regex: true, path: '200.txt', contextLines: 1 },
      toolOptions,
    ),
  )
  assert.equal(filtered.total, 1)
  assert.deepEqual(filtered.matches[0]?.context, [
    { line: 1, text: 'before' },
    { line: 2, text: 'needle 42' },
    { line: 3, text: 'after' },
  ])
  await assert.rejects(
    async () => searchFiles({ query: '[', regex: true }, toolOptions),
    /regular expression/,
  )
  await assert.rejects(
    async () => searchFiles({ query: 'x', path: '../outside' }, toolOptions),
    /escapes/,
  )
})

test('long line previews preserve both ends and full reads preserve every character', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dream-long-line-'))
  const long = 'A'.repeat(100) + 'x'.repeat(35_000) + 'Z'.repeat(100)
  writeFileSync(join(directory, 'trace.txt'), `${long}\nlast`)
  const tools = fileTools(directory)
  const readFile = requireValue(tools.readFile.execute)
  const toolOptions = { toolCallId: 'test', messages: [], context: undefined }
  const preview = readFileOutputSchema.parse(
    await readFile({ path: 'trace.txt', lineCount: 1 }, toolOptions),
  )
  assert.equal(
    preview.content,
    `${'A'.repeat(100)} … [truncated: 35000 characters omitted] … ${'Z'.repeat(100)}`,
  )
  assert.deepEqual(preview.truncatedLines, [1])
  assert.equal(preview.nextLine, 2)
  const full = readFileOutputSchema.parse(
    await readFile({ path: 'trace.txt', fullLines: true }, toolOptions),
  )
  assert.equal(full.content, `${long}\nlast`)
  assert.deepEqual(full.truncatedLines, [])
  assert.equal(full.nextLine, null)
})

test('source retrieval preserves large original contents', async () => {
  const content = 'original'.repeat(10_000)
  const reference = { trace_id: traceId, span_id: spanId }
  const original = { span_id: spanId, kind: 'tool.result', content, attributes: {} }
  const source = sourceTool((ref) => (ref.span_id === spanId ? original : undefined))
  const getSource = requireValue(source.execute)
  const toolOptions = { toolCallId: 'test', messages: [], context: undefined }
  assert.deepEqual(await getSource({ reference }, toolOptions), original)
  assert.equal(
    await getSource({ reference: { ...reference, span_id: 'missing' } }, toolOptions),
    null,
  )
})
