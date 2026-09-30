import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

interface SessionLine {
  position: number
  timestamp: string
  type: string
  payload: Record<string, unknown>
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identifier(value: string, length: number): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

function attribute(key: string, value: string) {
  return { key, value: { stringValue: value } }
}

function span(
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  name: string,
  time: string,
  attributes: ReturnType<typeof attribute>[],
) {
  return {
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name,
    startTimeUnixNano: time,
    endTimeUnixNano: (BigInt(time) + 1n).toString(),
    attributes,
  }
}

function lines(jsonl: string): SessionLine[] {
  const result: SessionLine[] = []
  for (const [position, raw] of jsonl.split('\n').entries()) {
    if (raw.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error(`Invalid Codex JSON at line ${position + 1}`)
    }
    if (
      !object(value) ||
      typeof value.timestamp !== 'string' ||
      typeof value.type !== 'string' ||
      !object(value.payload)
    ) {
      throw new Error(`Invalid Codex record at line ${position + 1}`)
    }
    result.push({ position, timestamp: value.timestamp, type: value.type, payload: value.payload })
  }
  return result
}

function completedItems(records: SessionLine[]): Array<{ line: SessionLine; turn: string }> {
  const completed = new Set<string>()
  const items: Array<{ line: SessionLine; turn: string }> = []
  let active: string | undefined
  for (const line of records) {
    if (line.type === 'event_msg') {
      if (line.payload.type === 'task_started') {
        const turn = line.payload.turn_id
        if (typeof turn !== 'string' || turn.trim() === '') {
          throw new Error(`Missing Codex turn identifier at line ${line.position + 1}`)
        }
        active = turn
      } else if (line.payload.type === 'task_complete') {
        if (
          active !== undefined &&
          (line.payload.turn_id === undefined || line.payload.turn_id === active)
        ) {
          completed.add(active)
        }
        active = undefined
      } else if (line.payload.type === 'task_aborted' || line.payload.type === 'turn_aborted') {
        active = undefined
      }
    } else if (line.type === 'response_item' && active !== undefined) {
      items.push({ line, turn: active })
    }
  }
  return items.filter(({ turn }) => completed.has(turn))
}

function textContent(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return ''
  return payload.content
    .filter((part): part is { text: string } => object(part) && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function serialized(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

/** Convert one Codex session into one OTLP trace containing its completed turns. */
export function convertSession(jsonl: string) {
  const records = lines(jsonl)
  const metadata = records.find((line) => line.type === 'session_meta')?.payload
  const sessionId = metadata?.session_id ?? metadata?.id
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new Error('Codex session metadata has no session identifier')
  }
  if (typeof metadata?.cli_version !== 'string' || metadata.cli_version.trim() === '') {
    throw new Error('Codex session metadata has no CLI version')
  }
  const traceId = identifier(`codex:${sessionId}`, 32)
  const rootId = identifier(`${traceId}:root`, 16)
  const spans: ReturnType<typeof span>[] = []
  const calls = new Map<string, string>()
  const results: Array<{ record: ReturnType<typeof span>; callKey: string }> = []
  for (const { line, turn } of completedItems(records)) {
    const payload = line.payload
    const isMessage =
      payload.type === 'message' &&
      ['user', 'assistant', 'developer', 'system'].includes(String(payload.role))
    const isCall = payload.type === 'function_call' || payload.type === 'custom_tool_call'
    const isResult =
      payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output'
    if (!isMessage && !isCall && !isResult) continue
    const milliseconds = Date.parse(line.timestamp)
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error(`Invalid Codex timestamp at line ${line.position + 1}`)
    }
    const time = (BigInt(milliseconds) * 1_000_000n + BigInt(line.position)).toString()
    const spanId = identifier(`${traceId}:${line.position}`, 16)
    if (isMessage) {
      const role = String(payload.role)
      spans.push(
        span(traceId, spanId, rootId, `gen_ai.${role}.message`, time, [
          attribute('harness_rsi.scope', role === 'assistant' ? 'in' : 'out'),
          attribute('gen_ai.message.content', textContent(payload)),
          ...(typeof payload.phase === 'string'
            ? [attribute('codex.message.phase', payload.phase)]
            : []),
        ]),
      )
      continue
    }
    if (typeof payload.call_id !== 'string' || payload.call_id.trim() === '') {
      throw new Error(`Missing Codex tool call identifier at line ${line.position + 1}`)
    }
    const callKey = JSON.stringify([turn, payload.call_id])
    if (isCall) {
      if (typeof payload.name !== 'string' || payload.name.trim() === '') {
        throw new Error(`Missing Codex tool name at line ${line.position + 1}`)
      }
      calls.set(callKey, spanId)
      spans.push(
        span(traceId, spanId, rootId, 'gen_ai.tool.call', time, [
          attribute('harness_rsi.scope', 'in'),
          attribute('gen_ai.tool.name', payload.name),
          attribute('gen_ai.tool.call.arguments', serialized(payload.input ?? payload.arguments)),
        ]),
      )
    } else {
      const record = span(traceId, spanId, rootId, 'gen_ai.tool.call.result', time, [
        attribute('harness_rsi.scope', 'out'),
        attribute('gen_ai.tool.call.result', serialized(payload.output)),
      ])
      spans.push(record)
      results.push({ record, callKey })
    }
  }
  if (spans.length === 0)
    throw new Error('Codex session has no supported records in completed turns')
  for (const { record, callKey } of results) record.parentSpanId = calls.get(callKey) ?? rootId
  const times = spans.map((record) => BigInt(record.startTimeUnixNano))
  const start = times.reduce((a, b) => (a < b ? a : b))
  const end = times.reduce((a, b) => (a > b ? a : b)) + 1n
  const root = span(traceId, rootId, undefined, 'codex.session', start.toString(), [])
  root.endTimeUnixNano = end.toString()
  return [
    {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attribute('harness_rsi.harness.version', `codex-cli@${metadata.cli_version}`),
            ],
          },
          scopeSpans: [
            { scope: { name: 'dreaming-framework.extensions.codex' }, spans: [root, ...spans] },
          ],
        },
      ],
    },
  ]
}

export async function readSession(path: string) {
  return convertSession(await readFile(path, 'utf8'))
}
