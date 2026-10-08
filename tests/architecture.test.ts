import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = new URL('../src/', import.meta.url)

async function sourceFiles(directory: URL): Promise<URL[]> {
  const files: URL[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = new URL(entry.name, directory)
    if (entry.isDirectory())
      files.push(...(await sourceFiles(new URL(`${entry.name}/`, directory))))
    else if (entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

function imports(source: ts.SourceFile): string[] {
  const found: string[] = []
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      found.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteral(argument)) found.push(argument.text)
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const argument = node.argument.literal
      if (ts.isStringLiteral(argument)) found.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function dependencyViolations(file: URL, source: ts.SourceFile): string[] {
  const violations: string[] = []
  const owner = file.pathname.slice(root.pathname.length).split('/')[0]
  const allowed: Record<string, string[]> = {
    domain: ['domain/'],
    trace: ['trace/', 'domain/', 'contracts.ts'],
    agent: ['agent/', 'domain/', 'contracts.ts', 'workspace.ts'],
    stages: [
      'stages/',
      'domain/',
      'contracts.ts',
      'agent/run-agent.ts',
      'agent/context-management.ts',
    ],
  }
  for (const dependency of imports(source)) {
    if (owner === 'domain' && (dependency === 'ai' || dependency.startsWith('ai/'))) {
      violations.push(`domain cannot import ${dependency}`)
    }
    if (!dependency.startsWith('.')) continue
    const target = new URL(dependency, file).pathname
    if (target.includes('/extensions/')) {
      violations.push(`core cannot import ${dependency}`)
    }
    const permitted = owner === undefined ? undefined : allowed[owner]
    if (permitted === undefined) continue
    const targetOwner = target.startsWith(root.pathname)
      ? target.slice(root.pathname.length)
      : undefined
    if (
      targetOwner === undefined ||
      !permitted.some((path) =>
        path.endsWith('/') ? targetOwner.startsWith(path) : targetOwner === path,
      )
    ) {
      violations.push(`${owner} cannot import ${dependency}`)
    }
  }
  if (owner === 'stages') {
    // Broad SDK access would let stages bypass the shared runner through an alias.
    function visit(node: ts.Node): void {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'ai'
      ) {
        const bindings = node.importClause?.namedBindings
        if (
          node.importClause?.name ||
          (bindings &&
            (ts.isNamespaceImport(bindings) ||
              bindings.elements.some(
                (item) => (item.propertyName ?? item.name).text === 'ToolLoopAgent',
              )))
        )
          violations.push('stages cannot import ToolLoopAgent or broad AI SDK bindings')
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === 'ai'
      ) {
        const bindings = node.exportClause
        if (
          !bindings ||
          ts.isNamespaceExport(bindings) ||
          bindings.elements.some(
            (item) => (item.propertyName ?? item.name).text === 'ToolLoopAgent',
          )
        )
          violations.push('stages cannot re-export ToolLoopAgent or broad AI SDK bindings')
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument) && argument.text === 'ai')
          violations.push('stages cannot dynamically import the whole AI SDK')
      }
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal) &&
        node.argument.literal.text === 'ai' &&
        (!node.qualifier || node.qualifier.getText(source).split('.')[0] === 'ToolLoopAgent')
      ) {
        violations.push('stages cannot import the ToolLoopAgent type or whole AI SDK type')
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return violations
}

test('domain, trace, agents, stages and core respect project dependency boundaries', async () => {
  const files = await sourceFiles(root)
  assert.ok(
    files.some((file) => file.pathname.includes('/domain/')),
    'domain must have an owner',
  )
  for (const file of files) {
    const source = ts.createSourceFile(
      fileURLToPath(file),
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    assert.deepEqual(dependencyViolations(file, source), [], file.pathname)
  }
})

test('import collection covers declarations, re-exports, dynamic imports and import types', () => {
  const source = ts.createSourceFile(
    'fixture.ts',
    `
    import type { TraceRecord } from '../domain/types.ts'
    export { value as renamed } from '../domain/schemas.ts'
    const load = import('../trace/otel.ts')
    type Record = import('../domain/types.ts').TraceRecord
  `,
    ts.ScriptTarget.Latest,
    true,
  )
  assert.deepEqual(imports(source), [
    '../domain/types.ts',
    '../domain/schemas.ts',
    '../trace/otel.ts',
    '../domain/types.ts',
  ])
})

test('dependency rules accept the intended module owners', () => {
  const fixtures = [
    ['domain/example.ts', "import { z } from 'zod'; import type { TraceRecord } from './types.ts'"],
    [
      'trace/example.ts',
      "import type { DreamInput } from '../contracts.ts'; import './otel.ts'; import '../domain/types.ts'",
    ],
    [
      'agent/example.ts',
      "import 'ai'; import '../contracts.ts'; import '../workspace.ts'; import '../domain/types.ts'; import './checkpoint.ts'",
    ],
    [
      'stages/example.ts',
      "import { Output } from 'ai'; import type { LanguageModel } from 'ai'; import '../contracts.ts'; import '../domain/types.ts'; import './project-session.ts'; import '../agent/run-agent.ts'; import '../agent/context-management.ts'",
    ],
    [
      'stages/example.ts',
      "// ToolLoopAgent belongs to the runner\nconst explanation = 'ToolLoopAgent'",
    ],
    [
      'stages/example.ts',
      "export { Output as StructuredOutput } from 'ai'; type Model = import('ai').LanguageModel",
    ],
  ]
  for (const [path, text] of fixtures) {
    assert.ok(path !== undefined && text !== undefined)
    const file = new URL(path, root)
    assert.deepEqual(
      dependencyViolations(file, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)),
      [],
      path,
    )
  }
})

test('dependency rules reject crossings and all literal import forms', () => {
  const fixtures = [
    ['domain/example.ts', "import '../trace/otel.ts'"],
    ['domain/example.ts', "import '../agent/run-agent.ts'"],
    ['domain/example.ts', "import type { DreamInput } from '../contracts.ts'"],
    ['domain/example.ts', "import 'ai'"],
    ['domain/example.ts', "import 'ai/test'"],
    ['trace/example.ts', "export * from '../stages/project-session.ts'"],
    ['trace/example.ts', "type Runner = import('../agent/run-agent.ts')"],
    ['agent/example.ts', "import('../dream.ts')"],
    ['agent/example.ts', "import '../stages/propose-spec.ts'"],
    ['stages/example.ts', "import '../agent/tools/file-tools.ts'"],
    ['stages/example.ts', "import '../workspace.ts'"],
    ['dream.ts', "import '../extensions/codex/index.ts'"],
    ['stages/example.ts', "import { ToolLoopAgent as Runner } from 'ai'"],
    ['stages/example.ts', "export { ToolLoopAgent as Runner } from 'ai'"],
    ['stages/example.ts', "import * as sdk from 'ai'"],
    ['stages/example.ts', "export * from 'ai'"],
    ['stages/example.ts', "export * as sdk from 'ai'"],
    ['stages/example.ts', "import sdk from 'ai'"],
    ['stages/example.ts', "type SDK = import('ai')"],
    ['stages/example.ts', "const sdk = import('ai')"],
    ['stages/example.ts', "type Runner = import('ai').ToolLoopAgent"],
  ]
  for (const [path, text] of fixtures) {
    assert.ok(path !== undefined && text !== undefined)
    const file = new URL(path, root)
    assert.ok(
      dependencyViolations(file, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
        .length > 0,
      `${path}: ${text}`,
    )
  }
})
