import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dshAdapter } from '../extensions/dsh/index.ts'
import { validateTrace } from '../src/domain/validation.ts'
import { createDreamer } from '../src/index.ts'
import { parseOtelTrace } from '../src/trace/otel.ts'
import { requireValue } from './helpers.ts'

const header = (version = 4) =>
  JSON.stringify({
    type: 'session',
    version,
    id: 'session-one',
    createdAt: 1_760_000_000_000,
    cwd: '/workspace',
    isSeeded: false,
    delegationDepth: 0,
  })

const event = (
  seq: number,
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => JSON.stringify({ type, seq, time: 1_760_000_000_000 + seq, data, ...extra })

const message = (id: string, role: string, text: string) => ({
  id,
  role,
  source: { kind: role === 'assistant' ? 'model' : role === 'system' ? 'system-prompt' : 'user' },
  content: [{ type: 'text', text }],
})

const adapterOptions = { harnessVersion: 'dsh@test' }

function session(): string {
  return [
    header(),
    event(0, 'permission/preset', { preset: 'default' }),
    event(1, 'turn/start', { turn: 1 }),
    event(
      2,
      'system/message',
      { turn: 1, step: 0, message: message('system-one', 'system', 'Follow instructions.') },
      { surfaceOp: 'append' },
    ),
    event(3, 'user/message', message('user-one', 'user', 'Read the file.'), {
      surfaceOp: 'append',
    }),
    event(
      4,
      'assistant/message',
      {
        turn: 1,
        step: 0,
        message: {
          ...message('assistant-tools', 'assistant', ''),
          content: [
            { type: 'reasoning', text: 'Private reasoning' },
            { type: 'tool-call', id: 'call-one', name: 'read', arguments: { path: 'a.txt' } },
          ],
        },
      },
      { surfaceOp: 'append' },
    ),
    event(5, 'tool/call', {
      turn: 1,
      step: 0,
      callId: 'call-one',
      name: 'read',
      arguments: { path: 'a.txt' },
    }),
    event(
      6,
      'tool/result',
      {
        turn: 1,
        step: 0,
        message: {
          id: 'result-one',
          role: 'tool',
          toolCallId: 'call-one',
          source: { kind: 'tool', callId: 'call-one' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-one',
              content: [{ type: 'text', text: 'full file content' }],
              isError: false,
            },
          ],
        },
      },
      { surfaceOp: 'append', sourceEventSeqs: [5] },
    ),
    event(
      7,
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: message('assistant-final', 'assistant', 'Done.'),
      },
      { surfaceOp: 'append' },
    ),
    event(
      8,
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: {
          id: 'replacement',
          role: 'tool',
          toolCallId: 'call-one',
          source: { kind: 'tool', callId: 'call-one' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'call-one',
              content: [{ type: 'text', text: 'Replacement-only content' }],
              isError: false,
            },
          ],
        },
      },
      { surfaceOp: { op: 'replace', startSeq: 6, endSeq: 6 }, sourceEventSeqs: [6] },
    ),
    event(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(10, 'turn/start', { turn: 2 }),
    event(11, 'assistant/message', {}),
    event(12, 'turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    '',
  ].join('\n')
}

test('DSH adapter maps completed messages and tools with stable identities', () => {
  const traces = dshAdapter.convertSession(session(), { harnessVersion: 'dsh@0.2.0' })
  assert.deepEqual(dshAdapter.convertSession(session(), { harnessVersion: 'dsh@0.2.0' }), traces)
  assert.equal(traces.length, 1)
  const parsed = validateTrace(parseOtelTrace(traces[0]))
  assert.equal(parsed.harness_version, 'dsh@0.2.0')
  assert.equal(parsed.records.length, 7)
  assert.deepEqual(
    parsed.records.map((record) => record.kind),
    [
      'dsh.session',
      'gen_ai.system.message',
      'gen_ai.user.message',
      'gen_ai.tool.call',
      'gen_ai.tool.call.result',
      'gen_ai.assistant.message',
      'dsh.surface.replacement',
    ],
  )
  const call = requireValue(parsed.records.find((record) => record.kind === 'gen_ai.tool.call'))
  const result = requireValue(
    parsed.records.find((record) => record.kind === 'gen_ai.tool.call.result'),
  )
  assert.equal(result.parent_id, call.span_id)
  assert.equal(result.content, 'full file content')
  assert.equal(call.attributes?.['gen_ai.tool.name'], 'read')
  assert.equal(call.attributes?.['dsh.tool.started'], 'true')
  assert.equal(call.attributes?.['dsh.tool.call.event.seq'], '5')
  assert.equal(call.attributes?.['harness_rsi.scope'], 'in')
  assert.equal(result.attributes?.['harness_rsi.scope'], 'out')
  const replacement = requireValue(
    parsed.records.find((record) => record.kind === 'dsh.surface.replacement'),
  )
  assert.equal(replacement.content, 'Replacement-only content')
  assert.equal(replacement.attributes?.['harness_rsi.scope'], 'in')
  assert.doesNotMatch(JSON.stringify(parsed), /Private reasoning|aborted/i)
})

test('DSH adapter requires a harness version and roots unmatched results', () => {
  const jsonl = [
    header(),
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', message('user', 'user', 'Run it.'), { surfaceOp: 'append' }),
    event(
      2,
      'tool/result',
      {
        turn: 1,
        step: 0,
        message: {
          id: 'result',
          role: 'tool',
          toolCallId: 'missing',
          source: { kind: 'tool', callId: 'missing' },
          content: [
            {
              type: 'tool-result',
              toolCallId: 'missing',
              content: [{ type: 'text', text: 'known' }, 7, 'raw'],
              isError: true,
            },
          ],
        },
      },
      { surfaceOp: 'append' },
    ),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].join('\n')
  assert.throws(() => dshAdapter.convertSession(jsonl, undefined as never), /adapter options/)
  const parsed = validateTrace(parseOtelTrace(dshAdapter.convertSession(jsonl, adapterOptions)[0]))
  assert.equal(parsed.harness_version, 'dsh@test')
  assert.equal(parsed.records[2]?.parent_id, parsed.records[0]?.span_id)
  assert.equal(parsed.records[2]?.content, 'known\n7\nraw')
})

test('DSH adapter supports v3 user-role tool results', () => {
  const v3 = session()
    .replace('"version":4', '"version":3')
    .replaceAll('"role":"tool","toolCallId":"call-one","source"', '"role":"user","source"')
  const parsed = validateTrace(parseOtelTrace(dshAdapter.convertSession(v3, adapterOptions)[0]))
  assert.equal(parsed.harness_version, 'dsh@test')
  assert.equal(
    parsed.records.find((record) => record.kind === 'gen_ai.tool.call.result')?.content,
    'full file content',
  )
})

test('DSH adapter reads an exported session file without modifying it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-adapter-'))
  const path = join(directory, 'session.v4.jsonl')
  const jsonl = session()
  await writeFile(path, jsonl)
  assert.deepEqual(
    await dshAdapter.readSession(path, { harnessVersion: 'dsh@test' }),
    dshAdapter.convertSession(jsonl, { harnessVersion: 'dsh@test' }),
  )
  assert.equal(await readFile(path, 'utf8'), jsonl)
})

test('DSH adapter reports malformed and unsupported session inputs', async () => {
  assert.throws(() => dshAdapter.convertSession('{', adapterOptions), /JSON.*line 1/)
  assert.throws(() => dshAdapter.convertSession('', adapterOptions), /empty/)
  assert.throws(() => dshAdapter.convertSession(header(2), adapterOptions), /header/)
  assert.throws(() => dshAdapter.convertSession(session(), { harnessVersion: ' ' }), /nonempty/)
  assert.throws(
    () => dshAdapter.convertSession(session().replace('"seq":5', '"seq":6'), adapterOptions),
    /sequence.*expected 5, got 6/,
  )
  assert.throws(
    () =>
      dshAdapter.convertSession(
        [header(), event(0, 'turn/end', { turn: 1, reason: { kind: 'completed' } })].join('\n'),
        adapterOptions,
      ),
    /Unmatched DSH turn\/end/,
  )
  assert.throws(() => dshAdapter.convertSession(header(), adapterOptions), /completed turns/)

  const directory = await mkdtemp(join(tmpdir(), 'dsh-adapter-zstd-'))
  const path = join(directory, 'session.v4.jsonl.zstd')
  await writeFile(path, Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
  await assert.rejects(() => dshAdapter.readSession(path, adapterOptions), /use \/export/)
})

test('DSH validates supported payloads only in completed turns', () => {
  assert.doesNotThrow(() => dshAdapter.convertSession(session(), adapterOptions))
  const invalidCompleted = [
    header(),
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'assistant/message', {}, { surfaceOp: 'append' }),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].join('\n')
  assert.throws(
    () => dshAdapter.convertSession(invalidCompleted, adapterOptions),
    /assistant\/message.*line 3/,
  )
})

test('DSH preserves sequence order when wall-clock timestamps move backward', () => {
  const jsonl = [
    header(),
    event(0, 'turn/start', { turn: 1 }, { time: 200 }),
    event(1, 'user/message', message('user', 'user', 'First'), {
      surfaceOp: 'append',
      time: 300,
    }),
    event(
      2,
      'assistant/message',
      { turn: 1, step: 0, message: message('assistant', 'assistant', 'Second') },
      { surfaceOp: 'append', time: 100 },
    ),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 50 }),
  ].join('\n')
  const parsed = validateTrace(parseOtelTrace(dshAdapter.convertSession(jsonl, adapterOptions)[0]))
  const userTime = BigInt(requireValue(parsed.records[1]?.time))
  const assistantTime = BigInt(requireValue(parsed.records[2]?.time))
  assert.ok(userTime < assistantTime)
})

test('DSH retains requested tool calls that never start', () => {
  const jsonl = [
    header(),
    event(0, 'turn/start', { turn: 1 }),
    event(
      1,
      'assistant/message',
      {
        turn: 1,
        step: 0,
        message: {
          ...message('assistant', 'assistant', ''),
          content: [
            { type: 'tool-call', id: 'never-started', name: 'write', arguments: { path: 'a' } },
          ],
        },
      },
      { surfaceOp: 'append' },
    ),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].join('\n')
  const parsed = validateTrace(parseOtelTrace(dshAdapter.convertSession(jsonl, adapterOptions)[0]))
  const call = requireValue(parsed.records.find((record) => record.kind === 'gen_ai.tool.call'))
  assert.equal(call.attributes?.['dsh.tool.started'], 'false')
})

test('DSH rejects malformed surface operations and v4 result identities', () => {
  assert.throws(
    () =>
      dshAdapter.convertSession(
        session().replace('"surfaceOp":"append"', '"surfaceOp":"apend"'),
        adapterOptions,
      ),
    /surfaceOp/,
  )
  assert.throws(
    () =>
      dshAdapter.convertSession(
        session().replace('"toolCallId":"call-one"', '"toolCallId":"wrong"'),
        adapterOptions,
      ),
    /v4 tool\/result identity/,
  )
  assert.throws(
    () =>
      dshAdapter.convertSession(
        session().replace('"sourceEventSeqs":[6]', '"sourceEventSeqs":[7]'),
        adapterOptions,
      ),
    /replacement provenance/,
  )
  assert.throws(
    () =>
      dshAdapter.convertSession(
        session().replace('"sourceEventSeqs":[6]', '"sourceEventSeqs":[[0,9007199254740991]]'),
        adapterOptions,
      ),
    /replacement provenance/,
  )
  const wrongTurn = [
    header(),
    event(0, 'turn/start', { turn: 1 }),
    event(
      1,
      'assistant/message',
      { turn: 2, step: 0, message: message('assistant', 'assistant', 'Wrong turn') },
      { surfaceOp: 'append' },
    ),
    event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].join('\n')
  assert.throws(
    () => dshAdapter.convertSession(wrongTurn, adapterOptions),
    /does not match enclosing turn/,
  )
})

test('DSH rejects duplicate tool execution events', () => {
  const jsonl = [
    header(),
    event(0, 'turn/start', { turn: 1 }),
    event(
      1,
      'assistant/message',
      {
        turn: 1,
        step: 0,
        message: {
          ...message('assistant', 'assistant', ''),
          content: [{ type: 'tool-call', id: 'duplicate', name: 'read', arguments: {} }],
        },
      },
      { surfaceOp: 'append' },
    ),
    event(2, 'tool/call', {
      turn: 1,
      step: 0,
      callId: 'duplicate',
      name: 'read',
      arguments: {},
    }),
    event(3, 'tool/call', {
      turn: 1,
      step: 0,
      callId: 'duplicate',
      name: 'read',
      arguments: {},
    }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].join('\n')
  assert.throws(() => dshAdapter.convertSession(jsonl, adapterOptions), /Duplicate DSH tool\/call/)

  const resultBeforeCall = [
    header(),
    event(0, 'turn/start', { turn: 1 }),
    event(
      1,
      'tool/result',
      {
        turn: 1,
        step: 0,
        message: {
          id: 'early-result',
          role: 'tool',
          toolCallId: 'late-call',
          source: { kind: 'tool', callId: 'late-call' },
          content: [{ type: 'tool-result', toolCallId: 'late-call', content: [], isError: true }],
        },
      },
      { surfaceOp: 'append' },
    ),
    event(2, 'tool/call', {
      turn: 1,
      step: 0,
      callId: 'late-call',
      name: 'read',
      arguments: {},
    }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ].join('\n')
  assert.throws(
    () => dshAdapter.convertSession(resultBeforeCall, adapterOptions),
    /tool\/call follows its result/,
  )
})

test('converted DSH traces work with framework enrichment and dreaming', async () => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), 'dsh-dream-'))
  const result = await createDreamer({
    stages: {
      enrichTrace: (trace) => {
        const lastRecord = requireValue(trace.records.at(-1))
        return {
          evaluations: [
            { name: 'test/v1', value: 0, target: 1, time: requireValue(lastRecord.time) },
          ],
        }
      },
      proposeSpec: ({ views }) => {
        assert.equal(views[0]?.harness_version, 'dsh@test')
        assert.equal(views[0]?.records.at(-1)?.kind, 'gen_ai.evaluation.result')
        return { kind: 'no_proposal', reason: 'DSH conversion verified' }
      },
      evaluateSpec: () => {
        throw new Error('No proposal to evaluate')
      },
    },
  }).dream(dshAdapter.convertSession(session(), adapterOptions), { workspaceDirectory })
  assert.deepEqual(result, { kind: 'no_proposal', reason: 'DSH conversion verified' })
})
