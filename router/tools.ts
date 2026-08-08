/**
 * Tool schema normalization for Freebuff compatibility.
 *
 * Some agent clients (LobeChat, Windsurf, Copilot) emit tool schemas that
 * Freebuff's backend can't parse:
 *   - JSON Schema `$ref` references (resolved against definitions)
 *   - Nullable type combinators: oneOf [{type: X}, {type: null}]
 *
 * This module normalizes those to flat, Freebuff-compatible schemas.
 */

type JSONSchema = Record<string, unknown>

/** Resolve $ref references recursively using root.definitions. */
function resolveRef(schema: JSONSchema, root: JSONSchema, depth = 0): JSONSchema {
  if (depth > 20) return schema // guard circular refs
  const ref = schema.$ref as string | undefined
  if (!ref) return schema

  const parts = ref.split('/')
  let target: JSONSchema | undefined = root
  for (const part of parts.slice(1)) {
    target = target?.[part] as JSONSchema | undefined
    if (!target) return schema
  }

  if (!target) return schema
  // Recurse to handle nested refs
  const resolved = { ...target }
  delete (resolved as { $ref?: string }).$ref
  return resolveRef(resolved, root, depth + 1)
}

/** Flatten nullable type combinators like oneOf [{type}, {type: null}]. */
function flattenNullable(schema: JSONSchema): JSONSchema {
  // oneOf / anyOf with a null type option → strip null branch, unwrap
  for (const key of ['oneOf', 'anyOf']) {
    const options = schema[key] as JSONSchema[] | undefined
    if (options && options.length > 0) {
      const nonNull = options.filter((o) => (o.type as string) !== 'null')
      if (nonNull.length === 1 && nonNull[0]?.type) {
        // Merge non-null option into schema, drop combinator
        const merged = { ...schema, ...nonNull[0] }
        delete (merged as { oneOf?: unknown }).oneOf
        delete (merged as { anyOf?: unknown }).anyOf
        return flattenNullable(merged)
      }
    }
  }
  return schema
}

/** Normalize a single JSON schema definition. */
function normalizeSchema(schema: JSONSchema, root?: JSONSchema): JSONSchema {
  const resolved = resolveRef(schema, root ?? schema)
  const flat = flattenNullable(resolved)

  // Recursively normalize nested properties and items
  if (flat.type === 'object' && flat.properties) {
    const props = flat.properties as Record<string, JSONSchema>
    flat.properties = {}
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === 'object' && v !== null) {
        (flat.properties as Record<string, JSONSchema>)[k] = normalizeSchema(v, root ?? flat)
      }
    }
  }
  if (flat.type === 'array' && flat.items) {
    const items = flat.items as JSONSchema
    if (typeof items === 'object' && items !== null) {
      flat.items = normalizeSchema(items, root ?? flat)
    }
  }
  return flat
}

/**
 * Normalize a tools array from an OpenAI chat request.
 * Strips $ref references and nullable type combinators that may cause
 * Freebuff's backend to reject the request.
 */
export function normalizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return tools

  return tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null) return tool

    const result: Record<string, unknown> = { ...tool }

    const functionDef = result.function as Record<string, unknown> | undefined
    if (functionDef?.parameters) {
      const params = functionDef.parameters as JSONSchema
      const root = params.definitions ? params : params
      result.function = {
        ...functionDef,
        parameters: normalizeSchema(params, root),
      }
    }

    return result
  })
}
