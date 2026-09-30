import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { z } from 'zod'

const nonempty = z.string().refine((value) => value.trim() !== '', 'must be nonempty')
const recordSchema = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z.custom<Record<string, unknown>>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  ),
})
const sessionLineSchema = recordSchema.extend({ position: z.number().int().nonnegative() })
type SessionLine = z.infer<typeof sessionLineSchema>
const metadataSchema = z.object({
  id: nonempty.optional(),
  session_id: nonempty.optional(),
  cli_version: nonempty,
})
const startedSchema = z.object({ type: z.literal('task_started'), turn_id: nonempty })
const messageSchema = z.object({
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'developer', 'system']),
  content: z.array(z.looseObject({ text: z.string().optional() })).optional(),
  phase: z.string().optional(),
})
const callSchema = z.object({
  type: z.enum(['function_call', 'custom_tool_call']),
  call_id: nonempty,
  name: nonempty,
  input: z.unknown().optional(),
  arguments: z.unknown().optional(),
})
const resultSchema = z.object({
  type: z.enum(['function_call_output', 'custom_tool_call_output']),
  call_id: nonempty,
  output: z.unknown().optional(),
})

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
    const parsed = recordSchema.safeParse(value)
    if (!parsed.success)
      throw new Error(`Invalid Codex record at line ${position + 1}: ${parsed.error.message}`)
    result.push({ position, ...parsed.data })
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
        const parsed = startedSchema.safeParse(line.payload)
        if (!parsed.success)
          throw new Error(
            `Missing Codex turn identifier at line ${line.position + 1}: ${parsed.error.message}`,
          )
        active = parsed.data.turn_id
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
  if (!nonempty.safeParse(sessionId).success) {
    throw new Error('Codex session metadata has no session identifier')
  }
  const parsedMetadata = metadataSchema.safeParse(metadata)
  if (!parsedMetadata.success) {
    throw new Error('Codex session metadata has no CLI version')
  }
  const traceId = identifier(`codex:${sessionId}`, 32)
  const rootId = identifier(`${traceId}:root`, 16)
  const spans: ReturnType<typeof span>[] = []
  const calls = new Map<string, string>()
  const results: Array<{ record: ReturnType<typeof span>; callKey: string }> = []
  for (const { line, turn } of completedItems(records)) {
    const rawPayload = line.payload
    const isMessage = rawPayload.type === 'message'
    const isCall = rawPayload.type === 'function_call' || rawPayload.type === 'custom_tool_call'
    const isResult =
      rawPayload.type === 'function_call_output' || rawPayload.type === 'custom_tool_call_output'
    if (!isMessage && !isCall && !isResult) continue
    const parsedPayload = (
      isMessage ? messageSchema : isCall ? callSchema : resultSchema
    ).safeParse(rawPayload)
    if (!parsedPayload.success)
      throw new Error(
        `Invalid Codex supported payload at line ${line.position + 1}: ${parsedPayload.error.message}`,
      )
    const payload = parsedPayload.data
    const milliseconds = Date.parse(line.timestamp)
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error(`Invalid Codex timestamp at line ${line.position + 1}`)
    }
    const time = (BigInt(milliseconds) * 1_000_000n + BigInt(line.position)).toString()
    const spanId = identifier(`${traceId}:${line.position}`, 16)
    if (payload.type === 'message') {
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
    const callKey = JSON.stringify([turn, payload.call_id])
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      calls.set(callKey, spanId)
      spans.push(
        span(traceId, spanId, rootId, 'gen_ai.tool.call', time, [
          attribute('harness_rsi.scope', 'in'),
          attribute('gen_ai.tool.name', payload.name),
          attribute('gen_ai.tool.call.arguments', serialized(payload.input ?? payload.arguments)),
        ]),
      )
    } else if (
      payload.type === 'function_call_output' ||
      payload.type === 'custom_tool_call_output'
    ) {
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
              attribute(
                'harness_rsi.harness.version',
                `codex-cli@${parsedMetadata.data.cli_version}`,
              ),
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
