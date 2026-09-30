import { type LanguageModel, type Output, stepCountIs, ToolLoopAgent } from 'ai'
import type { ReasoningServices } from '../contracts.ts'
import { createContextManagement } from './context-management.ts'
import { createModelTrace } from './model-trace.ts'
import { fileTools } from './tools/file-tools.ts'
import { sourceTool } from './tools/source-tool.ts'

export async function runAgent<RESULT, PARTIAL>(options: {
  model: LanguageModel
  contextWindowTokens: number
  stage: 'proposer' | 'evaluator'
  services: ReasoningServices
  instructions: string
  output: Output.Output<RESULT, PARTIAL, never>
  traceResult: (value: RESULT) => unknown
}): Promise<RESULT> {
  const { workspaceDirectory, attempt, getSource } = options.services
  const trace = createModelTrace(workspaceDirectory, attempt, options.stage)
  const tools = { ...fileTools(workspaceDirectory), getSource: sourceTool(getSource) }
  const context = createContextManagement(options.contextWindowTokens, trace, {
    tools,
    output: options.output,
  })
  const agent = new ToolLoopAgent({
    model: options.model,
    id: `dreaming.${options.stage}`,
    instructions: options.instructions,
    output: options.output,
    tools,
    stopWhen: stepCountIs(12),
    ...trace.callbacks,
    prepareStep: context.prepareStep,
    onLanguageModelCallStart(event) {
      context.onLanguageModelCallStart(event)
      trace.callbacks.onLanguageModelCallStart(event)
    },
    onLanguageModelCallEnd(event) {
      context.onLanguageModelCallEnd(event)
      trace.callbacks.onLanguageModelCallEnd(event)
    },
  })
  let result: RESULT
  try {
    const generation = await agent.generate({ prompt: workspaceDirectory })
    result = generation.output
  } catch (error) {
    await trace.writeError(error)
    throw error
  }
  await trace.writeResult(options.traceResult(result))
  return result
}
