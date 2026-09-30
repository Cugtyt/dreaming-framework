export type {
  DreamerSetup,
  DreamOptions,
  ProposalInput,
  ReasoningServices,
  SpecEvaluationInput,
  StageImplementations,
  StageOverrides,
} from './contracts.ts'
export type {
  DreamResult,
  EvaluationDecision,
  ImprovementSpec,
  NoProposal,
  Scope,
  SessionView,
  SourceLookup,
  SourceReference,
  TraceAdditions,
  TraceDraft,
  TraceRecord,
  TraceSession,
} from './domain/types.ts'
export { createDreamer } from './dream.ts'
