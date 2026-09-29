import type {
  LanguageModelCallEndEvent,
  LanguageModelCallStartEvent,
  ToolExecutionEndEvent,
} from 'ai'
import { writeWorkspaceText } from '../workspace.ts'

export function createModelTrace(
  workspaceDirectory: string,
  attempt: number,
  stage: 'proposer' | 'evaluator',
) {
  const events: unknown[] = []
  const path = `attempts/${attempt}/${stage}-model.jsonl`

  async function save(event: unknown): Promise<void> {
    events.push(event)
    await writeWorkspaceText(
      workspaceDirectory,
      path,
      `${events.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    )
  }

  return {
    callbacks: {
      onLanguageModelCallStart(event: LanguageModelCallStartEvent) {
        events.push({
          event: 'model_call_start',
          callId: event.callId,
          provider: event.provider,
          modelId: event.modelId,
          instructions: event.instructions,
          messages: event.messages,
          tools: event.tools,
        })
      },
      onLanguageModelCallEnd(event: LanguageModelCallEndEvent) {
        events.push({
          event: 'model_call_end',
          callId: event.callId,
          responseId: event.responseId,
          content: event.content,
          finishReason: event.finishReason,
          usage: event.usage,
        })
      },
      onToolExecutionEnd(event: ToolExecutionEndEvent) {
        events.push({
          event: 'tool_result',
          callId: event.callId,
          toolCall: event.toolCall,
          toolOutput:
            event.toolOutput.type === 'tool-error'
              ? { type: 'tool-error', error: String(event.toolOutput.error) }
              : event.toolOutput,
          toolExecutionMs: event.toolExecutionMs,
        })
      },
    },
    writeResult: (result: unknown) => save({ event: 'result', value: result }),
    writeError: (error: unknown) =>
      save({ event: 'error', message: error instanceof Error ? error.message : String(error) }),
  }
}
