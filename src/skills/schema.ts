// Provenance: exact pinned source and transformation are recorded in vendor/baby-provenance/file-map.json.
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
  'description',
]);

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(label: string, message: string): never {
  throw new SkillValidationError(`${label}: ${message}`);
}

function assertSchemaShape(schema: unknown, label: string, depth = 0): asserts schema is Record<string, unknown> {
  if (depth > 32) fail(label, 'schema nesting exceeds 32 levels');
  if (!isObject(schema)) fail(label, 'schema must be an object');
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_SCHEMA_KEYS.has(key)) fail(label, `unsupported schema keyword ${key}`);
  }
  if (schema.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(schema.type))) {
    fail(label, 'unsupported type');
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) fail(label, 'properties must be an object');
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSchemaShape(child, `${label}.properties.${key}`, depth + 1);
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string')) {
      fail(label, 'required must be an array of strings');
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    fail(label, 'additionalProperties must be boolean');
  }
  if (schema.items !== undefined) assertSchemaShape(schema.items, `${label}.items`, depth + 1);
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    fail(label, 'enum must be a non-empty array');
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== 'string') fail(label, 'pattern must be a string');
    try { new RegExp(schema.pattern); } catch { fail(label, 'pattern is invalid'); }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (schema[key] !== undefined && (!Number.isSafeInteger(schema[key]) || Number(schema[key]) < 0)) {
      fail(label, `${key} must be a non-negative integer`);
    }
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (schema[key] !== undefined && typeof schema[key] !== 'number') fail(label, `${key} must be a number`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(schema: Record<string, unknown>, value: unknown, label: string): void {
  if (schema.const !== undefined && !deepEqual(value, schema.const)) fail(label, 'does not match const');
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) fail(label, 'is not in enum');
  const type = schema.type;
  if (type === 'null' && value !== null) fail(label, 'must be null');
  if (type === 'boolean' && typeof value !== 'boolean') fail(label, 'must be boolean');
  if (type === 'string') {
    if (typeof value !== 'string') fail(label, 'must be string');
    if (schema.minLength !== undefined && value.length < Number(schema.minLength)) fail(label, 'is too short');
    if (schema.maxLength !== undefined && value.length > Number(schema.maxLength)) fail(label, 'is too long');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail(label, 'does not match pattern');
  }
  if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(label, 'must be a finite number');
    if (type === 'integer' && !Number.isInteger(value)) fail(label, 'must be integer');
    if (schema.minimum !== undefined && value < Number(schema.minimum)) fail(label, 'is below minimum');
    if (schema.maximum !== undefined && value > Number(schema.maximum)) fail(label, 'is above maximum');
  }
  if (type === 'array') {
    if (!Array.isArray(value)) fail(label, 'must be array');
    if (schema.minItems !== undefined && value.length < Number(schema.minItems)) fail(label, 'has too few items');
    if (schema.maxItems !== undefined && value.length > Number(schema.maxItems)) fail(label, 'has too many items');
    if (isObject(schema.items)) value.forEach((item, index) => validate(schema.items as Record<string, unknown>, item, `${label}[${index}]`));
  }
  if (type === 'object') {
    if (!isObject(value)) fail(label, 'must be object');
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) if (!(key in value)) fail(label, `missing required property ${key}`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) fail(label, `unknown property ${key}`);
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) validate(child as Record<string, unknown>, value[key], `${label}.${key}`);
    }
  }
}

export function compileJsonSchema(schema: unknown, label: string): (value: unknown) => void {
  assertSchemaShape(schema, label);
  const compiled = schema as Record<string, unknown>;
  return (value: unknown) => validate(compiled, value, label);
}

export function assertJsonSerializable(value: unknown, label: string): void {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail(label, 'result is not JSON serializable');
    JSON.parse(encoded);
  } catch (error) {
    if (error instanceof SkillValidationError) throw error;
    fail(label, 'result is not JSON serializable');
  }
}
