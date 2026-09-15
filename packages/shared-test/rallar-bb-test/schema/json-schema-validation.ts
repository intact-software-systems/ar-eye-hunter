export type JsonSchema = Readonly<{
    readonly $schema?: string;
    readonly $ref?: string;
    readonly $defs?: Readonly<Record<string, JsonSchema>>;
    readonly $id?: string;
    readonly title?: string;
    readonly description?: string;
    readonly type?: string | readonly string[];
    readonly enum?: readonly unknown[];
    readonly const?: unknown;
    readonly required?: readonly string[];
    readonly properties?: Readonly<Record<string, JsonSchema>>;
    readonly additionalProperties?: boolean | JsonSchema;
    readonly items?: JsonSchema;
    readonly oneOf?: readonly JsonSchema[];
    readonly anyOf?: readonly JsonSchema[];
    readonly requiredAnyOf?: readonly Readonly<{
        properties: readonly string[];
        message: string;
    }>[];
    readonly minimum?: number;
    readonly exclusiveMinimum?: number;
    readonly maximum?: number;
    readonly minItems?: number;
    readonly examples?: readonly unknown[];
    readonly default?: unknown;
}>;

export interface JsonSchemaValidationIssue {
    readonly path: string;
    readonly message: string;
}

export type JsonSchemaValidationResult =
    | Readonly<{ ok: true; errors: readonly []; }>
    | Readonly<{ ok: false; errors: readonly JsonSchemaValidationIssue[]; }>;

interface SchemaNodeInput {
    readonly schema: JsonSchema;
    readonly root: JsonSchema;
    readonly value: unknown;
    readonly path: string;
    readonly errors: JsonSchemaValidationIssue[];
}
export function validateJsonSchema(schema: JsonSchema, value: unknown): JsonSchemaValidationResult {
    const errors: JsonSchemaValidationIssue[] = [];
    validateNode({ schema, root: schema, value, path: '$', errors });
    return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}
export function formatJsonSchemaValidationErrors(errors: readonly JsonSchemaValidationIssue[]): string {
    return errors.map((error) => `${error.path}: ${error.message}`).join('\n');
}
function validateNode(input: SchemaNodeInput): void {
    const { schema, value, path, errors } = input;
    const current = schema.$id ? { ...input, root: schema } : input;
    if (schema.$ref) {
        validateReference(current);
        return;
    }
    if (schema.const !== undefined && !isSameJsonValue(schema.const, value)) {
        errors.push({ path, message: `Expected ${JSON.stringify(schema.const)}.` });
        return;
    }
    if (schema.enum && !schema.enum.some((candidate) => isSameJsonValue(candidate, value))) {
        errors.push({
            path,
            message: `Expected one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}.`
        });
        return;
    }
    if (schema.oneOf || schema.anyOf) {
        validateAlternatives(current);
        return;
    }
    if (schema.type && !isExpectedType(value, schema.type)) {
        const typeText = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
        errors.push({ path, message: `Expected ${typeText}.` });
        return;
    }
    validateBounds(current);
    if (schema.items && Array.isArray(value)) {
        const items = schema.items;
        value.forEach((entry, index) =>
            validateNode({ ...current, schema: items, value: entry, path: `${path}[${index}]` })
        );
    }
    if (isJsonRecordValue(value)) {
        validateObjectProperties({ ...current, value });
    }
}
function validateReference(input: SchemaNodeInput): void {
    const reference = input.schema.$ref;
    const name = reference?.startsWith('#/$defs/')
        ? reference.slice(8).replaceAll('~1', '/').replaceAll('~0', '~')
        : undefined;
    const schema = name === undefined ? undefined : input.root.$defs?.[name];
    if (!schema) {
        input.errors.push({ path: input.path, message: `Unresolved schema reference ${reference}.` });
        return;
    }
    validateNode({ ...input, schema });
}
function validateAlternatives(input: SchemaNodeInput): void {
    const { schema, value, path, errors } = input;
    if (schema.oneOf) {
        const discriminated = toDiscriminatedSchema(schema.oneOf, value);
        if (discriminated) {
            validateNode({ ...input, schema: discriminated });
            return;
        }
        const matches = schema.oneOf.filter((candidate) =>
            toValidationErrors({ ...input, schema: candidate }).length === 0
        ).length;
        if (matches !== 1) {
            errors.push({ path, message: `Expected value to match exactly one schema, matched ${matches}.` });
        }
    }
    else if (
        schema.anyOf &&
        !schema.anyOf.some((candidate) => toValidationErrors({ ...input, schema: candidate }).length === 0)
    ) {
        errors.push({ path, message: 'Expected value to match at least one schema.' });
    }
}
function validateBounds(input: SchemaNodeInput): void {
    const { schema, value, path, errors } = input;
    if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
        errors.push({ path, message: `Expected number >= ${schema.minimum}.` });
    }
    if (typeof schema.exclusiveMinimum === 'number' && typeof value === 'number' && value <= schema.exclusiveMinimum) {
        errors.push({ path, message: `Expected number > ${schema.exclusiveMinimum}.` });
    }
    if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
        errors.push({ path, message: `Expected number <= ${schema.maximum}.` });
    }
    if (typeof schema.minItems === 'number' && Array.isArray(value) && value.length < schema.minItems) {
        errors.push({ path, message: `Expected at least ${schema.minItems} item(s).` });
    }
}
interface SchemaObjectInput extends SchemaNodeInput {
    readonly value: Record<string, unknown>;
}
function validateObjectProperties(input: SchemaObjectInput): void {
    const { schema, value, path, errors } = input;
    for (const property of schema.required ?? []) {
        if (value[property] === undefined) {
            errors.push({ path, message: `Missing required property ${property}.` });
        }
    }
    for (const requirement of schema.requiredAnyOf ?? []) {
        if (!requirement.properties.some((property) => value[property] !== undefined)) {
            errors.push({ path, message: requirement.message });
        }
    }
    const properties = schema.properties ?? {};
    for (const [property, child] of Object.entries(properties)) {
        if (value[property] !== undefined) {
            validateNode({ ...input, schema: child, value: value[property], path: toChildPath(path, property) });
        }
    }
    for (const [property, child] of Object.entries(value)) {
        if (Object.hasOwn(properties, property)) {
            continue;
        }
        if (schema.additionalProperties === false) {
            errors.push({ path: toChildPath(path, property), message: 'Unexpected property.' });
        }
        else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
            validateNode({
                ...input,
                schema: schema.additionalProperties,
                value: child,
                path: toChildPath(path, property)
            });
        }
    }
}
function toValidationErrors(input: SchemaNodeInput): JsonSchemaValidationIssue[] {
    const errors: JsonSchemaValidationIssue[] = [];
    validateNode({ ...input, errors });
    return errors;
}
function toDiscriminatedSchema(candidates: readonly JsonSchema[], value: unknown): JsonSchema | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    if (typeof value.kind === 'string') {
        return candidates.find((candidate) => candidate.properties?.kind?.const === value.kind);
    }
    if (typeof value.aggregate === 'string') {
        return candidates.find((candidate) => candidate.properties?.aggregate?.const === value.aggregate);
    }
    return undefined;
}
function isExpectedType(value: unknown, expected: string | readonly string[]): boolean {
    if (Array.isArray(expected)) {
        return expected.some((type) => isExpectedType(value, type));
    }

    switch (expected) {
        case 'array':
            return Array.isArray(value);
        case 'boolean':
            return typeof value === 'boolean';
        case 'integer':
            return Number.isInteger(value);
        case 'null':
            return value === null;
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'object':
            return isJsonRecordValue(value);
        case 'string':
            return typeof value === 'string';
        default:
            return true;
    }
}

function isSameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function isJsonRecordValue(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toChildPath(parent: string, property: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
        ? `${parent}.${property}`
        : `${parent}[${JSON.stringify(property)}]`;
}
