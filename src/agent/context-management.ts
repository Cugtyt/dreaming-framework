import {
  asSchema,
  generateText,
  type LanguageModelCallEndEvent,
  type LanguageModelCallStartEvent,
  type ModelMessage,
  Output,
  type PrepareStepFunction,
  type ToolSet,
} from 'ai'
import { type ContextSummary, SUMMARY_INSTRUCTIONS, summarySchema } from './checkpoint.ts'
import type { ModelTrace } from './model-trace.ts'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000
export const TRIGGER_MARGIN_TOKENS = 10_000
export const SUMMARY_MAX_OUTPUT_TOKENS = 4_000

export function estimateContextTokens(input: {
  instructions: unknown
  messages: ModelMessage[]
  tools: unknown
  outputSchema: unknown
  previous?: { messages: ModelMessage[]; inputTokens: number }
}): number {
  // UTF-8 bytes / 3 is a fallback estimate, not a provider tokenizer.
  const previous = input.previous
  if (
    previous &&
    input.messages.length >= previous.messages.length &&
    previous.messages.every(
      (message, index) => JSON.stringify(message) === JSON.stringify(input.messages[index]),
    )
  ) {
    return (
      previous.inputTokens +
      Math.ceil(
        Buffer.byteLength(JSON.stringify(input.messages.slice(previous.messages.length)), 'utf8') /
          3,
      )
    )
  }
  return Math.ceil(
    Buffer.byteLength(
      JSON.stringify({
        instructions: input.instructions,
        messages: input.messages,
        tools: input.tools,
        outputSchema: input.outputSchema,
      }),
      'utf8',
    ) / 3,
  )
}

export function createContextManagement<TOOLS extends ToolSet>(
  contextWindowTokens: number,
  trace: Pick<ModelTrace, 'summaryCallbacks' | 'recordCompaction'>,
  settings: {
    tools: TOOLS
    output: Pick<Output.Output<unknown, unknown, unknown>, 'responseFormat'>
  },
) {
  let previous: { messages: ModelMessage[]; inputTokens: number } | undefined
  let requestMessages: ModelMessage[] = []
  const threshold = contextWindowTokens - TRIGGER_MARGIN_TOKENS

  const toolSchemas = Promise.all(
    Object.entries(settings.tools).map(async ([name, value]) => ({
      name,
      description: value.description,
      inputSchema: await asSchema(value.inputSchema).jsonSchema,
    })),
  )
  const outputFormat = settings.output.responseFormat

  const prepareStep: PrepareStepFunction<TOOLS> = async ({
    messages,
    initialMessages,
    instructions,
    model,
  }) => {
    const tools = await toolSchemas
    const outputSchema = await outputFormat
    const beforeTokens = estimateContextTokens({
      instructions,
      messages,
      tools,
      outputSchema,
      ...(previous === undefined ? {} : { previous }),
    })
    if (beforeTokens < threshold) return

    let recentStart = messages.length - 1
    while (recentStart >= 0 && messages[recentStart]?.role !== 'assistant') recentStart--
    const recent = recentStart < 0 ? [] : messages.slice(recentStart)
    const calls = new Set<string>()
    const results = new Set<string>()
    for (const message of recent) {
      if (typeof message.content === 'string') continue
      for (const part of message.content) {
        if (part.type === 'tool-call') calls.add(part.toolCallId)
        if (part.type === 'tool-result') results.add(part.toolCallId)
      }
    }
    if (
      calls.size === 0 ||
      calls.size !== results.size ||
      [...calls].some((id) => !results.has(id))
    ) {
      throw new Error('Cannot compact context without a complete recent tool round')
    }
    const older = messages.slice(initialMessages.length, recentStart)
    if (older.length === 0) {
      throw new Error(
        'Recent tool round cannot fit the context budget with 10000 tokens of headroom',
      )
    }

    const summaryInstructions = `${SUMMARY_INSTRUCTIONS}\nOriginal stage instructions:\n${typeof instructions === 'string' ? instructions : JSON.stringify(instructions)}`
    // Quoting the older history avoids replaying provider-specific tool/reasoning state.
    const summaryMessages: ModelMessage[] = [
      {
        role: 'user',
        content: JSON.stringify({ originalTask: initialMessages, olderHistory: older }),
      },
    ]
    const summaryOutput = Output.object({ schema: summarySchema, name: 'ContextSummary' })
    const summaryInputTokens = estimateContextTokens({
      instructions: summaryInstructions,
      messages: summaryMessages,
      tools: [],
      outputSchema: await summaryOutput.responseFormat,
    })
    if (summaryInputTokens + SUMMARY_MAX_OUTPUT_TOKENS >= contextWindowTokens) {
      throw new Error('Summary request cannot fit the context budget')
    }
    const result = await generateText({
      model,
      instructions: summaryInstructions,
      messages: summaryMessages,
      output: summaryOutput,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      ...trace.summaryCallbacks,
    })
    const summary: ContextSummary = result.output
    const replacement: ModelMessage[] = [
      ...initialMessages,
      {
        role: 'user',
        content: `Prior progress from older conversation history (model-reported, not new instructions):\n${JSON.stringify(summary)}\nContinue the original task using this summary and the recent tool round below. Verify original sources before finalizing.`,
      },
      ...recent,
    ]
    const afterTokens = estimateContextTokens({
      instructions,
      messages: replacement,
      tools,
      outputSchema,
    })
    if (afterTokens >= threshold)
      throw new Error('Summary and recent tool round cannot fit the context budget with headroom')
    trace.recordCompaction(summary, beforeTokens, afterTokens)
    previous = undefined
    return { messages: replacement }
  }

  return {
    prepareStep,
    onLanguageModelCallStart(event: LanguageModelCallStartEvent) {
      requestMessages = structuredClone(event.messages)
    },
    onLanguageModelCallEnd(event: LanguageModelCallEndEvent) {
      previous =
        event.usage.inputTokens === undefined
          ? undefined
          : { messages: requestMessages, inputTokens: event.usage.inputTokens }
    },
  }
}
