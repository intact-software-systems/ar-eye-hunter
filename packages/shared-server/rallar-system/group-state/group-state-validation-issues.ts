export interface GroupStateValidationIssue {
    readonly path: string;
    readonly cause: Error;
}

export function toGroupStateValidationIssue(path: string, message: string): GroupStateValidationIssue {
    return { path, cause: new TypeError(message) };
}

export function validateExactKeys(
    value: object,
    allowed: readonly string[],
    label: string
): readonly GroupStateValidationIssue[] {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).filter((key) => !allowedKeys.has(key))
        .map((key) => toGroupStateValidationIssue(`${label}.${key}`, `${label} has unexpected key: ${key}`));
}

export function validateRequiredKeys(
    value: object,
    required: readonly string[],
    label: string
): readonly GroupStateValidationIssue[] {
    return required.filter((key) => !Object.hasOwn(value, key))
        .map((key) => toGroupStateValidationIssue(`${label}.${key}`, `${label} is missing mandatory key: ${key}`));
}

export function isGroupStateRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateRecord(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return isGroupStateRecord(value) ? [] : [toGroupStateValidationIssue(label, `${label} must be an object`)];
}

export function validateGroupRef(value: unknown): readonly GroupStateValidationIssue[] {
    if (!isGroupStateRecord(value)) {
        return validateRecord(value, 'Group mutation aggregateRef');
    }
    return [
        ...validateExactKeys(value, ['applicationId', 'workspaceId', 'groupId'], 'Group mutation aggregateRef'),
        ...validateNonEmptyString(value.applicationId, 'Group applicationId'),
        ...validateNonEmptyString(value.workspaceId, 'Group workspaceId'),
        ...validateNonEmptyString(value.groupId, 'Group groupId')
    ];
}

export function validateNonEmptyString(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return typeof value === 'string' && value.length > 0
        ? []
        : [toGroupStateValidationIssue(label, `${label} must be a non-empty string`)];
}

export function validateNullableNonEmptyString(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return value === null ? [] : validateNonEmptyString(value, label);
}

export function validateNullablePositiveSafeInteger(
    value: unknown,
    label: string
): readonly GroupStateValidationIssue[] {
    return value === null ? [] : validatePositiveSafeInteger(value, label);
}

export function validateNullablePersistenceExpiry(
    value: unknown,
    label: string
): readonly GroupStateValidationIssue[] {
    const issues = validateNullablePositiveSafeInteger(value, label);
    if (issues.length > 0 || value === null) {
        return issues;
    }
    return typeof value === 'number' && Number.isFinite(new Date(value).getTime())
        ? []
        : [toGroupStateValidationIssue(label, `${label} must be representable as a database timestamp`)];
}

export function validateOneOf(
    value: unknown,
    allowed: readonly string[],
    label: string
): readonly GroupStateValidationIssue[] {
    return typeof value === 'string' && allowed.includes(value)
        ? []
        : [toGroupStateValidationIssue(label, `${label} is invalid`)];
}

export function validatePositiveSafeInteger(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? []
        : [toGroupStateValidationIssue(label, `${label} must be a positive safe integer`)];
}

export function validateNonNegativeSafeInteger(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? []
        : [toGroupStateValidationIssue(label, `${label} must be a non-negative safe integer`)];
}

export function validateJsonSafe(value: unknown, label: string): readonly GroupStateValidationIssue[] {
    return validateJsonValue({ value, path: label, label, ancestors: new Set() });
}

interface GroupStateJsonValidationInput {
    readonly value: unknown;
    readonly path: string;
    readonly label: string;
    readonly ancestors: ReadonlySet<object>;
}

function validateJsonValue(input: GroupStateJsonValidationInput): readonly GroupStateValidationIssue[] {
    const { value, path, label, ancestors } = input;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return [];
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) && !Object.is(value, -0)
            ? []
            : [toGroupStateValidationIssue(path, `${label} must contain only JSON-safe numbers`)];
    }
    if (typeof value !== 'object') {
        return [toGroupStateValidationIssue(path, `${label} must be JSON-safe`)];
    }
    if (ancestors.has(value)) {
        return [toGroupStateValidationIssue(path, `${label} must not be cyclic`)];
    }
    if (
        !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
    ) {
        return [toGroupStateValidationIssue(path, `${label} must use plain objects`)];
    }
    const nestedAncestors = new Set([...ancestors, value]);
    const entries = Array.isArray(value) ? Array.from(value.entries()) : Object.entries(value);
    return entries.flatMap(([key, entry]) => {
        if (!Array.isArray(value) && entry === undefined) {
            return [toGroupStateValidationIssue(`${path}.${key}`, `${label}.${key} must be present`)];
        }
        return validateJsonValue({ value: entry, path: `${path}.${key}`, label, ancestors: nestedAncestors });
    });
}

