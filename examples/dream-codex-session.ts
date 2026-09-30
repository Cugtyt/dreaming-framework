import type { LanguageModel } from 'ai'
import { codexAdapter } from '../extensions/codex/index.ts'
import { createDreamer } from '../src/index.ts'
import { enrichUserFeedback } from './dream-with-feedback.ts'

export async function dreamCodexSession(
  sessionPath: string,
  model: LanguageModel,
  workspaceDirectory: string,
) {
  const traces = await codexAdapter.readSession(sessionPath)
  return createDreamer({ model, stages: { enrichTrace: enrichUserFeedback } }).dream(traces, {
    workspaceDirectory,
  })
}
