import { z } from 'zod'
import { nonemptyTextSchema, timestampSchema } from '../domain/schemas.ts'

const text = nonemptyTextSchema

export type OtelAnyValue = {
  stringValue?: string | undefined
  boolValue?: boolean | undefined
  intValue?: string | number | undefined
  doubleValue?: number | undefined
  bytesValue?: string | undefined
  arrayValue?: { values: OtelAnyValue[] } | undefined
  kvlistValue?: { values: Array<{ key: string; value: OtelAnyValue }> } | undefined
}
export const otelAnyValueSchema: z.ZodType<OtelAnyValue> = z.lazy(() =>
  z
    .object({
      stringValue: z.string().optional(),
      boolValue: z.boolean().optional(),
      intValue: z
        .union([
          z.string().regex(/^-?\d+$/, 'intValue must be an integer'),
          z.number().int().safe(),
        ])
        .optional(),
      doubleValue: z.number().optional(),
      bytesValue: z.string().optional(),
      arrayValue: z.object({ values: z.array(otelAnyValueSchema) }).optional(),
      kvlistValue: z
        .object({ values: z.array(z.object({ key: text, value: otelAnyValueSchema })) })
        .optional(),
    })
    .superRefine((value, context) => {
      if (Object.values(value).filter((entry) => entry !== undefined).length !== 1)
        context.addIssue({ code: 'custom', message: 'OTLP AnyValue must contain one value' })
    }),
)
export const otelAttributesSchema = z.array(z.object({ key: text, value: otelAnyValueSchema }))
const id = (length: number) =>
  z
    .string()
    .regex(new RegExp(`^[0-9a-fA-F]{${length}}$`))
    .refine((value) => !/^0+$/.test(value), `must be a nonzero ${length}-digit hexadecimal ID`)
export const otelTraceSchema = z.object({
  resourceSpans: z.array(
    z.object({
      resource: z.object({ attributes: otelAttributesSchema.optional() }).optional(),
      scopeSpans: z.array(
        z.object({
          spans: z.array(
            z.object({
              traceId: id(32),
              spanId: id(16),
              parentSpanId: z.union([z.literal(''), id(16)]).optional(),
              name: text,
              startTimeUnixNano: timestampSchema,
              endTimeUnixNano: timestampSchema,
              attributes: otelAttributesSchema.optional(),
              events: z
                .array(
                  z.object({
                    name: text,
                    timeUnixNano: timestampSchema,
                    attributes: otelAttributesSchema.optional(),
                  }),
                )
                .optional(),
            }),
          ),
        }),
      ),
    }),
  ),
})
