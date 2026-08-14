export type JsonSchema = Readonly<{
    $schema?: string;
    $id?: string;
    title?: string;
    description?: string;
    type?: string | readonly string[];
    enum?: readonly unknown[];
    const?: unknown;
    required?: readonly string[];
    properties?: Readonly<Record<string, JsonSchema>>;
    additionalProperties?: boolean | JsonSchema;
    items?: JsonSchema;
    oneOf?: readonly JsonSchema[];
    anyOf?: readonly JsonSchema[];
    requiredAnyOf?: readonly Readonly<{
        properties: readonly string[];
        message: string;
    }>[];
    minimum?: number;
    exclusiveMinimum?: number;
    maximum?: number;
    minItems?: number;
    examples?: readonly unknown[];
    default?: unknown;
}>;

export type JsonSchemaValidationIssue = Readonly<{
    path: string;
    message: string;
}>;

export type JsonSchemaValidationResult =
    | Readonly<{ ok: true; errors: readonly [] }>
    | Readonly<{ ok: false; errors: readonly JsonSchemaValidationIssue[] }>;

export function validateJsonSchema(schema: JsonSchema, value: unknown): JsonSchemaValidationResult {
    const errors: JsonSchemaValidationIssue[] = [];
    validateNode(schema, value, '$', errors);
    return errors.length === 0
        ? { ok: true, errors: [] }
        : { ok: false, errors };
}

export function formatJsonSchemaValidationErrors(
    errors: readonly JsonSchemaValidationIssue[],
): string {
    return errors.map(error => `${error.path}: ${error.message}`).join('\n');
}

function validateNode(
    schema: JsonSchema,
    value: unknown,
    path: string,
    errors: JsonSchemaValidationIssue[],
): void {
    if (schema.const !== undefined && !sameJsonValue(schema.const, value)) {
        errors.push({ path, message: `Expected ${JSON.stringify(schema.const)}.` });
        return;
    }

    if (schema.enum && !schema.enum.some(candidate => sameJsonValue(candidate, value))) {
        const enumText = schema.enum.map(candidate => JSON.stringify(candidate)).join(', ');
        errors.push({ path, message: `Expected one of ${enumText}.` });
        return;
    }

    if (schema.oneOf) {
        const discriminated = discriminatedOneOfSchema(schema.oneOf, value);
        if (discriminated) {
            validateNode(discriminated, value, path, errors);
            return;
        }

        const matches = schema.oneOf
            .map(candidate => validationErrors(candidate, value, path).length === 0)
            .filter(Boolean).length;
        if (matches !== 1) {
            errors.push({
                path,
                message: `Expected value to match exactly one schema, matched ${matches}.`,
            });
        }
        return;
    }

    if (schema.anyOf) {
        const matches = schema.anyOf
            .some(candidate => validationErrors(candidate, value, path).length === 0);
        if (!matches) {
            errors.push({ path, message: 'Expected value to match at least one schema.' });
        }
        return;
    }

    if (schema.type && !matchesType(value, schema.type)) {
        const typeText = Array.isArray(schema.type) ? schema.type.join(' or ') : schema.type;
        errors.push({ path, message: `Expected ${typeText}.` });
        return;
    }

    if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
        errors.push({ path, message: `Expected number >= ${schema.minimum}.` });
    }

    if (
        typeof schema.exclusiveMinimum === 'number' &&
        typeof value === 'number' &&
        value <= schema.exclusiveMinimum
    ) {
        errors.push({ path, message: `Expected number > ${schema.exclusiveMinimum}.` });
    }

    if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
        errors.push({ path, message: `Expected number <= ${schema.maximum}.` });
    }

    if (
        typeof schema.minItems === 'number' && Array.isArray(value) &&
        value.length < schema.minItems
    ) {
        errors.push({ path, message: `Expected at least ${schema.minItems} item(s).` });
    }

    if (schema.items && Array.isArray(value)) {
        value.forEach((entry, index) => {
            validateNode(schema.items as JsonSchema, entry, `${path}[${index}]`, errors);
        });
    }

    if (schema.required && isJsonRecordValue(value)) {
        for (const property of schema.required) {
            if (value[property] === undefined) {
                errors.push({ path, message: `Missing required property ${property}.` });
            }
        }
    }

    if (schema.requiredAnyOf && isJsonRecordValue(value)) {
        for (const requirement of schema.requiredAnyOf) {
            if (!requirement.properties.some(property => value[property] !== undefined)) {
                errors.push({ path, message: requirement.message });
            }
        }
    }

    if (!isJsonRecordValue(value)) {
        return;
    }

    const propertySchemas = schema.properties ?? {};
    for (const [property, propertySchema] of Object.entries(propertySchemas)) {
        if (value[property] !== undefined) {
            validateNode(propertySchema, value[property], childPath(path, property), errors);
        }
    }

    const knownProperties = new Set(Object.keys(propertySchemas));
    for (const [property, propertyValue] of Object.entries(value)) {
        if (knownProperties.has(property)) {
            continue;
        }

        if (schema.additionalProperties === false) {
            errors.push({ path: childPath(path, property), message: 'Unexpected property.' });
            continue;
        }

        if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
            validateNode(
                schema.additionalProperties,
                propertyValue,
                childPath(path, property),
                errors,
            );
        }
    }
}

function validationErrors(
    schema: JsonSchema,
    value: unknown,
    path: string,
): JsonSchemaValidationIssue[] {
    const errors: JsonSchemaValidationIssue[] = [];
    validateNode(schema, value, path, errors);
    return errors;
}

function discriminatedOneOfSchema(
    candidates: readonly JsonSchema[],
    value: unknown,
): JsonSchema | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }

    const kind = value.kind;
    if (typeof kind === 'string') {
        return candidates.find(candidate => candidate.properties?.kind?.const === kind);
    }

    const aggregate = value.aggregate;
    if (typeof aggregate === 'string') {
        return candidates.find(candidate => candidate.properties?.aggregate?.const === aggregate);
    }

    return undefined;
}

function matchesType(value: unknown, expected: string | readonly string[]): boolean {
    if (Array.isArray(expected)) {
        return expected.some(type => matchesType(value, type));
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

function sameJsonValue(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function isJsonRecordValue(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function childPath(parent: string, property: string): string {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
        ? `${parent}.${property}`
        : `${parent}[${JSON.stringify(property)}]`;
}
