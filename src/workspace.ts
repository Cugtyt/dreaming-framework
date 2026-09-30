import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export async function prepareWorkspace(path: string): Promise<string> {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('workspaceDirectory must be a nonempty path')
  }
  const root = resolve(path)
  try {
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('workspaceDirectory must be a directory')
    }
    if ((await readdir(root)).length > 0) {
      throw new Error('workspaceDirectory must be empty')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(root, { recursive: true })
  }
  return root
}

async function writeWorkspaceFile(root: string, path: string, content: string): Promise<void> {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error('workspace file path must stay inside the workspace')
  }
  const destination = join(root, path)
  const rel = relative(root, destination)
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error('workspace file path must stay inside the workspace')
  }
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, content, { flag: 'wx' })
}

export function writeWorkspaceJson(root: string, path: string, value: unknown): Promise<void> {
  return writeWorkspaceFile(root, path, `${JSON.stringify(value, null, 2)}\n`)
}

export function writeWorkspaceText(root: string, path: string, value: string): Promise<void> {
  return writeWorkspaceFile(root, path, value)
}
