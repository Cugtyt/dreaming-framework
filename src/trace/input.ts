import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { DreamInput } from '../contracts.ts'
import { invalid } from '../domain/validation.ts'

export async function loadTraceInputs(
  value: DreamInput,
): Promise<Array<{ input: unknown; sourcePath?: string }>> {
  if (Array.isArray(value)) return value.map((input: unknown) => ({ input }))
  if (typeof value !== 'string') invalid('traces must be an array or folder path', 'shape')
  if (value.trim() === '') invalid('trace folder path must be nonempty', 'shape')
  const directory = resolve(value)
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    throw new Error(`${directory}: Cannot read trace directory`, { cause: error })
  })
  const loaded: Array<{ input: unknown; sourcePath?: string }> = []
  for (const entry of entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    if (!entry.name.endsWith('.json')) continue
    const sourcePath = join(directory, entry.name)
    if (entry.isSymbolicLink()) invalid(`${sourcePath}: Trace file cannot be a symbolic link`)
    if (!entry.isFile()) continue
    const text = await readFile(sourcePath, 'utf8').catch((error: unknown) => {
      throw new Error(`${sourcePath}: Cannot read trace file`, { cause: error })
    })
    let input: unknown
    try {
      input = JSON.parse(text)
    } catch (error) {
      throw new Error(`${sourcePath}: Invalid trace JSON`, { cause: error })
    }
    loaded.push({ input, sourcePath })
  }
  return loaded
}
