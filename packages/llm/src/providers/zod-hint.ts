import type { z } from "zod";

/**
 * Minimal zod -> JSON-Schema-ish hint generator. Covers exactly the constructs
 * VibeFix schemas use (object/array/string/number/boolean/enum/literal/
 * optional/nullable/record/union of literals). Avoids a zod-to-json-schema
 * dependency; anything unrecognized degrades to a permissive hint.
 */
export function zodHint(schema: z.ZodTypeAny): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;

  switch (def?.typeName) {
    case "ZodObject": {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(def.shape() as Record<string, z.ZodTypeAny>)) {
        properties[key] = zodHint(value);
        const valueDef = (value as any)._def;
        if (valueDef?.typeName !== "ZodOptional") required.push(key);
      }
      return { type: "object", properties, required };
    }
    case "ZodArray":
      return { type: "array", items: zodHint(def.type) };
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodLiteral":
      return { const: def.value };
    case "ZodEnum":
    case "ZodNativeEnum": {
      const values = def.values as Record<string, unknown> | undefined;
      return { enum: values ? Object.values(values) : [] };
    }
    case "ZodOptional":
      return zodHint(def.innerType);
    case "ZodNullable":
      return { anyOf: [zodHint(def.innerType), { type: "null" }] };
    case "ZodDefault":
      return zodHint(def.innerType);
    case "ZodRecord":
      return { type: "object", additionalProperties: zodHint(def.valueType) };
    case "ZodUnion": {
      const options = (def.options as z.ZodTypeAny[]) ?? [];
      return { anyOf: options.map(zodHint) };
    }
    case "ZodIntersection":
      return { allOf: [zodHint(def.left), zodHint(def.right)] };
    case "ZodEffects":
      return zodHint(def.schema);
    default:
      return { description: "any valid JSON value" };
  }
}
