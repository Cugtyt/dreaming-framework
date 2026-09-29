import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function createRunDirectory(): Promise<string> {
  const resultsDirectory = fileURLToPath(new URL('../results/', import.meta.url))
  await mkdir(resultsDirectory, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '')
  return mkdtemp(join(resultsDirectory, `${timestamp}-`))
}
