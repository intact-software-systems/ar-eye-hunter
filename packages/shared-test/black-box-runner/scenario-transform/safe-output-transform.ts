// deno-lint-ignore-file no-explicit-any

import {
    isSafeOutputTransformRecord,
    rejectSafeOutputTransform,
    resolveSafeOutputTransformPath,
    resolveSafeOutputTransformTemplate,
    SafeOutputTransformError,
    stringifySafeOutputTransformValue,
    type SafeOutputTransformDetails,
    type SafeOutputTransformEvaluationInput
} from './safe-output-transform-resolution.ts';

const DIRECT_TRANSFORM_KEYS = [
    'path',
    'from',
    'template',
    'concat',
    'coalesce',
    'add',
    'max',
    'equals',
    'lexicallyBefore',
    'get',
    'includes',
    'if',
    'jsonStringify',
    'jsonParse',
    'urlEncode',
    'number',
    'string',
    'boolean',
    'uuid',
    'timestamp',
    'op',
    'operator'
] as const;

const TRANSFORM_ONLY_KEYS = new Set([
    ...DIRECT_TRANSFORM_KEYS,
    'outputPath',
    'type',
    'value',
    'input',
    'values',
    'condition',
    'then',
    'else',
    'format',
    'secret',
    'redact',
    'redactAs',
    'transform'
]);

const IMPLICIT_TRANSFORM_OPERATORS = DIRECT_TRANSFORM_KEYS.filter(
    (key) => key !== 'op' && key !== 'operator'
);

interface TransformOperatorEvaluation {
    readonly spec: Record<string, any>;
    readonly input: SafeOutputTransformEvaluationInput;
    readonly details: SafeOutputTransformDetails;
}

export { SafeOutputTransformError };

export function directSafeOutputTransformSpec(spec: Record<string, any>): any {
    return DIRECT_TRANSFORM_KEYS.some((key) => spec[key] !== undefined) ? spec : undefined;
}

export function isSafeOutputTransformOnlySpec(spec: Record<string, any>): boolean {
    const keys = Object.keys(spec);
    return (
        keys.length > 0 &&
        directSafeOutputTransformSpec(spec) !== undefined &&
        keys.every((key) => TRANSFORM_ONLY_KEYS.has(key))
    );
}

export function evaluateSafeOutputTransform(
    specInput: any,
    input: SafeOutputTransformEvaluationInput
): any {
    const spec = isSafeOutputTransformRecord(specInput)
        ? asTransformSpec(specInput)
        : { value: specInput };
    const operator = String(
        spec.op ?? spec.operator ?? spec.type ?? firstTransformOperator(spec) ?? 'value'
    );
    const details: SafeOutputTransformDetails = { operator, path: input.operatorPath };

    switch (operator) {
        case 'path':
        case 'from':
        case 'outputPath':
            return resolveSafeOutputTransformPath(spec.path ?? spec.from ?? spec.outputPath, input);
        case 'template':
            return evaluateTemplateTransform(spec, input, details);
        case 'concat':
            return evaluateConcatTransform(spec, input, details);
        case 'coalesce':
            return evaluateCoalesceTransform(spec, input, details);
        case 'add':
        case 'max':
            return evaluateNumericTransform({ spec, input, details });
        case 'equals':
            return evaluateEqualsTransform(spec, input, details);
        case 'lexicallyBefore':
            return evaluateLexicallyBeforeTransform(spec, input, details);
        case 'get':
            return evaluateGetTransform(spec, input, details);
        case 'includes':
            return evaluateIncludesTransform(spec, input, details);
        case 'if':
            return evaluateIfTransform(spec, input, details);
        case 'jsonStringify':
        case 'jsonParse':
            return evaluateJsonTransform({ spec, input, details });
        case 'urlEncode':
        case 'number':
        case 'string':
        case 'boolean':
            return evaluateScalarTransform({ spec, input, details });
        case 'uuid':
            return input.createUuid();
        case 'timestamp':
            return spec.format === 'iso'
                ? new Date(input.readTimestamp()).toISOString()
                : input.readTimestamp();
        default:
            return evaluateValueOrReject({ spec, input, details });
    }
}

function evaluateTemplateTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): any {
    if (typeof spec.template !== 'string') {
        return rejectSafeOutputTransform('Template transform requires a string template.', details);
    }
    return resolveSafeOutputTransformTemplate(spec.template, input);
}

function evaluateConcatTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): string {
    const parts = transformValues(spec, 'concat');
    if (parts.length <= 0) {
        return rejectSafeOutputTransform(
            'Concat transform requires a non-empty values array.',
            details
        );
    }
    return parts
        .map((part) => stringifySafeOutputTransformValue(evaluateTransformValue(part, input)))
        .join('');
}

function evaluateCoalesceTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): any {
    const values = transformValues(spec, 'coalesce');
    if (values.length <= 0) {
        return rejectSafeOutputTransform(
            'Coalesce transform requires a non-empty values array.',
            details
        );
    }
    for (const value of values) {
        try {
            const resolved = evaluateTransformValue(value, input);
            if (isNonEmptyTransformValue(resolved)) {
                return resolved;
            }
        }
        catch (_error) {
            // Missing optional values are ignored by coalesce.
        }
    }
    return rejectSafeOutputTransform('Coalesce transform did not find a non-empty value.', details);
}

function evaluateNumericTransform(evaluation: TransformOperatorEvaluation): number {
    const { spec, input, details } = evaluation;
    const operator = details.operator as 'add' | 'max';
    const values = transformValues(spec, operator);
    if (values.length <= 0) {
        return rejectSafeOutputTransform(
            `${operator} transform requires a non-empty values array.`,
            details
        );
    }
    const numbers = values.map((value, index) =>
        toTransformNumber(evaluateTransformValue(value, input), { ...details, index })
    );
    return operator === 'add'
        ? toTransformNumber(
            numbers.reduce((sum, value) => sum + value, 0),
            details
        )
        : Math.max(...numbers);
}

function evaluateEqualsTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): boolean {
    const values = transformValues(spec, 'equals');
    if (values.length !== 2) {
        return rejectSafeOutputTransform('Equals transform requires exactly two values.', details);
    }
    return Object.is(
        evaluateTransformValue(values[0], input),
        evaluateTransformValue(values[1], input)
    );
}

function evaluateLexicallyBeforeTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): boolean {
    const values = transformValues(spec, 'lexicallyBefore')
        .map((value) => evaluateTransformValue(value, input));
    if (values.length !== 2 || values.some((value) => typeof value !== 'string')) {
        return rejectSafeOutputTransform(
            'Lexically-before transform requires exactly two string values.',
            { ...details, input: values }
        );
    }
    return values[0] < values[1];
}

function evaluateGetTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): any {
    const values = transformValues(spec, 'get')
        .map((value) => evaluateTransformValue(value, input));
    if (values.length !== 2) {
        return rejectSafeOutputTransform('Get transform requires a value and a property key.', details);
    }

    const [value, key] = values;
    if (
        (!Array.isArray(value) && !isSafeOutputTransformRecord(value)) ||
        (typeof key !== 'string' && typeof key !== 'number')
    ) {
        return rejectSafeOutputTransform(
            'Get transform requires an array or object and a string or number property key.',
            { ...details, input: values }
        );
    }
    if (!Object.hasOwn(value, key)) {
        return rejectSafeOutputTransform('Get transform property does not exist.', {
            ...details,
            input: key
        });
    }
    return (value as Record<string | number, any>)[key];
}

function evaluateIncludesTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): boolean {
    const values = transformValues(spec, 'includes')
        .map((value) => evaluateTransformValue(value, input));
    if (values.length !== 2) {
        return rejectSafeOutputTransform('Includes transform requires a collection and a value.', details);
    }

    const [collection, expected] = values;
    if (Array.isArray(collection)) {
        return collection.some((value) => Object.is(value, expected));
    }
    if (typeof collection === 'string' && typeof expected === 'string') {
        return collection.includes(expected);
    }
    return rejectSafeOutputTransform(
        'Includes transform requires an array, or a string with a string value.',
        { ...details, input: values }
    );
}

function evaluateIfTransform(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput,
    details: SafeOutputTransformDetails
): any {
    const branches = isSafeOutputTransformRecord(spec.if) ? spec.if : spec;
    if (branches.condition === undefined) {
        return rejectSafeOutputTransform('If transform requires a condition.', details);
    }
    if (!Object.hasOwn(branches, 'then') || !Object.hasOwn(branches, 'else')) {
        return rejectSafeOutputTransform('If transform requires both then and else branches.', details);
    }
    const condition = toTransformBoolean(evaluateTransformValue(branches.condition, input), details);
    return evaluateTransformValue(condition ? branches.then : branches.else, input);
}

function evaluateJsonTransform(evaluation: TransformOperatorEvaluation): any {
    const { spec, input, details } = evaluation;
    const operator = details.operator as 'jsonStringify' | 'jsonParse';
    const value = evaluateTransformValue(spec[operator] ?? transformOperand(spec, input), input);
    if (operator === 'jsonStringify') {
        return JSON.stringify(value);
    }
    if (typeof value !== 'string') {
        return rejectSafeOutputTransform('jsonParse transform requires a string input.', {
            ...details,
            input: value
        });
    }
    try {
        return JSON.parse(value);
    }
    catch (error) {
        return rejectSafeOutputTransform('jsonParse transform received invalid JSON.', {
            ...details,
            input: value,
            error: error instanceof Error ? error.message : String(error)
        });
    }
}

function evaluateScalarTransform(evaluation: TransformOperatorEvaluation): any {
    const { spec, input, details } = evaluation;
    const operator = details.operator as 'urlEncode' | 'number' | 'string' | 'boolean';
    const value = evaluateTransformValue(spec[operator] ?? transformOperand(spec, input), input);
    if (operator === 'urlEncode') {
        return encodeURIComponent(stringifySafeOutputTransformValue(value));
    }
    if (operator === 'number') {
        return toTransformNumber(value, details);
    }
    if (operator === 'boolean') {
        return toTransformBoolean(value, details);
    }
    return stringifySafeOutputTransformValue(value);
}

function evaluateValueOrReject(evaluation: TransformOperatorEvaluation): any {
    const { spec, input, details } = evaluation;
    if (spec.value !== undefined || spec.input !== undefined) {
        return transformOperand(spec, input);
    }
    return rejectSafeOutputTransform(`Unsupported transform operator ${details.operator}.`, details);
}

function evaluateTransformValue(value: any, input: SafeOutputTransformEvaluationInput): any {
    if (isSafeOutputTransformRecord(value) && directSafeOutputTransformSpec(value) !== undefined) {
        return evaluateSafeOutputTransform(value, input);
    }
    if (typeof value === 'string') {
        return resolveSafeOutputTransformTemplate(value, input);
    }
    if (Array.isArray(value)) {
        return value.map((item) => evaluateTransformValue(item, input));
    }
    if (isSafeOutputTransformRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, nested]) => [key, evaluateTransformValue(nested, input)])
        );
    }
    return value;
}

function transformOperand(
    spec: Record<string, any>,
    input: SafeOutputTransformEvaluationInput
): any {
    if (spec.value !== undefined) {
        return evaluateTransformValue(spec.value, input);
    }
    if (spec.input !== undefined) {
        return evaluateTransformValue(spec.input, input);
    }
    if (spec.from !== undefined) {
        return resolveSafeOutputTransformPath(spec.from, input);
    }
    if (spec.path !== undefined) {
        return resolveSafeOutputTransformPath(spec.path, input);
    }
    return undefined;
}

function transformValues(spec: Record<string, any>, operator: string): any[] {
    return Array.isArray(spec[operator])
        ? spec[operator]
        : Array.isArray(spec.values)
        ? spec.values
        : [];
}

function toTransformNumber(value: any, details: SafeOutputTransformDetails): number {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) {
        return rejectSafeOutputTransform('Transform value cannot be converted to number.', {
            ...details,
            input: value
        });
    }
    return numberValue;
}

function toTransformBoolean(value: any, details: SafeOutputTransformDetails): boolean {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value !== 0;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
            return true;
        }
        if (['false', '0', 'no', 'n', 'off', ''].includes(normalized)) {
            return false;
        }
    }
    return rejectSafeOutputTransform('Transform value cannot be converted to boolean.', {
        ...details,
        input: value
    });
}

function isNonEmptyTransformValue(value: any): boolean {
    if (value === undefined || value === null) {
        return false;
    }
    if (typeof value === 'string' || Array.isArray(value)) {
        return value.length > 0;
    }
    return isSafeOutputTransformRecord(value) ? Object.keys(value).length > 0 : true;
}

function asTransformSpec(spec: Record<string, any>): Record<string, any> {
    return isSafeOutputTransformRecord(spec.transform) ? spec.transform : spec;
}

function firstTransformOperator(spec: Record<string, any>): string | undefined {
    return IMPLICIT_TRANSFORM_OPERATORS.find((key) => spec[key] !== undefined);
}
