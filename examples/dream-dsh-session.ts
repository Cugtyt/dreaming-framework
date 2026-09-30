import type { LanguageModel } from 'ai'
import { dshAdapter } from '../extensions/dsh/index.ts'
import { createDreamer } from '../src/index.ts'
import { enrichUserFeedback } from './dream-with-feedback.ts'

export async function dreamDshSession(
  sessionPath: string,
  model: LanguageModel,
  workspaceDirectory: string,
  harnessVersion: string,
) {
  const traces = await dshAdapter.readSession(sessionPath, { harnessVersion })
  return createDreamer({ model, stages: { enrichTrace: enrichUserFeedback } }).dream(traces, {
    workspaceDirectory,
  })
}
