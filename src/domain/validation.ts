import { z } from 'zod'
import {
  evaluationAttributesSchema,
  evaluationDecisionSchema,
  improvementSpecSchema,
  noProposalSchema as optionalNoProposalSchema,
  scopeSchema,
  sourceReferenceSchema,
  traceSessionSchema,
} from './schemas.ts'
import { sourceKey } from './sources.ts'
import type {
  EvaluationDecision,
  ImprovementSpec,
  NoProposal,
  SourceReference,
  TraceRecord,
  TraceSession,
} from './types.ts'

export class ValidationError extends Error {
  readonly category: 'shape' | 'invariant' | 'reference'

  constructor(message: string, category: ValidationError['category'] = 'invariant') {
    super(message)
    this.name = 'ValidationError'
    this.category = category
  }
}

export function invalid(
  message: string,
  category: ValidationError['category'] = 'invariant',
): never {
  throw new ValidationError(message, category)
}

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function references(
  value: unknown,
  name: string,
  sources: Map<string, TraceRecord>,
): asserts value is SourceReference[] {
  if (!z.array(sourceReferenceSchema).safeParse(value).success) {
    invalid(`${name} must contain source references`, 'reference')
  }
  for (const ref of value as SourceReference[]) {
    if (!sources.has(sourceKey(ref)))
      invalid(`${name} has unresolved reference ${JSON.stringify(ref)}`, 'reference')
  }
}

export function validateTrace(value: unknown): TraceSession {
  if (object(value) && value.harness_version === undefined)
    invalid('trace is missing a harness version')
  const parsed = traceSessionSchema.safeParse(value)
  if (!parsed.success) invalid(`parsed trace: ${parsed.error.message}`, 'shape')
  const trace = value as TraceSession

  const items = new Map<string, TraceRecord>()
  for (const raw of trace.records) {
    const key = JSON.stringify([raw.span_id, raw.event_index ?? null])
    if (items.has(key)) invalid(`trace ${trace.trace_id} has duplicate source ${key}`)
    if (raw['harness_rsi.scope'] !== undefined)
      invalid(`item ${raw.span_id} cannot carry a separate scope label`)
    if (raw['harness_rsi.evaluation'] !== undefined)
      invalid(`item ${raw.span_id} cannot carry a separate evaluation object`)
    if (!object(raw.attributes)) invalid(`item ${raw.span_id} is missing its attributes`)
    const attributes = raw.attributes
    if (raw.kind === 'gen_ai.evaluation.result') {
      if (attributes['harness_rsi.scope'] !== undefined)
        invalid(`evaluation ${raw.span_id} cannot have scope`)
      const evaluation = evaluationAttributesSchema.safeParse(attributes)
      if (!evaluation.success)
        invalid(`evaluation ${raw.span_id}: ${evaluation.error.message}`, 'shape')
    } else if (
      attributes['harness_rsi.scope'] !== undefined &&
      !scopeSchema.safeParse(attributes['harness_rsi.scope']).success
    ) {
      invalid(`item ${raw.span_id} has invalid scope`)
    }
    items.set(key, raw)
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
  return trace
}

export function isNoProposal(value: unknown): value is NoProposal {
  return object(value) && value.kind === 'no_proposal'
}

export function validateNoProposal(value: NoProposal, sources: Map<string, TraceRecord>): void {
  const parsed = optionalNoProposalSchema.omit({ references: true }).safeParse(value)
  if (!parsed.success) invalid(`no-proposal reason: ${parsed.error.message}`, 'shape')
  if (value.references !== undefined) references(value.references, 'no-proposal', sources)
}

export function validateCandidate(
  value: unknown,
  sources: Map<string, TraceRecord>,
  inSources: Set<string>,
  harnessVersion: string,
): asserts value is ImprovementSpec {
  if (!object(value)) invalid('proposeSpec must return a candidate or no proposal')
  const parsed = improvementSpecSchema.omit({ references: true }).safeParse(value)
  if (!parsed.success) invalid(`candidate: ${parsed.error.message}`, 'shape')
  if (value.baseHarnessVersion !== harnessVersion)
    invalid('candidate has a different base harness version')
  references(value.references, 'candidate', sources)
  if (value.references.length === 0) invalid('candidate needs source references', 'reference')
  if (
    !(value.references as SourceReference[]).some((reference) =>
      inSources.has(sourceKey(reference)),
    )
  ) {
    invalid('candidate needs an in-scope source reference', 'reference')
  }
}

export function validateDecision(
  value: unknown,
  sources: Map<string, TraceRecord>,
): asserts value is EvaluationDecision {
  const parsed = evaluationDecisionSchema.omit({ references: true }).safeParse(value)
  if (!parsed.success)
    invalid(
      `evaluateSpec must accept, revise, or reject with an evaluation reason: ${parsed.error.message}`,
      'shape',
    )
  const decision = value as EvaluationDecision
  if (decision.references !== undefined)
    references(decision.references, 'evaluation decision', sources)
}
