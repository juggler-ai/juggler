//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema-driven type coercion for LLM tool inputs.
 *
 * LLMs occasionally emit a JSON-schema number/integer/boolean as a string
 * (e.g. `offset: "40"` instead of `40`). That is a *type* mismatch, not a
 * *semantic* one — the value 40 is perfectly valid. Rather than each tool
 * re-implementing string parsing (and diverging on how lenient to be), the
 * framework coerces at the single `prepare()` boundary, driven by the tool's
 * own declared `input_schema`. This mirrors ajv's `coerceTypes` semantics: a
 * bounded, lossless transform, not a heuristic.
 *
 * Rules (deliberately conservative — never mask a genuinely malformed value):
 * - Only string values are ever touched. Already-typed values pass through.
 * - `integer`: coerce only a string matching an integral literal (`"40"`,
 *   `" -3 "`). `"40.5"` is left alone so it surfaces as an error.
 * - `number`: coerce only a string that is a finite numeric literal.
 * - `boolean`: coerce only `"true"` / `"false"` (case-insensitive, trimmed).
 * - Never coerce in the other direction (number → string): that would hide
 *   genuine type confusion, and string-typed params want their strings.
 * - A property whose declared type is ambiguous across an item's tool
 *   definitions (e.g. number in one, string in another) is left untouched.
 * @module sdk/coerce-schema-types
 */

const INTEGER_RE = /^[+-]?\d+$/;
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Coerce a single string value to the declared scalar type, or return the
 * original value unchanged when it cannot be losslessly coerced.
 * @param {unknown} value - Raw value from the LLM tool input
 * @param {string} type - JSON-schema declared type ('integer'|'number'|'boolean')
 * @returns {unknown} Coerced value, or the original value if not coercible
 */
function coerceScalar(value, type) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;

  if (type === 'integer') {
    if (!INTEGER_RE.test(trimmed)) return value;
    const n = Number(trimmed);
    return Number.isInteger(n) ? n : value;
  }

  if (type === 'number') {
    if (!NUMBER_RE.test(trimmed)) return value;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : value;
  }

  if (type === 'boolean') {
    const lower = trimmed.toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
    return value;
  }

  return value;
}

/**
 * Build a map of property name → declared scalar type from one or more
 * JSON-schema objects. A property is only included when every schema that
 * declares it agrees on a single coercible scalar type; conflicting or
 * non-scalar declarations are dropped so they are never coerced.
 * @param {Array<object|undefined>} schemas - input_schema objects
 * @returns {Map<string, string>} property name → coercible scalar type
 */
export function buildPropertyTypeMap(schemas) {
  /** @type {Map<string, string|null>} */
  const merged = new Map();

  for (const schema of schemas) {
    const properties = schema && 'properties' in schema ? schema.properties : undefined;
    if (!properties || typeof properties !== 'object') continue;

    /** @type {Array<[string, unknown]>} */
    const entries = Object.entries(properties);
    for (const [name, def] of entries) {
      const type = def && typeof def === 'object' && 'type' in def ? def.type : undefined;
      const coercible = type === 'integer' || type === 'number' || type === 'boolean' ? type : null;

      if (!merged.has(name)) {
        merged.set(name, coercible);
      } else if (merged.get(name) !== coercible) {
        // Disagreement across schemas → ambiguous, never coerce.
        merged.set(name, null);
      }
    }
  }

  /** @type {Map<string, string>} */
  const result = new Map();
  for (const [name, type] of merged) {
    if (type) result.set(name, type);
  }
  return result;
}

/**
 * Return a shallow copy of `toolInput` with string values coerced to the
 * scalar types declared in the given schema(s). The input object is never
 * mutated. When nothing is coercible the original object is returned as-is.
 * @param {Record<string, unknown>} toolInput - Raw parameters from the LLM
 * @param {object|Array<object|undefined>|undefined} schemaOrSchemas - One input_schema or several
 * @returns {Record<string, unknown>} Coerced parameters
 */
export function coerceToolInputToSchema(toolInput, schemaOrSchemas) {
  if (!toolInput || typeof toolInput !== 'object') return toolInput;

  const schemas = Array.isArray(schemaOrSchemas) ? schemaOrSchemas : [schemaOrSchemas];
  const typeMap = buildPropertyTypeMap(schemas);
  if (typeMap.size === 0) return toolInput;

  let copy = null;
  for (const [name, type] of typeMap) {
    if (!(name in toolInput)) continue;
    const original = toolInput[name];
    const coerced = coerceScalar(original, type);
    if (coerced !== original) {
      if (!copy) copy = { ...toolInput };
      copy[name] = coerced;
    }
  }

  return copy || toolInput;
}
