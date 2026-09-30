import type { SessionView, TraceRecord } from '../domain/types.ts'

function xml(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
}

function field(name: string, value: unknown): string {
  return value === undefined ? '' : ` ${name}="${xml(value).replaceAll('"', '&quot;')}"`
}

function recordLines(record: TraceRecord): string[] {
  const attributes = record.attributes ?? {}
  const reference = field('span_id', record.span_id) + field('event_index', record.event_index)
  const common =
    reference +
    field('parent_id', record.parent_id) +
    field('kind', record.kind) +
    field('time', record.time)
  const isEvaluation = record.kind === 'gen_ai.evaluation.result'
  const selected = isEvaluation
    ? [
        'gen_ai.evaluation.name',
        'gen_ai.evaluation.score.value',
        'harness_rsi.evaluation.target',
        'harness_rsi.evaluation.weight',
      ]
    : ['harness_rsi.scope', 'gen_ai.tool.name']
  const lines: string[] = []
  if (isEvaluation) {
    lines.push(
      `<evaluation${common}${field('name', attributes['gen_ai.evaluation.name'])}${field('score', attributes['gen_ai.evaluation.score.value'])}${field('target', attributes['harness_rsi.evaluation.target'])}${field('weight', attributes['harness_rsi.evaluation.weight'] ?? 1)}/>`,
    )
  } else {
    const contentKey =
      record.content !== undefined
        ? undefined
        : ['gen_ai.message.content', 'gen_ai.tool.call.arguments'].find(
            (key) => attributes[key] !== undefined,
          )
    const content = record.content ?? (contentKey ? attributes[contentKey] : undefined)
    if (contentKey) selected.push(contentKey)
    const item = `<item${common}${field('scope', attributes['harness_rsi.scope'])}${field('tool', attributes['gen_ai.tool.name'])}`
    lines.push(content === undefined ? `${item}/>` : `${item}>${xml(content)}</item>`)
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (!selected.includes(key))
      lines.push(`<meta${reference}${field('key', key)}${field('value', value)}/>`)
  }
  return lines
}

export function projectionText(view: SessionView): string {
  const lines = [
    `<trace${field('trace_id', view.trace_id)}${field('harness_version', view.harness_version)}>`,
    ...view.records.flatMap(recordLines),
    '</trace>',
  ]
  return `${lines.join('\n')}\n`
}
