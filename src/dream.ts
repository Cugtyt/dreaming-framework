import { isDeepStrictEqual } from 'node:util'
import type {
  BaseStages,
  DreamerOptions,
  DreamResult,
  EvaluationDecision,
  Goal,
  ImprovementSpec,
  NoProposal,
  Observation,
  SessionResult,
  SessionView,
  SourceLookup,
  StageImplementations,
  StageOverrides,
  TraceRecord,
  TraceSession,
} from './types.ts'

const DEFAULT_ATTEMPTS = 3

function invalid(message: string): never {
  throw new Error(message)
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${name} must be a nonempty string`)
}

function references(
  value: unknown,
  name: string,
  sources: Map<string, TraceRecord>,
): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((ref) => typeof ref === 'string')) {
    invalid(`${name} must contain source references`)
  }
  for (const ref of value as string[]) {
    if (!sources.has(ref)) invalid(`${name} has unresolved reference ${ref}`)
  }
}

function score(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${name} must be a finite number between 0 and 1`)
  }
}

function validateTrace(value: unknown, goal: Goal): TraceSession {
  if (!object(value)) invalid('mapped trace must be an object')
  text(value.trace_id, 'trace_id')
  text(value.schema_version, 'schema_version')
  text(value.scope_boundary, 'scope_boundary')
  if (value.scope_boundary !== goal.boundary) {
    invalid(`trace ${value.trace_id} has a different scope boundary`)
  }
  if (!Array.isArray(value.records)) invalid(`trace ${value.trace_id} records must be an array`)

  const items = new Map<string, TraceRecord>()
  for (const raw of value.records) {
    if (!object(raw)) invalid(`trace ${value.trace_id} contains a non-object record`)
    text(raw.item_id, 'item_id')
    text(raw.kind, 'kind')
    if (items.has(raw.item_id)) invalid(`trace ${value.trace_id} has duplicate item_id ${raw.item_id}`)
    if (raw.parent_id !== undefined) text(raw.parent_id, 'parent_id')
    if (raw.subject !== undefined) {
      if (!object(raw.subject)) invalid(`item ${raw.item_id} has an invalid subject`)
      text(raw.subject.id, `item ${raw.item_id} subject.id`)
      if (raw.subject.version !== undefined) text(raw.subject.version, `item ${raw.item_id} subject.version`)
    }
    if (raw.kind === 'evaluation') {
      if (raw['harness_rsi.scope'] !== undefined) invalid(`evaluation ${raw.item_id} cannot have scope`)
      const evaluation = raw['harness_rsi.evaluation']
      if (!object(evaluation)) invalid(`evaluation ${raw.item_id} is missing its score`)
      text(evaluation.name, `evaluation ${raw.item_id} name`)
      score(evaluation.value, `evaluation ${raw.item_id} value`)
      score(evaluation.target, `evaluation ${raw.item_id} target`)
      if (evaluation.weight !== undefined && (
        typeof evaluation.weight !== 'number' ||
        !Number.isFinite(evaluation.weight) || evaluation.weight <= 0
      )) {
        invalid(`evaluation ${raw.item_id} weight must be positive`)
      }
    } else {
      if (raw['harness_rsi.evaluation'] !== undefined) {
        invalid(`item ${raw.item_id} cannot carry an evaluation`)
      }
      const scope = raw['harness_rsi.scope']
      if (scope !== undefined && scope !== 'in' && scope !== 'out') {
        invalid(`item ${raw.item_id} has invalid scope`)
      }
      if (scope === 'in' && raw.subject === undefined) invalid(`in-scope item ${raw.item_id} needs a subject`)
    }
    items.set(raw.item_id, raw as unknown as TraceRecord)
  }

  const children = new Map<string, TraceRecord[]>()
  for (const item of items.values()) {
    if (item.parent_id === undefined) continue
    const group = children.get(item.parent_id) ?? []
    group.push(item)
    children.set(item.parent_id, group)
  }
  const hasScopedDescendant = (id: string, visited: Set<string>): boolean => {
    if (visited.has(id)) return false
    visited.add(id)
    return (children.get(id) ?? []).some((child) =>
      child['harness_rsi.scope'] !== undefined || hasScopedDescendant(child.item_id, visited))
  }
  for (const item of items.values()) {
    if (item.kind !== 'evaluation' && item['harness_rsi.scope'] === undefined &&
        !hasScopedDescendant(item.item_id, new Set())) {
      invalid(`item ${item.item_id} has missing scope without scoped children`)
    }
  }
  return value as unknown as TraceSession
}

function defaultProjectSession(trace: TraceSession): SessionView {
  const view = structuredClone(trace)
  for (const item of view.records) {
    if (item.kind === 'tool.result' && item.content !== undefined) item.content = '[compacted]'
  }
  return view
}

function validateView(view: unknown, original: TraceSession): asserts view is SessionView {
  if (!object(view) || !Array.isArray(view.records)) invalid(`projection for ${original.trace_id} is invalid`)
  if (view.trace_id !== original.trace_id || view.schema_version !== original.schema_version ||
      view.scope_boundary !== original.scope_boundary || view.records.length !== original.records.length) {
    invalid(`projection for ${original.trace_id} changed trace identity or record count`)
  }
  for (let index = 0; index < original.records.length; index++) {
    const projected = view.records[index]
    const source = original.records[index]
    if (!object(projected) || source === undefined) {
      invalid(`projection for ${original.trace_id} changed record order`)
    }
    const { content: _projectedContent, ...projectedIdentity } = projected
    const { content: _sourceContent, ...sourceIdentity } = source
    if (!isDeepStrictEqual(projectedIdentity, sourceIdentity)) {
      invalid(`projection for ${original.trace_id} changed record identity, labels, or order`)
    }
  }
}

function validateObservations(
  value: unknown,
  sources: Map<string, TraceRecord>,
): asserts value is Observation[] {
  if (!Array.isArray(value)) invalid('analyzeSession must return observations')
  for (const observation of value) {
    if (!object(observation)) invalid('observation must be an object')
    text(observation.text, 'observation text')
    references(observation.references, 'observation', sources)
    if (observation.references.length === 0) invalid('observation needs source references')
  }
}

function isNoProposal(value: unknown): value is NoProposal {
  return object(value) && value.kind === 'no_proposal'
}

function validateNoProposal(value: NoProposal, sources: Map<string, TraceRecord>): void {
  text(value.reason, 'no-proposal reason')
  if (value.references !== undefined) references(value.references, 'no-proposal', sources)
}

function validateCandidate(
  value: unknown,
  sources: Map<string, TraceRecord>,
  inSubjects: Set<string>,
): asserts value is ImprovementSpec {
  if (!object(value)) invalid('proposeSpec must return a candidate or no proposal')
  text(value.issue, 'Issue')
  text(value.proposal, 'Proposal')
  text(value.predict, 'Predict')
  text(value.componentId, 'componentId')
  if (!inSubjects.has(value.componentId)) invalid(`component ${value.componentId} is not in scope`)
  references(value.references, 'candidate', sources)
  if (value.references.length === 0) invalid('candidate needs source references')
}

function validateDecision(
  value: unknown,
  sources: Map<string, TraceRecord>,
): asserts value is EvaluationDecision {
  if (!object(value) || !['accept', 'revise', 'reject'].includes(String(value.kind))) {
    invalid('evaluateSpec must accept, revise, or reject')
  }
  text(value.reason, 'evaluation reason')
  if (value.references !== undefined) references(value.references, 'evaluation decision', sources)
}

export function createDreamer(baseStages: BaseStages, options: DreamerOptions = {}) {
  const maxProposalAttempts = options.maxProposalAttempts ?? DEFAULT_ATTEMPTS
  if (!Number.isInteger(maxProposalAttempts) || maxProposalAttempts < 1) {
    invalid('maxProposalAttempts must be a positive integer')
  }
  const defaults: StageImplementations = {
    mapTrace: (input) => input as TraceSession,
    projectSession: defaultProjectSession,
    ...baseStages,
  }

  return {
    async dream(
      inputs: readonly unknown[],
      goal: Goal,
      stage_overrides: StageOverrides = {},
    ): Promise<DreamResult> {
      if (!object(goal)) invalid('goal must be an object')
      text(goal.boundary, 'goal boundary')
      text(goal.question, 'goal question')
      if (goal.constraints !== undefined &&
          (!Array.isArray(goal.constraints) || !goal.constraints.every((item) => typeof item === 'string'))) {
        invalid('goal constraints must be strings')
      }
      if (!Array.isArray(inputs)) invalid('traces must be an array')
      if (inputs.length === 0) return { kind: 'no_proposal', reason: 'No completed traces were supplied' }
      const stages: StageImplementations = { ...defaults, ...stage_overrides }
      const traces = await Promise.all(inputs.map(async (input) => {
        const mapped = await stages.mapTrace(structuredClone(input))
        return validateTrace(mapped, goal)
      }))
      const sources = new Map<string, TraceRecord>()
      const inSubjects = new Set<string>()
      const traceIds = new Set<string>()
      const evaluations: Array<{ reference: string; record: TraceRecord }> = []
      for (const trace of traces) {
        if (traceIds.has(trace.trace_id)) invalid(`duplicate trace_id ${trace.trace_id}`)
        traceIds.add(trace.trace_id)
        for (const item of trace.records) {
          const ref = `${trace.trace_id}/${item.item_id}`
          if (sources.has(ref)) invalid(`duplicate source reference ${ref}`)
          sources.set(ref, structuredClone(item))
          if (item['harness_rsi.scope'] === 'in') inSubjects.add(item.subject!.id)
          if (item.kind === 'evaluation') {
            const record = structuredClone(item)
            record['harness_rsi.evaluation']!.weight ??= 1
            evaluations.push({ reference: ref, record })
          }
        }
      }
      const getSource: SourceLookup = (ref) => {
        const item = sources.get(ref)
        return item === undefined ? undefined : structuredClone(item)
      }
      const sessions: SessionResult[] = await Promise.all(traces.map(async (trace) => {
        const view = await stages.projectSession(
          structuredClone(trace), { goal: structuredClone(goal), getSource },
        )
        validateView(view, trace)
        const observations = await stages.analyzeSession(
          structuredClone(view), { goal: structuredClone(goal), getSource },
        )
        validateObservations(observations, sources)
        return { view: structuredClone(view), observations: structuredClone(observations) }
      }))

      let feedback: string | undefined
      for (let attempt = 0; attempt < maxProposalAttempts; attempt++) {
        const proposal = await stages.proposeSpec({
          goal: structuredClone(goal),
          sessions: structuredClone(sessions),
          feedback,
          getSource,
        })
        if (isNoProposal(proposal)) {
          validateNoProposal(proposal, sources)
          return structuredClone(proposal)
        }
        validateCandidate(proposal, sources, inSubjects)
        const candidate = structuredClone(proposal)
        const decision = await stages.evaluateSpec({
          goal: structuredClone(goal),
          candidate: structuredClone(candidate),
          sessions: structuredClone(sessions),
          evaluations: structuredClone(evaluations),
          getSource,
        })
        validateDecision(decision, sources)
        if (decision.kind === 'accept') {
          return { kind: 'spec', spec: candidate, evaluation: structuredClone(decision) }
        }
        if (decision.kind === 'reject') {
          return {
            kind: 'no_proposal',
            reason: decision.reason,
            ...(decision.references === undefined
              ? {}
              : { references: structuredClone(decision.references) }),
          }
        }
        feedback = decision.reason
      }
      return { kind: 'no_proposal', reason: `Proposal revision limit reached: ${feedback}` }
    },
  }
}
