import { z } from 'zod';
import { cleanText } from '../bot/tools/tool.js';

/** Up to this many parameters per action. */
export const MAX_ACTION_PARAMETERS = 8;
/** The longest `maxLength` a string parameter may declare. */
export const MAX_STRING_LENGTH = 500;

const description = z.string().trim().min(1).max(300).optional();

const stringParameter = z
  .object({
    type: z.literal('string'),
    description,
    maxLength: z.number().int().min(1).max(MAX_STRING_LENGTH),
  })
  .strict();
const enumParameter = z
  .object({
    type: z.literal('string'),
    description,
    enum: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length, {
        message: 'values must be unique',
      }),
  })
  .strict();
const numberParameter = z
  .object({
    type: z.enum(['number', 'integer']),
    description,
    minimum: z.number().optional(),
    maximum: z.number().optional(),
  })
  .strict()
  .refine(
    (p) =>
      p.minimum === undefined ||
      p.maximum === undefined ||
      p.minimum <= p.maximum,
    { message: 'minimum must not exceed maximum' },
  );
const booleanParameter = z
  .object({ type: z.literal('boolean'), description })
  .strict();

const parameter = z.union([
  enumParameter,
  stringParameter,
  numberParameter,
  booleanParameter,
]);
export type ActionParameter = z.infer<typeof parameter>;

const PARAMETER_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * An action's arguments: a JSON Schema subset (`string` with `maxLength`,
 * `string` with `enum`, `number`, `integer`, `boolean`, and `required`), up
 * to {@link MAX_ACTION_PARAMETERS} parameters.
 */
export const actionParametersSchema = z
  .object({
    type: z.literal('object').default('object'),
    properties: z
      .record(
        z.string().regex(PARAMETER_NAME, {
          message: 'parameter names are snake_case',
        }),
        parameter,
      )
      .refine((p) => Object.keys(p).length <= MAX_ACTION_PARAMETERS, {
        message: `at most ${MAX_ACTION_PARAMETERS} parameters`,
      }),
    required: z.array(z.string()).default([]),
  })
  .strict()
  .refine((s) => s.required.every((name) => name in s.properties), {
    message: 'required lists an unknown parameter',
    path: ['required'],
  })
  .transform((s) => ({ ...s, required: [...new Set(s.required)] }));
export type ActionParameters = z.infer<typeof actionParametersSchema>;

function isEnum(
  p: ActionParameter,
): p is Extract<ActionParameter, { enum: string[] }> {
  return 'enum' in p;
}

/**
 * The strict JSON Schema the model gets: every parameter listed in
 * `required` (strict mode), the optional ones nullable.
 */
export function actionJsonSchema(
  parameters: ActionParameters,
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, p] of Object.entries(parameters.properties)) {
    const optional = !parameters.required.includes(name);
    const type = optional ? [p.type, 'null'] : p.type;
    const schema: Record<string, unknown> = { type };
    if (p.description) {
      schema.description = p.description;
    }
    if (isEnum(p)) {
      schema.enum = optional ? [...p.enum, null] : p.enum;
    } else if (p.type === 'string') {
      schema.maxLength = p.maxLength;
    } else if (p.type === 'number' || p.type === 'integer') {
      if (p.minimum !== undefined) schema.minimum = p.minimum;
      if (p.maximum !== undefined) schema.maximum = p.maximum;
    }
    properties[name] = schema;
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function valueSchema(p: ActionParameter): z.ZodType {
  if (isEnum(p)) {
    return z.enum(p.enum as [string, ...string[]]);
  }
  switch (p.type) {
    case 'string':
      // One-line plain text, as every tool argument.
      return z
        .string()
        .transform(cleanText)
        .pipe(z.string().min(1).max(p.maxLength));
    case 'number':
    case 'integer': {
      let schema = p.type === 'integer' ? z.number().int() : z.number();
      if (p.minimum !== undefined) schema = schema.min(p.minimum);
      if (p.maximum !== undefined) schema = schema.max(p.maximum);
      return schema;
    }
    case 'boolean':
      return z.boolean();
  }
}

/**
 * Validates the model's (or a tester's) arguments against the action's
 * parameters. Unknown keys are rejected; a null optional parameter is left
 * out of the result.
 */
export function actionArgumentsSchema(
  parameters: ActionParameters,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(parameters.properties)) {
    const value = valueSchema(p);
    shape[name] = parameters.required.includes(name)
      ? value
      : value.nullable().optional();
  }
  return z
    .object(shape)
    .strict()
    .transform(
      (args) =>
        Object.fromEntries(
          Object.entries(args).filter(([, v]) => v !== null && v !== undefined),
        ) as Record<string, unknown>,
    );
}
