import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

import { z } from 'zod'

const nonempty = z.string().refine((value) => value.trim() !== '', 'must be nonempty')
const jsonObject = z.custom<Record<string, unknown>>(
  (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
)
const headerSchema = z.object({
  type: z.literal('session'),
  version: z.number().int().min(3).max(4),
  id: nonempty,
  createdAt: z.number().int().nonnegative(),
})
const eventSchema = z.object({
  type: z.string(),
  seq: z.number().int().nonnegative(),
  time: z.number().int().nonnegative(),
  data: jsonObject,
  surfaceOp: z.unknown().optional(),
  sourceEventSeqs: z.unknown().optional(),
})
type SessionEvent = z.infer<typeof eventSchema> & { position: number }
const turnStartSchema = z.object({ turn: z.number().int().nonnegative() })
const turnEndSchema = z.object({
  turn: z.number().int().nonnegative(),
  reason: z.object({ kind: z.string() }),
})
const appendSurfaceSchema = z.literal('append')
const replaceSurfaceSchema = z
  .strictObject({
    op: z.literal('replace'),
    startSeq: z.number().int().nonnegative(),
    endSeq: z.number().int().nonnegative(),
  })
  .refine((value) => value.startSeq <= value.endSeq, 'replacement range must be ordered')
const surfaceOpSchema = z.union([appendSurfaceSchema, replaceSurfaceSchema])
type SurfaceOp = z.infer<typeof surfaceOpSchema>
const messageSchema = z.object({
  id: nonempty,
  role: z.enum(['user', 'assistant', 'developer', 'system']),
  content: z.array(jsonObject),
})
const wrappedMessageSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative().optional(),
  message: messageSchema,
})
const toolCallBlockSchema = z.object({
  type: z.literal('tool-call'),
  id: nonempty,
  name: nonempty,
  arguments: z.unknown().optional(),
})
const callSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative().optional(),
  callId: nonempty,
  name: nonempty,
  arguments: z.unknown().optional(),
})
const resultMessageSchema = z.object({
  id: nonempty,
  role: z.enum(['tool', 'user']),
  toolCallId: nonempty.optional(),
  source: z.object({ kind: z.literal('tool'), callId: nonempty }),
  content: z.array(jsonObject),
})
const resultSchema = z.object({
  turn: z.number().int().nonnegative(),
  step: z.number().int().nonnegative().optional(),
  message: resultMessageSchema,
})
const adapterOptionsSchema = z.strictObject({ harnessVersion: nonempty })

export interface DshAdapterOptions {
  /** Deployed DSH release, build, or configuration identifier. */
  harnessVersion: string
}

type Attribute = ReturnType<typeof attribute>
type Span = ReturnType<typeof span>
type CallRecord = {
  record: Span
  name: string
  arguments: unknown
  started: boolean
  seq: number
  step: number | undefined
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
  attributes: Attribute[],
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

function parseLines(jsonl: string): {
  header: z.infer<typeof headerSchema>
  events: SessionEvent[]
} {
  const values: Array<{ position: number; value: unknown }> = []
  for (const [position, raw] of jsonl.split('\n').entries()) {
    if (raw.trim() === '') continue
    try {
      values.push({ position, value: JSON.parse(raw) })
    } catch {
      throw new Error(`Invalid DSH JSON at line ${position + 1}`)
    }
  }
  const first = values[0]
  if (first === undefined) throw new Error('DSH session log is empty')
  const header = headerSchema.safeParse(first.value)
  if (!header.success) {
    throw new Error(
      `Invalid DSH session header at line ${first.position + 1}: ${header.error.message}`,
    )
  }
  const events: SessionEvent[] = []
  for (const entry of values.slice(1)) {
    const parsed = eventSchema.safeParse(entry.value)
    if (!parsed.success) {
      throw new Error(`Invalid DSH event at line ${entry.position + 1}: ${parsed.error.message}`)
    }
    const expectedSeq = events.length
    if (parsed.data.seq !== expectedSeq) {
      throw new Error(
        `Invalid DSH event sequence at line ${entry.position + 1}: expected ${expectedSeq}, got ${parsed.data.seq}`,
      )
    }
    events.push({ ...parsed.data, position: entry.position })
  }
  return { header: header.data, events }
}

function completedEvents(events: SessionEvent[]): Array<{ event: SessionEvent; turn: number }> {
  const completed: Array<{ event: SessionEvent; turn: number }> = []
  let active: { turn: number; events: SessionEvent[] } | undefined
  for (const event of events) {
    if (event.type === 'turn/start') {
      const parsed = turnStartSchema.safeParse(event.data)
      if (!parsed.success) {
        throw new Error(
          `Invalid DSH turn/start at line ${event.position + 1}: ${parsed.error.message}`,
        )
      }
      if (active !== undefined)
        throw new Error(`Nested DSH turn/start at line ${event.position + 1}`)
      active = { turn: parsed.data.turn, events: [] }
      continue
    }
    if (event.type === 'turn/end') {
      const parsed = turnEndSchema.safeParse(event.data)
      if (!parsed.success) {
        throw new Error(
          `Invalid DSH turn/end at line ${event.position + 1}: ${parsed.error.message}`,
        )
      }
      if (active === undefined || active.turn !== parsed.data.turn) {
        throw new Error(`Unmatched DSH turn/end at line ${event.position + 1}`)
      }
      if (parsed.data.reason.kind === 'completed') {
        const completedTurn = active
        completed.push(
          ...completedTurn.events.map((item) => ({ event: item, turn: completedTurn.turn })),
        )
      }
      active = undefined
      continue
    }
    if (active !== undefined) active.events.push(event)
  }
  return completed
}

function monotonicEventTimes(
  events: ReadonlyArray<{ event: SessionEvent }>,
): ReadonlyMap<number, string> {
  const result = new Map<number, string>()
  let previous = -1n
  for (const { event } of events) {
    const wallTime = BigInt(event.time) * 1_000_000n
    const time = wallTime > previous ? wallTime : previous + 1n
    result.set(event.seq, time.toString())
    previous = time
  }
  return result
}

function serialized(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function renderValue(value: unknown): string {
  if (!Array.isArray(value)) return serialized(value)
  return value
    .map((part) => {
      if (typeof part === 'object' && part !== null && !Array.isArray(part)) {
        const block = part as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string') return block.text
      }
      return serialized(part)
    })
    .join('\n')
}

function renderContent(
  blocks: readonly Record<string, unknown>[],
  excludedTypes: ReadonlySet<string> = new Set(),
): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block.type === 'string' && excludedTypes.has(block.type)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(serialized(block))
  }
  return parts.join('\n')
}

function renderToolResult(content: readonly Record<string, unknown>[]): string {
  const blocks = content.filter((block) => block.type === 'tool-result')
  if (blocks.length === 0) return renderContent(content)
  return blocks.map((block) => renderValue(block.content)).join('\n')
}

function parseSurfaceOp(event: SessionEvent): SurfaceOp {
  const parsed = surfaceOpSchema.safeParse(event.surfaceOp)
  if (!parsed.success) {
    throw new Error(`Invalid DSH surfaceOp at line ${event.position + 1}: ${parsed.error.message}`)
  }
  return parsed.data
}

function replacementSourceSeqs(
  event: SessionEvent,
  operation: Exclude<SurfaceOp, 'append'>,
): number[] {
  if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
    throw new Error(`Invalid DSH replacement provenance at line ${event.position + 1}`)
  }
  const result: number[] = []
  for (const entry of event.sourceEventSeqs) {
    if (Number.isSafeInteger(entry) && Number(entry) >= 0) {
      result.push(Number(entry))
      continue
    }
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !Number.isSafeInteger(entry[0]) ||
      !Number.isSafeInteger(entry[1]) ||
      Number(entry[0]) < 0 ||
      Number(entry[0]) > Number(entry[1]) ||
      Number(entry[1]) >= event.seq
    ) {
      throw new Error(`Invalid DSH replacement provenance at line ${event.position + 1}`)
    }
    for (let seq = Number(entry[0]); seq <= Number(entry[1]); seq++) result.push(seq)
  }
  if (
    result.some((seq, index) => {
      const previous = result[index - 1]
      return seq >= event.seq || (previous !== undefined && seq <= previous)
    }) ||
    !result.includes(operation.startSeq) ||
    !result.includes(operation.endSeq)
  ) {
    throw new Error(`Invalid DSH replacement provenance at line ${event.position + 1}`)
  }
  return result
}

function assertEventTurn(event: SessionEvent, eventTurn: number, enclosingTurn: number): void {
  if (eventTurn !== enclosingTurn) {
    throw new Error(
      `DSH ${event.type} turn ${eventTurn} does not match enclosing turn ${enclosingTurn} at line ${event.position + 1}`,
    )
  }
}

function surfaceAttributes(
  operation: Exclude<SurfaceOp, 'append'>,
  eventType: string,
  sourceEventSeqs: readonly number[],
) {
  return [
    attribute('dsh.surface.operation', 'replace'),
    attribute('dsh.surface.event.type', eventType),
    attribute('dsh.surface.start_seq', String(operation.startSeq)),
    attribute('dsh.surface.end_seq', String(operation.endSeq)),
    attribute('dsh.surface.source_event_seqs', JSON.stringify(sourceEventSeqs)),
  ]
}

function eventAttributes(event: SessionEvent, turn: number) {
  const step = event.data.step
  return [
    attribute('dsh.event.seq', String(event.seq)),
    attribute('dsh.turn', String(turn)),
    ...(typeof step === 'number' ? [attribute('dsh.step', String(step))] : []),
  ]
}

function setStringAttribute(record: Span, key: string, value: string): void {
  const existing = record.attributes.find((item) => item.key === key)
  if (existing === undefined) record.attributes.push(attribute(key, value))
  else existing.value.stringValue = value
}

function validateResultMessage(
  version: number,
  event: SessionEvent,
  message: z.infer<typeof resultMessageSchema>,
): void {
  const callId = message.source.callId
  if (version === 4) {
    if (message.role !== 'tool' || message.toolCallId !== callId) {
      throw new Error(
        `Invalid DSH v4 tool/result identity at line ${event.position + 1}: expected tool role and matching toolCallId`,
      )
    }
  } else if (message.role !== 'user' || message.toolCallId !== undefined) {
    throw new Error(
      `Invalid DSH v3 tool/result identity at line ${event.position + 1}: expected user role without message toolCallId`,
    )
  }
  for (const block of message.content) {
    if (block.type !== 'tool-result') continue
    if (block.toolCallId !== callId) {
      throw new Error(`Invalid DSH tool/result block identity at line ${event.position + 1}`)
    }
  }
}

/** Convert one uncompressed DSH v3/v4 Session JSONL log into one OTLP trace. */
export function convertSession(jsonl: string, options: DshAdapterOptions) {
  const parsedOptions = adapterOptionsSchema.safeParse(options)
  if (!parsedOptions.success)
    throw new Error(`Invalid DSH adapter options: ${parsedOptions.error.message}`)
  const { header, events } = parseLines(jsonl)
  const harnessVersion = parsedOptions.data.harnessVersion
  const completed = completedEvents(events)
  const eventTimes = monotonicEventTimes(completed)
  const traceId = identifier(`dsh:${header.id}`, 32)
  const rootId = identifier(`${traceId}:root`, 16)
  const spans: Span[] = []
  const calls = new Map<string, CallRecord>()
  const completedResults = new Set<string>()
  const seenResults = new Set<string>()
  const excludedAssistantBlocks = new Set(['reasoning', 'tool-call'])
  const excludedReplacementBlocks = new Set(['reasoning'])

  for (const { event, turn } of completed) {
    const time = eventTimes.get(event.seq)
    if (time === undefined) throw new Error(`Missing DSH event time for seq ${event.seq}`)
    const baseAttributes = eventAttributes(event, turn)
    if (
      event.type === 'user/message' ||
      event.type === 'assistant/message' ||
      event.type === 'developer/message' ||
      event.type === 'system/message'
    ) {
      const operation = parseSurfaceOp(event)
      let message: z.infer<typeof messageSchema>
      let messageStep: number | undefined
      if (event.type === 'user/message') {
        const parsed = messageSchema.safeParse(event.data)
        if (!parsed.success) {
          throw new Error(
            `Invalid DSH ${event.type} at line ${event.position + 1}: ${parsed.error.message}`,
          )
        }
        message = parsed.data
      } else {
        const parsed = wrappedMessageSchema.safeParse(event.data)
        if (!parsed.success) {
          throw new Error(
            `Invalid DSH ${event.type} at line ${event.position + 1}: ${parsed.error.message}`,
          )
        }
        assertEventTurn(event, parsed.data.turn, turn)
        message = parsed.data.message
        messageStep = parsed.data.step
      }
      const expectedRole = event.type.slice(0, event.type.indexOf('/'))
      if (message.role !== expectedRole) {
        throw new Error(`Invalid DSH ${event.type} role at line ${event.position + 1}`)
      }
      if (operation !== 'append') {
        const sourceEventSeqs = replacementSourceSeqs(event, operation)
        spans.push(
          span(
            traceId,
            identifier(`${traceId}:${event.seq}:replacement`, 16),
            rootId,
            'dsh.surface.replacement',
            time,
            [
              attribute('harness_rsi.scope', 'in'),
              attribute(
                'gen_ai.message.content',
                renderContent(message.content, excludedReplacementBlocks),
              ),
              attribute('dsh.message.id', message.id),
              ...surfaceAttributes(operation, event.type, sourceEventSeqs),
              ...baseAttributes,
            ],
          ),
        )
        continue
      }
      const content = renderContent(
        message.content,
        event.type === 'assistant/message' ? excludedAssistantBlocks : undefined,
      )
      if (event.type !== 'assistant/message' || content !== '') {
        spans.push(
          span(
            traceId,
            identifier(`${traceId}:${event.seq}:message`, 16),
            rootId,
            `gen_ai.${message.role}.message`,
            time,
            [
              attribute('harness_rsi.scope', message.role === 'assistant' ? 'in' : 'out'),
              attribute('gen_ai.message.content', content),
              attribute('dsh.message.id', message.id),
              ...baseAttributes,
            ],
          ),
        )
      }
      if (event.type === 'assistant/message') {
        for (const [index, block] of message.content.entries()) {
          if (block.type !== 'tool-call') continue
          const parsed = toolCallBlockSchema.safeParse(block)
          if (!parsed.success) {
            throw new Error(
              `Invalid DSH assistant tool-call at line ${event.position + 1}: ${parsed.error.message}`,
            )
          }
          const callKey = JSON.stringify([turn, parsed.data.id])
          if (seenResults.has(callKey)) {
            throw new Error(
              `DSH assistant tool-call follows its result at line ${event.position + 1}`,
            )
          }
          if (calls.has(callKey)) {
            throw new Error(`Duplicate DSH assistant tool-call at line ${event.position + 1}`)
          }
          const record = span(
            traceId,
            identifier(`${traceId}:${event.seq}:tool:${index}`, 16),
            rootId,
            'gen_ai.tool.call',
            time,
            [
              attribute('harness_rsi.scope', 'in'),
              attribute('gen_ai.tool.name', parsed.data.name),
              attribute('gen_ai.tool.call.arguments', serialized(parsed.data.arguments)),
              attribute('dsh.tool.call.id', parsed.data.id),
              attribute('dsh.tool.started', 'false'),
              attribute('dsh.message.id', message.id),
              attribute('dsh.message.block.index', String(index)),
              ...baseAttributes,
            ],
          )
          spans.push(record)
          calls.set(callKey, {
            record,
            name: parsed.data.name,
            arguments: parsed.data.arguments,
            started: false,
            seq: event.seq,
            step: messageStep,
          })
        }
      }
      continue
    }
    if (event.type === 'tool/call') {
      const parsed = callSchema.safeParse(event.data)
      if (!parsed.success) {
        throw new Error(
          `Invalid DSH tool/call at line ${event.position + 1}: ${parsed.error.message}`,
        )
      }
      assertEventTurn(event, parsed.data.turn, turn)
      const callKey = JSON.stringify([turn, parsed.data.callId])
      if (seenResults.has(callKey)) {
        throw new Error(`DSH tool/call follows its result at line ${event.position + 1}`)
      }
      const requested = calls.get(callKey)
      if (requested !== undefined) {
        if (requested.started) {
          throw new Error(`Duplicate DSH tool/call at line ${event.position + 1}`)
        }
        if (
          requested.seq >= event.seq ||
          requested.step !== parsed.data.step ||
          requested.name !== parsed.data.name ||
          !isDeepStrictEqual(requested.arguments, parsed.data.arguments)
        ) {
          throw new Error(
            `DSH tool/call differs from its assistant request at line ${event.position + 1}`,
          )
        }
        requested.started = true
        setStringAttribute(requested.record, 'dsh.tool.started', 'true')
        setStringAttribute(requested.record, 'dsh.tool.call.event.seq', String(event.seq))
        continue
      }
      const record = span(
        traceId,
        identifier(`${traceId}:${event.seq}:call`, 16),
        rootId,
        'gen_ai.tool.call',
        time,
        [
          attribute('harness_rsi.scope', 'in'),
          attribute('gen_ai.tool.name', parsed.data.name),
          attribute('gen_ai.tool.call.arguments', serialized(parsed.data.arguments)),
          attribute('dsh.tool.call.id', parsed.data.callId),
          attribute('dsh.tool.started', 'true'),
          ...baseAttributes,
        ],
      )
      spans.push(record)
      calls.set(callKey, {
        record,
        name: parsed.data.name,
        arguments: parsed.data.arguments,
        started: true,
        seq: event.seq,
        step: parsed.data.step,
      })
      continue
    }
    if (event.type === 'tool/result') {
      const operation = parseSurfaceOp(event)
      const parsed = resultSchema.safeParse(event.data)
      if (!parsed.success) {
        throw new Error(
          `Invalid DSH tool/result at line ${event.position + 1}: ${parsed.error.message}`,
        )
      }
      assertEventTurn(event, parsed.data.turn, turn)
      validateResultMessage(header.version, event, parsed.data.message)
      const callId = parsed.data.message.source.callId
      const callKey = JSON.stringify([turn, callId])
      const replacement = operation !== 'append'
      const replacementAttributes =
        operation === 'append'
          ? []
          : surfaceAttributes(operation, event.type, replacementSourceSeqs(event, operation))
      if (!replacement && completedResults.has(callKey)) {
        throw new Error(`Duplicate DSH tool/result at line ${event.position + 1}`)
      }
      if (!replacement) completedResults.add(callKey)
      seenResults.add(callKey)
      const call = calls.get(callKey)
      if (call !== undefined && call.seq >= event.seq) {
        throw new Error(`DSH tool/result precedes its call at line ${event.position + 1}`)
      }
      if (!replacement && call !== undefined && call.step !== parsed.data.step) {
        throw new Error(
          `DSH tool/result step does not match its call at line ${event.position + 1}`,
        )
      }
      const record = span(
        traceId,
        identifier(`${traceId}:${event.seq}:${replacement ? 'replacement' : 'result'}`, 16),
        call?.record.spanId ?? rootId,
        replacement ? 'dsh.surface.replacement' : 'gen_ai.tool.call.result',
        time,
        [
          attribute('harness_rsi.scope', replacement ? 'in' : 'out'),
          attribute('gen_ai.tool.call.result', renderToolResult(parsed.data.message.content)),
          attribute('dsh.message.id', parsed.data.message.id),
          attribute('dsh.tool.call.id', callId),
          ...replacementAttributes,
          ...baseAttributes,
        ],
      )
      spans.push(record)
    }
  }

  if (spans.length === 0) {
    throw new Error('DSH session has no supported records in completed turns')
  }
  const times = spans.map((record) => BigInt(record.startTimeUnixNano))
  const start = times.reduce((left, right) => (left < right ? left : right))
  const end = times.reduce((left, right) => (left > right ? left : right)) + 1n
  const root = span(traceId, rootId, undefined, 'dsh.session', start.toString(), [
    attribute('dsh.session.id', header.id),
    attribute('dsh.session.format.version', String(header.version)),
  ])
  root.endTimeUnixNano = end.toString()
  return [
    {
      resourceSpans: [
        {
          resource: {
            attributes: [attribute('harness_rsi.harness.version', harnessVersion)],
          },
          scopeSpans: [
            { scope: { name: 'dreaming-framework.extensions.dsh' }, spans: [root, ...spans] },
          ],
        },
      ],
    },
  ]
}

/** Read one uncompressed DSH Session JSONL file without modifying it. */
export async function readSession(path: string, options: DshAdapterOptions) {
  if (path.endsWith('.zstd')) {
    throw new Error(
      'Compressed DSH session logs are not supported; use /export in DSH, extract the ZIP, and pass session.vN.jsonl',
    )
  }
  const bytes = await readFile(path)
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    throw new Error(
      'Compressed DSH session logs are not supported; use /export in DSH, extract the ZIP, and pass session.vN.jsonl',
    )
  }
  let jsonl: string
  try {
    jsonl = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`${path}: DSH session log is not valid UTF-8`)
  }
  return convertSession(jsonl, options)
}
