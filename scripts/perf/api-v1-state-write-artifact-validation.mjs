/**
 * @typedef {{ actual: unknown, expected: number, path: string, errors: string[], source: string }} CompareNumberInput
 * @param {CompareNumberInput} input
 */
export function compareNumber({ actual, expected, path, errors, source }) {
    if (!numbersEqual(actual, expected)) {
        errors.push(
            `${path} does not match ${source}: expected=${expected}, actual=${actual}`
        );
    }
}

/**
 * @typedef {{ container: unknown, metric: string, path: string, errors: string[] }} RequireMetricInput
 * @param {RequireMetricInput} input
 */
export function requireMetric({ container, metric, path, errors }) {
    if (!isObject(container) || !isNonNegativeNumber(container[metric])) {
        errors.push(`${path}.${metric} must be a non-negative finite number`);
    }
}

export function numbersEqual(left, right) {
    return isNonNegativeNumber(left) && isNonNegativeNumber(right) &&
        Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}

export function sameStringArray(left, right) {
    if (
        !isDenseArray(left) || !isDenseArray(right) || left.length !== right.length
    ) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (typeof left[index] !== 'string' || left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

export function sameNumericArray(left, right) {
    if (
        !isDenseArray(left) || !isDenseArray(right) || left.length !== right.length
    ) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (
            typeof left[index] !== 'number' || !Number.isFinite(left[index]) ||
            typeof right[index] !== 'number' || !Number.isFinite(right[index]) ||
            left[index] !== right[index]
        ) {
            return false;
        }
    }
    return true;
}

export function isDenseArray(value, expectedLength) {
    if (
        !Array.isArray(value) ||
        (expectedLength !== undefined && value.length !== expectedLength)
    ) {
        return false;
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
            return false;
        }
    }
    return true;
}

export function isDenseStringArray(value) {
    return isDenseArray(value) &&
        value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

export function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonNegativeNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
