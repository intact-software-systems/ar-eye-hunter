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
    const observedSet = new Set(observed);

    if (expectation.sessionIds) {
        const expectedSessionIds = expectation.sessionIds;
        const expectedSet = new Set(expectedSessionIds);
        const missingSessionIds = expectedSessionIds
            .filter((sessionId) => !observedSet.has(sessionId));
        const extraSessionIds = observed
            .filter((sessionId) => !expectedSet.has(sessionId));
        if (missingSessionIds.length > 0) {
            return toEvaluation({
                status: observed.length === 0 ? 'empty' : 'partial',
                observedSessionIds: observed,
                missingSessionIds: missingSessionIds,
                extraSessionIds: extraSessionIds,
                expectedCount: expectedSessionIds.length
            });
        }
        if (!expectation.allowExtras && extraSessionIds.length > 0) {
            return toEvaluation({
                status: 'over-capacity',
                observedSessionIds: observed,
                missingSessionIds: missingSessionIds,
                extraSessionIds: extraSessionIds,
                expectedCount: expectedSessionIds.length
            });
        }
        return toEvaluation({
            status: expectedSessionIds.length === 0 && observed.length === 0
                ? 'empty'
                : 'ready',
            observedSessionIds: observed,
            missingSessionIds: missingSessionIds,
            extraSessionIds: extraSessionIds,
            expectedCount: expectedSessionIds.length
        });
    }

    if (expectation.exact !== undefined) {
        if (observed.length === expectation.exact) {
            return toEvaluation({
                status: expectation.exact === 0 ? 'empty' : 'ready',
                observedSessionIds: observed,
                missingSessionIds: [],
                extraSessionIds: [],
                expectedCount: expectation.exact
            });
        }
        if (observed.length > expectation.exact) {
            return toEvaluation({
                status: 'over-capacity',
                observedSessionIds: observed,
                missingSessionIds: [],
                extraSessionIds: observed.slice(expectation.exact),
                expectedCount: expectation.exact
            });
        }
        return toEvaluation({
            status: observed.length === 0 ? 'empty' : 'partial',
            observedSessionIds: observed,
            missingSessionIds: [],
            extraSessionIds: [],
            expectedCount: expectation.exact
        });
    }

    const min = expectation.min ?? 1;
    if (expectation.max !== undefined && observed.length > expectation.max) {
        return toEvaluation({
            status: 'over-capacity',
            observedSessionIds: observed,
            missingSessionIds: [],
            extraSessionIds: observed.slice(expectation.max),
            expectedCount: min
        });
    }
    if (observed.length >= min) {
        return toEvaluation({
            status: min === 0 && observed.length === 0 ? 'empty' : 'ready',
            observedSessionIds: observed,
            missingSessionIds: [],
            extraSessionIds: [],
            expectedCount: min
        });
    }
    return toEvaluation({
        status: observed.length === 0 ? 'empty' : 'partial',
        observedSessionIds: observed,
        missingSessionIds: [],
        extraSessionIds: [],
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
