export type RallarReadinessExpectation =
    | Readonly<{ min: number; max?: number; }>
    | Readonly<{ exact: number; }>
    | Readonly<{ sessionIds: readonly string[]; allowExtras?: boolean; }>;

export type RallarNormalizedReadinessExpectation = Readonly<{
    min?: number;
    max?: number;
    exact?: number;
    sessionIds?: readonly string[];
    allowExtras: boolean;
}>;

export type RallarReadinessStatus =
    | 'ready'
    | 'partial'
    | 'empty'
    | 'timeout'
    | 'over-capacity'
    | 'aborted'
    | 'not-found'
    | 'not-connected';

export type RallarReadinessEvaluation = Readonly<{
    status: RallarReadinessStatus;
    observedSessionIds: readonly string[];
    missingSessionIds: readonly string[];
    extraSessionIds: readonly string[];
    observedCount: number;
    expectedCount?: number;
}>;

export function normalizeRallarReadinessExpectation(
    expectation: RallarReadinessExpectation | undefined
): RallarNormalizedReadinessExpectation {
    if (!expectation) {
        return { min: 1, allowExtras: true };
    }

    if ('sessionIds' in expectation) {
        return {
            sessionIds: uniqueSortedSessionIds(expectation.sessionIds),
            allowExtras: expectation.allowExtras ?? true
        };
    }

    if ('exact' in expectation) {
        return {
            exact: normalizeNonNegativeInteger(expectation.exact, 'exact'),
            allowExtras: false
        };
    }

    const min = normalizeNonNegativeInteger(expectation.min, 'min');
    const max = expectation.max === undefined
        ? undefined
        : normalizeNonNegativeInteger(expectation.max, 'max');
    if (max !== undefined && max < min) {
        throw new Error(
            'Rallar readiness expectation max must be greater than or equal to min.'
        );
    }

    return { min, max, allowExtras: true };
}

export function evaluateRallarReadinessExpectation(
    observedSessionIds: readonly string[],
    expectation: RallarNormalizedReadinessExpectation
): RallarReadinessEvaluation {
    const observed = uniqueSortedSessionIds(observedSessionIds);
    if (expectation.sessionIds) {
        return evaluateExpectedSessions(observed, expectation);
    }
    if (expectation.exact !== undefined) {
        return evaluateExactSessionCount(observed, expectation.exact);
    }
    return evaluateSessionCountRange(observed, expectation);
}

function evaluateExpectedSessions(
    observedSessionIds: readonly string[],
    expectation: RallarNormalizedReadinessExpectation
): RallarReadinessEvaluation {
    const expectedSessionIds = expectation.sessionIds ?? [];
    const observedSet = new Set(observedSessionIds);
    const expectedSet = new Set(expectedSessionIds);
    const missingSessionIds = expectedSessionIds
        .filter((sessionId) => !observedSet.has(sessionId));
    const extraSessionIds = observedSessionIds
        .filter((sessionId) => !expectedSet.has(sessionId));
    let status: RallarReadinessStatus = 'ready';
    if (missingSessionIds.length > 0) {
        status = observedSessionIds.length === 0 ? 'empty' : 'partial';
    }
    else if (!expectation.allowExtras && extraSessionIds.length > 0) {
        status = 'over-capacity';
    }
    else if (expectedSessionIds.length === 0 && observedSessionIds.length === 0) {
        status = 'empty';
    }

    return toEvaluation({
        status,
        observedSessionIds,
        missingSessionIds,
        extraSessionIds,
        expectedCount: expectedSessionIds.length
    });
}

function evaluateExactSessionCount(
    observedSessionIds: readonly string[],
    exact: number
): RallarReadinessEvaluation {
    let status: RallarReadinessStatus;
    if (observedSessionIds.length === exact) {
        status = exact === 0 ? 'empty' : 'ready';
    }
    else if (observedSessionIds.length > exact) {
        status = 'over-capacity';
    }
    else {
        status = observedSessionIds.length === 0 ? 'empty' : 'partial';
    }
    return toEvaluation({
        status,
        observedSessionIds,
        missingSessionIds: [],
        extraSessionIds: observedSessionIds.length > exact
            ? observedSessionIds.slice(exact)
            : [],
        expectedCount: exact
    });
}

function evaluateSessionCountRange(
    observedSessionIds: readonly string[],
    expectation: RallarNormalizedReadinessExpectation
): RallarReadinessEvaluation {
    const min = expectation.min ?? 1;
    const max = expectation.max;
    const overCapacity = max !== undefined && observedSessionIds.length > max;
    let status: RallarReadinessStatus;
    if (overCapacity) {
        status = 'over-capacity';
    }
    else if (observedSessionIds.length >= min) {
        status = min === 0 && observedSessionIds.length === 0 ? 'empty' : 'ready';
    }
    else {
        status = observedSessionIds.length === 0 ? 'empty' : 'partial';
    }
    return toEvaluation({
        status,
        observedSessionIds,
        missingSessionIds: [],
        extraSessionIds: overCapacity
            ? observedSessionIds.slice(max)
            : [],
        expectedCount: min
    });
}

interface RallarReadinessEvaluationInput {
    readonly status: RallarReadinessStatus;
    readonly observedSessionIds: readonly string[];
    readonly missingSessionIds: readonly string[];
    readonly extraSessionIds: readonly string[];
    readonly expectedCount?: number;
}

function toEvaluation(
    input: RallarReadinessEvaluationInput
): RallarReadinessEvaluation {
    const {
        status,
        observedSessionIds,
        missingSessionIds,
        extraSessionIds,
        expectedCount
    } = input;
    return {
        status,
        observedSessionIds,
        missingSessionIds,
        extraSessionIds,
        observedCount: observedSessionIds.length,
        expectedCount
    };
}

function uniqueSortedSessionIds(sessionIds: readonly string[]): readonly string[] {
    return [...new Set(sessionIds)].sort((left, right) => left.localeCompare(right));
}

function normalizeNonNegativeInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(
            `Rallar readiness expectation ${name} must be a non-negative integer.`
        );
    }
    return value;
}
