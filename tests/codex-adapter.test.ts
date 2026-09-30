import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { codexAdapter } from '../extensions/codex/index.ts'
import { validateTrace } from '../src/domain/validation.ts'
import { createDreamer } from '../src/index.ts'
import { parseOtelTrace } from '../src/trace/otel.ts'
import { requireValue } from './helpers.ts'

const line = (type: string, payload: Record<string, unknown>, timestamp = '2026-09-25T10:00:00Z') =>
  JSON.stringify({ timestamp, type, payload })
const message = (role: string, text: string) =>
  line('response_item', { type: 'message', role, content: [{ type: 'input_text', text }] })

function session(): string {
  return [
    line('session_meta', { id: 'session-one', cli_version: '0.155.0' }),
    line('event_msg', { type: 'task_started', turn_id: 'completed' }),
    message('developer', 'Follow the instructions.'),
    message('user', 'Read the file.'),
    line('response_item', { type: 'reasoning', summary: [{ text: 'Omitted reasoning' }] }),
    line('response_item', {
      type: 'function_call',
      call_id: 'call-one',
      name: 'read',
      arguments: '{"path":"a.txt"}',
    }),
    line('response_item', {
      type: 'function_call_output',
      call_id: 'call-one',
      output: 'full file content',
    }),
    line('response_item', {
      type: 'custom_tool_call',
      call_id: 'call-two',
      name: 'shell',
      input: 'pwd',
    }),
    line('response_item', {
      type: 'custom_tool_call_output',
      call_id: 'call-two',
      output: { cwd: '/example' },
    }),
    message('assistant', 'Done.'),
    line('event_msg', { type: 'task_complete', turn_id: 'completed' }),
    line('event_msg', { type: 'task_started', turn_id: 'unfinished' }),
    message('user', 'Unfinished request'),
    message('assistant', 'Unfinished answer'),
    '',
  ].join('\n')
}

test('Codex adapter maps completed messages and both tool forms with stable identities', () => {
  const traces = codexAdapter.convertSession(session())
  assert.deepEqual(codexAdapter.convertSession(session()), traces)
  assert.equal(traces.length, 1)
  const parsed = validateTrace(parseOtelTrace(traces[0]))
  assert.equal(parsed.harness_version, 'codex-cli@0.155.0')
  assert.equal(parsed.records.length, 8)
  const developer = requireValue(
    parsed.records.find((record) => record.kind === 'gen_ai.developer.message'),
  )
  assert.equal(developer.attributes?.['harness_rsi.scope'], 'out')
  assert.equal(parsed.records.at(-1)?.attributes?.['harness_rsi.scope'], 'in')
  const calls = parsed.records.filter((record) => record.kind === 'gen_ai.tool.call')
  const results = parsed.records.filter((record) => record.kind === 'gen_ai.tool.call.result')
  assert.equal(calls.length, 2)
  assert.deepEqual(
    results.map((record) => record.parent_id),
    calls.map((record) => record.span_id),
  )
  assert.deepEqual(
    results.map((record) => record.content),
    ['full file content', '{"cwd":"/example"}'],
  )
  assert.ok(calls.every((record) => record.attributes?.['harness_rsi.scope'] === 'in'))
  assert.ok(results.every((record) => record.attributes?.['harness_rsi.scope'] === 'out'))
  assert.doesNotMatch(JSON.stringify(parsed), /Unfinished|Omitted reasoning/)
  assert.ok(parsed.records.every((record) => record.kind !== 'gen_ai.evaluation.result'))
})

test('Codex adapter ignores aborted turns and links an unmatched result to the root', () => {
  const jsonl = [
    line('session_meta', { session_id: 'session-two', cli_version: '1' }),
    line('event_msg', { type: 'task_started', turn_id: 'aborted' }),
    message('assistant', 'Aborted content'),
    line('event_msg', { type: 'task_aborted' }),
    line('event_msg', { type: 'task_started', turn_id: 'done' }),
    line('response_item', { type: 'function_call_output', call_id: 'missing', output: 'result' }),
    line('event_msg', { type: 'task_complete' }),
  ].join('\n')
  const parsed = validateTrace(parseOtelTrace(codexAdapter.convertSession(jsonl)[0]))
  assert.equal(parsed.records.length, 2)
  assert.equal(parsed.records[1]?.parent_id, parsed.records[0]?.span_id)
  assert.doesNotMatch(JSON.stringify(parsed), /Aborted content/)
})

test('Codex adapter reads a session file without modifying it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-adapter-'))
  const path = join(directory, 'session.jsonl')
  const jsonl = session()
  await writeFile(path, jsonl)
  assert.deepEqual(await codexAdapter.readSession(path), codexAdapter.convertSession(jsonl))
  assert.equal(await readFile(path, 'utf8'), jsonl)
})

test('Codex adapter reports malformed or unsupported session inputs', () => {
  assert.throws(() => codexAdapter.convertSession('{'), /JSON.*line 1/)
  assert.throws(() => codexAdapter.convertSession(message('user', 'hello')), /metadata/)
  assert.throws(
    () =>
      codexAdapter.convertSession(session().replace('"cli_version":"0.155.0"', '"cli_version":""')),
    /CLI version/,
  )
  assert.throws(
    () => codexAdapter.convertSession(session().replace('"turn_id":"completed"', '"turn_id":""')),
    /turn identifier/,
  )
  assert.throws(
    () =>
      codexAdapter.convertSession(
        session().replace(
          '"timestamp":"2026-09-25T10:00:00Z","type":"response_item"',
          '"timestamp":"invalid","type":"response_item"',
        ),
      ),
    /timestamp/,
  )
  assert.throws(
    () => codexAdapter.convertSession(line('session_meta', { id: 'empty', cli_version: '1' })),
    /completed turns/,
  )
})

test('converted Codex traces work with framework enrichment and dreaming', async () => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'codex-dream-'))
  const result = await createDreamer({
    stages: {
      enrichTrace: (trace) => {
        const lastRecord = requireValue(trace.records.at(-1))
        const time = requireValue(lastRecord.time)
        return {
          evaluations: [{ name: 'test/v1', value: 0, target: 1, time }],
        }
      },
      proposeSpec: ({ views }) => {
        assert.equal(views[0]?.harness_version, 'codex-cli@0.155.0')
        assert.equal(views[0]?.records.at(-1)?.kind, 'gen_ai.evaluation.result')
        return { kind: 'no_proposal', reason: 'Conversion verified' }
      },
      evaluateSpec: () => {
        throw new Error('No proposal to evaluate')
      },
    },
  }).dream(codexAdapter.convertSession(session()), { workspaceDirectory })
  assert.deepEqual(result, { kind: 'no_proposal', reason: 'Conversion verified' })
})

test('invalid message roles are rejected only for completed turns', () => {
  const completed = [
    line('session_meta', { id: 'roles', cli_version: '1' }),
    line('event_msg', { type: 'task_started', turn_id: 'done' }),
    message('user', 'Read'),
  ]
  const end = line('event_msg', { type: 'task_complete' })
  for (const role of [{ role: 'invalid' }, {}]) {
    const invalidMessage = line('response_item', {
      type: 'message',
      ...role,
      content: [{ type: 'input_text', text: 'Invalid role' }],
    })
    assert.throws(
      () => codexAdapter.convertSession([...completed, invalidMessage, end].join('\n')),
      /supported payload.*line 4/,
    )
    assert.deepEqual(
      codexAdapter.convertSession(
        [
          ...completed,
          end,
          line('event_msg', { type: 'task_started', turn_id: 'unfinished' }),
          invalidMessage,
        ].join('\n'),
      ),
      codexAdapter.convertSession([...completed, end].join('\n')),
    )
  }
})

test('supported payload shapes are validated only for completed turns', () => {
  const invalidMessage = line('response_item', {
    type: 'message',
    role: 'assistant',
    content: 'wrong',
  })
  const prefix = [
    line('session_meta', { id: 'shape', cli_version: '1' }),
    line('event_msg', { type: 'task_started', turn_id: 'done' }),
    message('user', 'Read'),
  ]
  assert.throws(
    () =>
      codexAdapter.convertSession(
        [...prefix, invalidMessage, line('event_msg', { type: 'task_complete' })].join('\n'),
      ),
    /supported payload.*line 4/,
  )
  assert.doesNotThrow(() =>
    codexAdapter.convertSession(
      [
        ...prefix,
        line('event_msg', { type: 'task_complete' }),
        line('event_msg', { type: 'task_started', turn_id: 'unfinished' }),
        invalidMessage,
      ].join('\n'),
    ),
  )
})
