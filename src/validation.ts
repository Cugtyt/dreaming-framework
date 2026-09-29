import type { SourceReference, StageImplementations, TraceRecord, TraceSession } from './types.ts'

export function invalid(message: string): never {
  throw new Error(message)
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} must be a nonempty string`)
}

export function references(
  value: unknown,
  name: string,
  sources: Map<string, TraceRecord>,
): asserts value is SourceReference[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (ref) =>
        object(ref) &&
        typeof ref.trace_id === 'string' &&
        typeof ref.span_id === 'string' &&
        (ref.event_index === undefined ||
          (typeof ref.event_index === 'number' &&
            Number.isInteger(ref.event_index) &&
            ref.event_index >= 0)) &&
        Object.keys(ref).every((key) => ['trace_id', 'span_id', 'event_index'].includes(key)),
    )
  ) {
    invalid(`${name} must contain source references`)
  }
  for (const ref of value as SourceReference[]) {
    if (!sources.has(JSON.stringify([ref.trace_id, ref.span_id, ref.event_index ?? null])))
      invalid(`${name} has unresolved reference ${JSON.stringify(ref)}`)
  }
}

function score(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${name} must be a finite number between 0 and 1`)
  }
}

export function validateTrace(value: unknown): TraceSession {
  if (!object(value)) invalid('parsed trace must be an object')
  text(value.trace_id, 'trace_id')
  if (value.harness_version === undefined) invalid('trace is missing a harness version')
  text(value.harness_version, 'harness_version')
  if (!Array.isArray(value.records)) invalid(`trace ${value.trace_id} records must be an array`)

  const items = new Map<string, TraceRecord>()
  for (const raw of value.records) {
    if (!object(raw)) invalid(`trace ${value.trace_id} contains a non-object record`)
    text(raw.span_id, 'span_id')
    text(raw.kind, 'kind')
    if (
      raw.event_index !== undefined &&
      (!Number.isInteger(raw.event_index) || (raw.event_index as number) < 0)
    )
      invalid(`item ${raw.span_id} has invalid event_index`)
    const key = JSON.stringify([raw.span_id, raw.event_index ?? null])
    if (items.has(key)) invalid(`trace ${value.trace_id} has duplicate source ${key}`)
    if (raw.parent_id !== undefined) text(raw.parent_id, 'parent_id')
    if (raw['harness_rsi.scope'] !== undefined)
      invalid(`item ${raw.span_id} cannot carry a separate scope label`)
    if (raw['harness_rsi.evaluation'] !== undefined)
      invalid(`item ${raw.span_id} cannot carry a separate evaluation object`)
    if (!object(raw.attributes)) invalid(`item ${raw.span_id} is missing its attributes`)
    const attributes = raw.attributes
    if (raw.kind === 'gen_ai.evaluation.result') {
      if (attributes['harness_rsi.scope'] !== undefined)
        invalid(`evaluation ${raw.span_id} cannot have scope`)
      text(attributes['gen_ai.evaluation.name'], `evaluation ${raw.span_id} name`)
      score(attributes['gen_ai.evaluation.score.value'], `evaluation ${raw.span_id} value`)
      score(attributes['harness_rsi.evaluation.target'], `evaluation ${raw.span_id} target`)
      if (
        attributes['harness_rsi.evaluation.weight'] !== undefined &&
        (typeof attributes['harness_rsi.evaluation.weight'] !== 'number' ||
          !Number.isFinite(attributes['harness_rsi.evaluation.weight']) ||
          attributes['harness_rsi.evaluation.weight'] <= 0)
      ) {
        invalid(`evaluation ${raw.span_id} weight must be positive`)
      }
    } else {
      const scope = attributes['harness_rsi.scope']
      if (scope !== undefined && scope !== 'in' && scope !== 'out') {
        invalid(`item ${raw.span_id} has invalid scope`)
      }
    }
    items.set(key, raw as unknown as TraceRecord)
  }

  const children = new Map<string, TraceRecord[]>()
  for (const item of items.values()) {
    const parent = item.event_index === undefined ? item.parent_id : item.span_id
    if (parent === undefined) continue
    const group = children.get(parent) ?? []
    group.push(item)
    children.set(parent, group)
  }
  const hasScopedDescendant = (id: string, visited: Set<string>): boolean => {
    if (visited.has(id)) return false
    visited.add(id)
    return (children.get(id) ?? []).some(
      (child) =>
        child.attributes?.['harness_rsi.scope'] !== undefined ||
        (child.event_index === undefined && hasScopedDescendant(child.span_id, visited)),
    )
  }
  for (const item of items.values()) {
    if (
      item.kind !== 'gen_ai.evaluation.result' &&
      item.attributes?.['harness_rsi.scope'] === undefined &&
      (item.event_index !== undefined || !hasScopedDescendant(item.span_id, new Set()))
    ) {
      invalid(`item ${item.span_id} has missing scope without scoped children`)
    }
  }
  return value as unknown as TraceSession
}

export function assertStageImplementations(
  value: Partial<StageImplementations>,
): asserts value is StageImplementations {
  const names = ['enrichTrace', 'projectSession', 'proposeSpec', 'evaluateSpec'] as const
  for (const name of names) {
    if (typeof value[name] !== 'function') invalid(`${name} must be a function`)
  }
}
