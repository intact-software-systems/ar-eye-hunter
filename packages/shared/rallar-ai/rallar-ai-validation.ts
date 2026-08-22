import type { RallarAiJsonSchema, RallarAiValidationIssue, RallarAiValidationResult } from './rallar-ai-types.ts';

export function okRallarAiValidation(): RallarAiValidationResult {
    return {
        ok: true,
        errors: [],
        issues: []
    };
}

export function failRallarAiValidation(
    issues: readonly RallarAiValidationIssue[]
): RallarAiValidationResult {
    return {
        ok: issues.length === 0,
        errors: issues.map((issue) => `${issue.path}: ${issue.message}`),
        issues
    };
}

export function parseRallarAiJson(text: string): {
    ok: true;
    value: unknown;
} | {
    ok: false;
    validation: RallarAiValidationResult;
} {
    try {
        return {
            ok: true,
            value: JSON.parse(text)
        };
    }
    catch (error) {
        return {
            ok: false,
            validation: failRallarAiValidation([
                {
                    path: '$',
                    code: 'invalid-json',
                    message: error instanceof Error
                        ? error.message
                        : 'Generated text is not valid JSON.'
                }
            ])
        };
    }
}

export function validateRallarAiJsonSchemaValue(
    schema: unknown,
    value: unknown,
    path = '$'
): RallarAiValidationResult {
    const issues: RallarAiValidationIssue[] = [];
    validateAgainstSchema(asSchema(schema), value, path, issues);
    return issues.length === 0 ? okRallarAiValidation() : failRallarAiValidation(issues);
}

export function isRallarAiValidationOk(
    validation: RallarAiValidationResult
): boolean {
    return validation.ok && validation.issues.length === 0;
}

function validateAgainstSchema(
    schema: RallarAiJsonSchema,
    value: unknown,
    path: string,
    issues: RallarAiValidationIssue[]
): void {
    if (schema.const !== undefined && !jsonValueEquals(value, schema.const)) {
        issues.push({
            path,
            code: 'const-mismatch',
            message: 'Value does not match required const.'
        });
    }

    if (schema.enum && !schema.enum.some((entry) => jsonValueEquals(value, entry))) {
        issues.push({
            path,
            code: 'enum-mismatch',
            message: 'Value is not in the allowed enum.'
        });
    }

    if (schema.type !== undefined) {
        const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!allowedTypes.some((type) => matchesJsonSchemaType(value, type))) {
            issues.push({
                path,
                code: 'type-mismatch',
                message: `Expected ${allowedTypes.join(' or ')}.`
            });
            return;
        }
    }

    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) {
            issues.push({
                path,
                code: 'min-length',
                message: `Expected string length >= ${schema.minLength}.`
            });
        }
        if (schema.maxLength !== undefined && value.length > schema.maxLength) {
            issues.push({
                path,
                code: 'max-length',
                message: `Expected string length <= ${schema.maxLength}.`
            });
        }
    }

    if (typeof value === 'number') {
        if (schema.minimum !== undefined && value < schema.minimum) {
            issues.push({
                path,
                code: 'minimum',
                message: `Expected number >= ${schema.minimum}.`
            });
        }
        if (schema.maximum !== undefined && value > schema.maximum) {
            issues.push({
                path,
                code: 'maximum',
                message: `Expected number <= ${schema.maximum}.`
            });
        }
    }

    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) {
            issues.push({
                path,
                code: 'min-items',
                message: `Expected array length >= ${schema.minItems}.`
            });
        }
        if (schema.maxItems !== undefined && value.length > schema.maxItems) {
            issues.push({
                path,
                code: 'max-items',
                message: `Expected array length <= ${schema.maxItems}.`
            });
        }
        if (schema.items) {
            value.forEach((entry, index) => validateAgainstSchema(schema.items!, entry, `${path}[${index}]`, issues));
        }
    }

    if (isRecord(value)) {
        const properties = schema.properties ?? {};
        for (const requiredKey of schema.required ?? []) {
            if (!(requiredKey in value)) {
                issues.push({
                    path: `${path}.${requiredKey}`,
                    code: 'required',
                    message: 'Required property is missing.'
                });
            }
        }

        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                validateAgainstSchema(
                    propertySchema,
                    value[key],
                    `${path}.${key}`,
                    issues
                );
            }
        }

        if (schema.additionalProperties === false) {
            for (const key of Object.keys(value)) {
                if (!(key in properties)) {
                    issues.push({
                        path: `${path}.${key}`,
                        code: 'additional-property',
                        message: 'Additional property is not allowed.'
                    });
                }
            }
        }
        else if (
            schema.additionalProperties &&
            typeof schema.additionalProperties === 'object'
        ) {
            for (const [key, entry] of Object.entries(value)) {
                if (!(key in properties)) {
                    validateAgainstSchema(
                        schema.additionalProperties,
                        entry,
                        `${path}.${key}`,
                        issues
                    );
                }
            }
        }
    }
}

function asSchema(value: unknown): RallarAiJsonSchema {
    return isRecord(value) ? value as RallarAiJsonSchema : {};
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
    switch (type) {
        case 'null':
            return value === null;
        case 'boolean':
            return typeof value === 'boolean';
        case 'number':
            return typeof value === 'number' && Number.isFinite(value);
        case 'integer':
            return Number.isInteger(value);
        case 'string':
            return typeof value === 'string';
        case 'array':
            return Array.isArray(value);
        case 'object':
            return isRecord(value);
        default:
            return true;
    }
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(toStableJson(left)) === JSON.stringify(toStableJson(right));
}

function toStableJson(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(toStableJson);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, toStableJson(entry)])
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
