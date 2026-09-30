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
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

test('domain, stages and core respect project dependency boundaries', async () => {
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
    const dependencies = imports(source)
    const paths = dependencies
      .filter((value) => value.startsWith('.'))
      .map((value) => new URL(value, file).pathname)
    assert.ok(
      paths.every((path) => !path.includes('/extensions/')),
      `${file.pathname}: core imports an extension`,
    )
    if (file.pathname.includes('/domain/')) {
      assert.ok(
        dependencies.every((value) => value !== 'ai' && !value.startsWith('ai/')),
        `${file.pathname}: domain imports AI SDK`,
      )
      assert.ok(
        paths.every((path) => !path.includes('/agent/')),
        `${file.pathname}: domain imports agents`,
      )
    }
    if (file.pathname.includes('/stages/')) {
      assert.ok(
        !source.text.includes('ToolLoopAgent'),
        `${file.pathname}: stage owns SDK agent construction`,
      )
    }
  }
})
