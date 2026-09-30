import assert from 'node:assert/strict'

export function requireValue<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, 'Expected fixture value to be present')
  return value
}
