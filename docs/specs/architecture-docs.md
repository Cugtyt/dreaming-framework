# Architecture checks and documentation

## Start point and goal

Approved baseline: clean `main` at `cf535b6b829dd85ba67aed799b4a7f64a9bd8a56`.
Implement in the `codex/architecture-docs` worktree. Preserve the production layout
while making dependency ownership executable and documentation easier to navigate.

## Closed scope

- `tests/architecture.test.ts`: modify `imports` and the existing boundary test;
  add test-local `dependencyViolations` and fixture tests. Inspect static imports,
  re-exports, literal dynamic imports and import types. Reject domain dependencies
  outside domain and AI SDK imports; trace may depend on trace/domain/contracts;
  agent on agent/domain/contracts/workspace; stages on stages/domain/contracts,
  `agent/run-agent.ts` and `agent/context-management.ts`. Core cannot import
  extensions. Stages cannot import/re-export AI SDK `ToolLoopAgent`, including
  aliases, namespace and wildcard access.
- `README.md`: retain overview, quick start, basic API, architecture chart and
  documentation links; clarify caller ownership of `result.json`.
- `docs/architecture.md`: add pipeline, component/file/function ownership,
  dependency rules and layout.
- `docs/usage.md`: relocate detailed input, adapters, stage customization, tools,
  compaction, artifacts, inspection suite and data handling guidance from README.
  Preserve current DSH requirements and correct relative links.
- `docs/specs/project-boundaries.md`: update dependency rules to match checks.
- This file records the implementation and acceptance contract.

No production code, public API, runtime behavior, dependencies, adapter
abstractions or other repository files change. The dependency checker exists only
inside the architecture test and is consumed by fixtures and the repository scan.
Static checks cover literal module specifiers; computed imports are not resolved.
Context constants and the runner are the approved stage-to-agent entry points;
import checks enforce module ownership rather than every exported symbol.

## Implementation

1. Add fixtures for allowed and forbidden imports. Demonstrate failure against
   the current import collector and temporary checker stub before implementation.
2. Implement the test-local rules and AST collection; run focused tests.
3. Reorganize docs and align ownership rules, without runtime changes.
4. Run acceptance checks and inspect the final allowlisted diff.

## Acceptance

Fixture tests detect forbidden dependencies and aliased agent imports across all
supported import forms, accept current intended dependencies, and do not treat
comments or strings as agent construction. The repository boundary test and full
suite pass. Strict typecheck, Biome and JavaScript/declaration build pass without
weakening settings. Documentation links resolve; artifact ownership is accurate.
Any expansion needs explicit confirmation. Acceptance evidence is reported outside
this spec.
