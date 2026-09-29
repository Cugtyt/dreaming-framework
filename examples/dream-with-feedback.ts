import type { LanguageModel } from 'ai'
import { createDreamer, type TraceAdditions, type TraceDraft } from '../src/index.ts'

const negativeRules = [
  /\b(?:stupid|dumb|the hell|wtf|what the fuck)\b/i,
  /\b(?:why so complex|too complex|overcomplicat\w*)\b/i,
  /\b(?:this is so bad|that is so bad|terrible|awful)\b/i,
  /\b(?:that is not correct|this is not correct|that is wrong|this is wrong|not correct)\b/i,
  /\bi (?:don'?t|do not) understand\b/i,
]

function feedbackScore(raw: string): 0 | 1 | undefined {
  if (
    /^\s*(?:# Response annotations:|<hook_prompt|<recommended_plugins>|<send_user_message|# AGENTS\.md)/i.test(
      raw,
    ) &&
    !raw.includes('## My request:')
  ) {
    return undefined
  }
  const request = raw.includes('## My request:') ? raw.split('## My request:').at(-1)! : raw
  const text = request.replace(/^\s*>[^\n]*(?:\n|$)/gm, '').replace(/```[\s\S]*?```/g, '')
  for (const pattern of negativeRules) {
    const match = pattern.exec(text)
    if (!match) continue
    const context = text.slice(Math.max(0, match.index - 100), match.index)
    if (!/\b(?:for example|e\.g\.|such as)\b/i.test(context)) return 0
  }
  if (
    /^\s*(?:ok(?:ay)?|right|fine|yes|looks better)\b/i.test(text) &&
    !/\b(?:but|however|although)\b|\?/i.test(text)
  ) {
    return 1
  }
  return undefined
}

export function enrichUserFeedback(trace: Readonly<TraceDraft>): TraceAdditions {
  const evaluations: NonNullable<TraceAdditions['evaluations']> = []
  let previousMessageWasAssistant = false
  for (const record of trace.records) {
    if (record.kind === 'gen_ai.assistant.message') {
      previousMessageWasAssistant = true
      continue
    }
    if (record.kind !== 'gen_ai.user.message') continue
    const isFeedback = previousMessageWasAssistant
    previousMessageWasAssistant = false
    const content = record.attributes?.['gen_ai.message.content']
    const score = isFeedback && typeof content === 'string' ? feedbackScore(content) : undefined
    if (score === undefined || record.time === undefined) continue
    evaluations.push({
      name: 'explicit_user_feedback/v1',
      value: score,
      target: 1,
      time: (BigInt(record.time) + 1n).toString(),
    })
  }
  return { evaluations }
}

export function dreamWithFeedback(
  traces: readonly unknown[],
  model: LanguageModel,
  workspaceDirectory: string,
) {
  return createDreamer({ model, stages: { enrichTrace: enrichUserFeedback } }).dream(traces, {
    workspaceDirectory,
  })
}
