# Trace list and folder inputs

## Start point and goal

Based on clean main at 69a581a. Implement on branch trace-input in
/Users/bytedance/MyWork/dreaming-framework-trace-input, leaving changes uncommitted.
The caller may pass an in-memory OTLP export list or a trace folder to dream().

## Input and ownership contract

DreamInput is readonly unknown[] | string. Each list element or JSON file must
contain one OTLP export with one trace ID, using existing parsing and validation.
The trace layer owns loadTraceInputs in src/trace/input.ts; dream() is its consumer.
Folder loading reads immediate lowercase .json files in filename order. Other
files and subdirectories are ignored. Matching symlinks are rejected. Missing,
blank, unreadable, or non-directory paths fail. JSON and trace errors identify the
source filename. Empty folders produce the existing empty-list no_proposal result.
Source files remain unchanged. Loading happens after option/stage validation and
before output workspace creation. Outputs use a separate workspaceDirectory.

No dependencies, stage interfaces, output formats, model behavior, retry rules,
or Codex JSONL conversion change. Input lists keep existing runtime validation.

## Closed implementation scope

- src/contracts.ts: DreamInput.
- src/index.ts: DreamInput export.
- src/trace/input.ts: loadTraceInputs.
- src/dream.ts: createDreamer().dream input normalization and file error context.
- tests/trace-input.test.ts: folder selection/order, empty input, JSON/path errors,
  symlink rejection, list normalization.
- tests/dream.test.ts: list/folder equivalence, file-aware validation failures,
  source immutability and no workspace creation on input loading failures.
- README.md: usage and folder format.
- docs/specs/initial-framework.md: input contract and ownership.
- docs/specs/project-boundaries.md: trace input ownership.
- docs/specs/trace-input.md: this agreed contract.

## Implementation and acceptance

Add tests first and verify failure before implementation. Test loader behavior
and integration through public createDreamer().dream. Verify equivalent list and
folder results, sorted sessions, source bytes unchanged, empty-folder behavior,
and useful filename errors for malformed/invalid inputs. Existing array behavior
and boundary tests must pass. Run full tests, Biome, strict typecheck, declaration
build, and git diff --check. Leave all changes uncommitted for user review.
