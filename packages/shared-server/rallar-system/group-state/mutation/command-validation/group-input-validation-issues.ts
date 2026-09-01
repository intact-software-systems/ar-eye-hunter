export interface GroupInputFieldRule {
    readonly key: string;
    readonly kind: 'string' | 'positive-integer' | 'nonnegative-integer' | 'object' | 'enum';
    readonly required?: boolean;
    readonly nullable?: boolean;
    readonly allowed?: readonly string[];
    readonly label?: string;
}

export function isGroupInputRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateGroupInputFields(
    input: Readonly<Record<string, unknown>>,
    rules: readonly GroupInputFieldRule[],
    prefix: string
): readonly TypeError[] {
    const issues: TypeError[] = [];
    for (const rule of rules) {
        const value = input[rule.key];
        if ((value === undefined && !rule.required) || (value === null && rule.nullable)) {
            continue;
        }
        const label = rule.label ?? `${prefix} ${rule.key}`;
        const message = resolveGroupInputFieldIssue(value, rule, label);
        if (message) {
            issues.push(new TypeError(message));
        }
    }
    return issues;
}

export function validateGroupInputKeys(value: object, allowed: readonly string[], label: string): readonly TypeError[] {
    return Object.keys(value).filter((key) => !allowed.includes(key))
        .map((key) => new TypeError(`${label} has unexpected key: ${key}`));
}

function resolveGroupInputFieldIssue(value: unknown, rule: GroupInputFieldRule, label: string): string | undefined {
    switch (rule.kind) {
        case 'string':
            return typeof value === 'string' && value.length > 0 ? undefined : `${label} must be a non-empty string`;
        case 'positive-integer':
            return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
                ? undefined
                : `${label} must be a positive safe integer`;
        case 'nonnegative-integer':
            return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
                ? undefined
                : `${label} must be a non-negative safe integer`;
        case 'object':
            return isGroupInputRecord(value) ? undefined : `${label} must be an object`;
        case 'enum':
            return typeof value === 'string' && rule.allowed?.includes(value) ? undefined : `${label} is invalid`;
    }
}

export function validateGroupInputJson(value: unknown, label: string): readonly TypeError[] {
    try {
        return validateJsonValue({ value, label, ancestors: new Set<object>() });
    }
    catch {
        return [new TypeError(`${label} must be JSON-safe`)];
    }
}

interface JsonValueValidationInput {
    readonly value: unknown;
    readonly label: string;
    readonly ancestors: ReadonlySet<object>;
}

function validateJsonValue({ value, label, ancestors }: JsonValueValidationInput): readonly TypeError[] {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return [];
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) && !Object.is(value, -0)
            ? []
            : [new TypeError(`${label} must contain only JSON-safe numbers`)];
    }
    if (typeof value !== 'object') {
        return [new TypeError(`${label} must be JSON-safe`)];
    }
    if (ancestors.has(value)) {
        return [new TypeError(`${label} must not be cyclic`)];
    }
    const nextAncestors = new Set([...ancestors, value]);
    if (Array.isArray(value)) {
        return Array.from(value).flatMap((entry) =>
            validateJsonValue({ value: entry, label, ancestors: nextAncestors })
        );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        return [new TypeError(`${label} must use plain objects`)];
    }
    return Object.entries(value).flatMap(([key, entry]) =>
        entry === undefined
            ? [new TypeError(`${label}.${key} must be present`)]
            : validateJsonValue({ value: entry, label, ancestors: nextAncestors })
    );
}
