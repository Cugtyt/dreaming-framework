import { readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { type Tool, tool } from 'ai'
import { z } from 'zod'

const offset = z.number().int().nonnegative().optional()
export const listFilesInputSchema = z.object({
  offset,
  limit: z.number().int().min(1).max(200).optional(),
})
export const listFilesOutputSchema = z.object({
  files: z.array(z.string()),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
})
export const searchFilesInputSchema = z.object({
  query: z.string().min(1),
  regex: z.boolean().optional(),
  path: z.string().min(1).optional(),
  contextLines: z.number().int().min(0).max(5).optional(),
  offset,
  limit: z.number().int().min(1).max(100).optional(),
})
export const searchFilesOutputSchema = z.object({
  matches: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      text: z.string(),
      context: z.array(z.object({ line: z.number().int().positive(), text: z.string() })),
    }),
  ),
  total: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
})
export const readFileInputSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  lineCount: z.number().int().min(1).max(200).optional(),
  fullLines: z.boolean().optional(),
})
export const readFileOutputSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(),
  content: z.string(),
  truncated: z.boolean(),
  truncatedLines: z.array(z.number().int().positive()),
  nextLine: z.number().int().positive().nullable(),
})

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
  listFiles: Tool<z.infer<typeof listFilesInputSchema>, z.infer<typeof listFilesOutputSchema>>
  searchFiles: Tool<z.infer<typeof searchFilesInputSchema>, z.infer<typeof searchFilesOutputSchema>>
  readFile: Tool<z.infer<typeof readFileInputSchema>, z.infer<typeof readFileOutputSchema>>
} {
  const root = resolve(workspaceDirectory)
  const preview = (line: string): string => {
    const characters = Array.from(line)
    if (characters.length <= 200) return line
    return `${characters.slice(0, 100).join('')} … [truncated: ${characters.length - 200} characters omitted] … ${characters.slice(-100).join('')}`
  }
  return {
    listFiles: tool({
      description:
        'List sorted text and JSON file paths in the workspace. Follow nextOffset until null to discover every file.',
      inputSchema: listFilesInputSchema,
      execute: async (input) => {
        const { offset = 0, limit = 200 } = listFilesInputSchema.parse(input)
        const all = await files(root)
        return listFilesOutputSchema.parse({
          files: all.slice(offset, offset + limit),
          total: all.length,
          nextOffset: offset + limit < all.length ? offset + limit : null,
        })
      },
    }),
    searchFiles: tool({
      description:
        'Search all text and JSON files case-insensitively using literal text or a regular expression. Optional path selects an exact file or directory prefix. Results include line numbers and context; follow nextOffset until null.',
      inputSchema: searchFilesInputSchema,
      execute: async (input) => {
        const {
          query,
          regex = false,
          path: filter,
          contextLines = 0,
          offset = 0,
          limit = 100,
        } = searchFilesInputSchema.parse(input)
        let pattern: RegExp | undefined
        if (regex) {
          try {
            pattern = new RegExp(query, 'i')
          } catch {
            throw new Error('Invalid regular expression')
          }
        }
        let prefix: string | undefined
        if (filter !== undefined) {
          const actual = await checkedFile(root, filter)
          prefix = relative(await realpath(root), actual)
        }
        const matches: z.infer<typeof searchFilesOutputSchema>['matches'] = []
        for (const path of await files(root)) {
          if (
            prefix !== undefined &&
            prefix !== '' &&
            path !== prefix &&
            !path.startsWith(`${prefix}${sep}`)
          )
            continue
          const lines = (await readFile(await checkedFile(root, path), 'utf8')).split('\n')
          for (const [index, line] of lines.entries()) {
            if (pattern ? pattern.test(line) : line.toLowerCase().includes(query.toLowerCase())) {
              const start = Math.max(0, index - contextLines)
              matches.push({
                path,
                line: index + 1,
                text: preview(line),
                context: lines
                  .slice(start, index + contextLines + 1)
                  .map((text, position) => ({ line: start + position + 1, text: preview(text) })),
              })
            }
          }
        }
        const nextOffset = offset + limit < matches.length ? offset + limit : null
        return searchFilesOutputSchema.parse({
          matches: matches.slice(offset, offset + limit),
          total: matches.length,
          nextOffset,
          truncated: nextOffset !== null,
        })
      },
    }),
    readFile: tool({
      description:
        'Read up to 200 lines by relative path. Follow nextLine until null. Lines longer than 200 characters show their first and last 100 characters; use fullLines true to read their entire contents.',
      inputSchema: readFileInputSchema,
      execute: async (input) => {
        const {
          path,
          startLine = 1,
          lineCount = 200,
          fullLines = false,
        } = readFileInputSchema.parse(input)
        const lines = (await readFile(await checkedFile(root, path), 'utf8')).split('\n')
        const truncatedLines: number[] = []
        const selected = lines
          .slice(startLine - 1, startLine - 1 + lineCount)
          .map((line, index) => {
            const content = fullLines ? line : preview(line)
            if (content !== line) truncatedLines.push(startLine + index)
            return content
          })
        return readFileOutputSchema.parse({
          path,
          startLine,
          totalLines: lines.length,
          content: selected.join('\n'),
          truncated: truncatedLines.length > 0,
          truncatedLines,
          nextLine: startLine - 1 + lineCount < lines.length ? startLine + lineCount : null,
        })
      },
    }),
  }
}
