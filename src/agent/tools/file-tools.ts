import { readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type Tool, tool } from 'ai'
import { z } from 'zod'

const MAX_FILES = 200
const MAX_MATCHES = 100
const MAX_LINES = 200
const MAX_READ_CHARS = 20_000

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function checkedFile(root: string, path: string): Promise<string> {
  if (isAbsolute(path)) throw new Error('File path must be relative to workspaceDirectory')
  const candidate = resolve(root, path)
  if (!inside(root, candidate)) throw new Error('File path escapes workspaceDirectory')
  const actual = await realpath(candidate)
  if (!inside(await realpath(root), actual)) throw new Error('File path escapes workspaceDirectory')
  return actual
}

async function files(root: string): Promise<string[]> {
  const found: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (found.length >= MAX_FILES) return
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && /\.(json|txt)$/.test(entry.name)) found.push(relative(root, path))
    }
  }
  await visit(root)
  return found.sort()
}

export function fileTools(workspaceDirectory: string): {
  listFiles: Tool<Record<string, never>, { files: string[] }>
  searchFiles: Tool<
    { query: string },
    { matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }
  >
  readFile: Tool<
    { path: string; startLine?: number | undefined; lineCount?: number | undefined },
    { path: string; startLine: number; totalLines: number; content: string; truncated: boolean }
  >
} {
  const root = resolve(workspaceDirectory)
  return {
    listFiles: tool({
      description:
        'List available text and JSON files in the run workspace. Paths are relative to the workspace.',
      inputSchema: z.object({}),
      execute: async () => ({ files: await files(root) }),
    }),
    searchFiles: tool({
      description:
        'Search workspace text and JSON files for a literal text fragment, returning file paths and line numbers.',
      inputSchema: z.object({ query: z.string().min(1) }),
      execute: async ({ query }) => {
        const matches: Array<{ path: string; line: number; text: string }> = []
        for (const path of await files(root)) {
          const lines = (await readFile(await checkedFile(root, path), 'utf8')).split('\n')
          for (const [index, line] of lines.entries()) {
            if (line.toLowerCase().includes(query.toLowerCase())) {
              matches.push({ path, line: index + 1, text: line.slice(0, 300) })
              if (matches.length >= MAX_MATCHES) return { matches, truncated: true }
            }
          }
        }
        return { matches, truncated: false }
      },
    }),
    readFile: tool({
      description:
        'Read up to 200 lines of a workspace text or JSON file by relative path. Use startLine to page.',
      inputSchema: z.object({
        path: z.string().min(1),
        startLine: z.number().int().positive().optional(),
        lineCount: z.number().int().min(1).max(MAX_LINES).optional(),
      }),
      execute: async ({ path, startLine = 1, lineCount = MAX_LINES }) => {
        const lines = (await readFile(await checkedFile(root, path), 'utf8')).split('\n')
        const selected = lines.slice(startLine - 1, startLine - 1 + lineCount).join('\n')
        return {
          path,
          startLine,
          totalLines: lines.length,
          content: selected.slice(0, MAX_READ_CHARS),
          truncated: selected.length > MAX_READ_CHARS,
        }
      },
    }),
  }
}
