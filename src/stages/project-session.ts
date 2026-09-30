import { isDeepStrictEqual } from 'node:util'
import { traceSessionSchema } from '../domain/schemas.ts'
import type { SessionView, TraceSession } from '../domain/types.ts'
import { invalid, object } from '../domain/validation.ts'

const compactableAttributes = ['gen_ai.message.content', 'gen_ai.tool.call.arguments']

export function defaultProjectSession(trace: TraceSession): SessionView {
  const view = structuredClone(trace)
  for (const item of view.records) {
    if (item.content !== undefined) item.content = '[compacted]'
  }
  return view
}

export function validateView(view: unknown, original: TraceSession): asserts view is SessionView {
  if (!traceSessionSchema.safeParse(view).success || !object(view) || !Array.isArray(view.records))
    invalid(`projection for ${original.trace_id} is invalid`)
  if (
    view.trace_id !== original.trace_id ||
    view.harness_version !== original.harness_version ||
    view.records.length !== original.records.length
  ) {
    invalid(`projection for ${original.trace_id} changed trace identity or record count`)
  }
  for (let index = 0; index < original.records.length; index++) {
    const projected = view.records[index]
    const source = original.records[index]
    if (!object(projected) || source === undefined) {
      invalid(`projection for ${original.trace_id} changed record order`)
    }
    const {
      content: _projectedContent,
      attributes: projectedAttributes,
      ...projectedIdentity
    } = projected
    const { content: _sourceContent, attributes: sourceAttributes, ...sourceIdentity } = source
    if (
      !isDeepStrictEqual(projectedIdentity, sourceIdentity) ||
      !object(projectedAttributes) ||
      !object(sourceAttributes) ||
      !isDeepStrictEqual(
        Object.keys(projectedAttributes).sort(),
        Object.keys(sourceAttributes).sort(),
      ) ||
      Object.keys(sourceAttributes).some(
        (key) =>
          !compactableAttributes.includes(key) &&
          !isDeepStrictEqual(projectedAttributes[key], sourceAttributes[key]),
      )
    ) {
      invalid(`projection for ${original.trace_id} changed record identity, labels, or order`)
    }
  }
}
