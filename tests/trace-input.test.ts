import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import test from 'node:test'
import { loadTraceInputs } from '../src/trace/input.ts'

test('normalizes an in-memory list without changing its values or order', async () => {
  const inputs = [{ resourceSpans: [] }, { resourceSpans: [] }]
  const loaded = await loadTraceInputs(inputs)
  assert.deepEqual(
    loaded,
    inputs.map((input) => ({ input })),
  )
  assert.equal(loaded[0]?.input, inputs[0])
  assert.deepEqual(await loadTraceInputs([]), [])
})

test('loads immediate JSON files in filename order and leaves source bytes unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dream-input-'))
  const first = '{ "resourceSpans": [], "marker": "first" }\n'
  const second = '{ "resourceSpans": [], "marker": "second" }\n'
  await writeFile(join(directory, 'b.json'), second)
  await writeFile(join(directory, 'a.json'), first)
  await writeFile(join(directory, 'notes.txt'), 'not JSON')
  await mkdir(join(directory, 'nested.json'))
  await writeFile(join(directory, 'nested.json', 'trace.json'), 'not JSON')
  assert.deepEqual(await loadTraceInputs(relative(process.cwd(), directory)), [
    { input: JSON.parse(first), sourcePath: join(directory, 'a.json') },
    { input: JSON.parse(second), sourcePath: join(directory, 'b.json') },
  ])
  assert.equal(await readFile(join(directory, 'a.json'), 'utf8'), first)
  assert.equal(await readFile(join(directory, 'b.json'), 'utf8'), second)
})

test('an empty folder loads an empty trace list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dream-input-'))
  assert.deepEqual(await loadTraceInputs(directory), [])
})

test('rejects blank, missing, non-directory, and non-list inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dream-input-'))
  const file = join(directory, 'trace.json')
  await writeFile(file, '{}')
  await assert.rejects(loadTraceInputs('  '), /nonempty/)
  await assert.rejects(loadTraceInputs(join(directory, 'missing')), /missing/)
  await assert.rejects(loadTraceInputs(file), /directory/)
  await assert.rejects(loadTraceInputs(null as never), /list|array/)
})

test('invalid JSON identifies its source file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dream-input-'))
  await writeFile(join(directory, 'broken.json'), '{')
  await assert.rejects(loadTraceInputs(directory), /broken\.json.*JSON/)
})

test('rejects matching symlinks without reading their targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dream-input-'))
  await symlink(join(directory, 'missing'), join(directory, 'linked.json'))
  await assert.rejects(loadTraceInputs(directory), /linked\.json.*symbolic link/)
})

test('unreadable JSON identifies its source file', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dream-input-'))
  const file = join(directory, 'unreadable.json')
  await writeFile(file, '{}')
  await chmod(file, 0)
  try {
    await assert.rejects(loadTraceInputs(directory), /unreadable\.json.*Cannot read trace file/)
  } finally {
    await chmod(file, 0o600)
  }
})
