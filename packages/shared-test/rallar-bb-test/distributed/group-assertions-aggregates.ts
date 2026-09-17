// deno-lint-ignore-file no-explicit-any
import { assertValueMatches } from '../assert/assert-value-operators.ts';
import type { ResolvedGroupAssertionEvidenceRow } from './group-assertions-evidence.ts';
import type {
    RallarBlackBoxCountMatchingGroupAssertion,
    RallarBlackBoxDistributedGroupAssertion,
    RallarBlackBoxPredicateGroupAssertion
} from './group-assertions.ts';

export type GroupAssertionVerdict = PredicateGroupAssertionVerdict | EqualityGroupAssertionVerdict;

interface GroupAssertionVerdictFields {
    readonly ok: boolean;
    readonly violatingAgentIds: readonly string[];
    readonly reason: string;
    readonly detail?: any;
}

export interface PredicateGroupAssertionVerdict extends GroupAssertionVerdictFields {
    readonly kind: 'predicate';
    readonly matchingAgentIds: readonly string[];
}

export interface EqualityGroupAssertionVerdict extends GroupAssertionVerdictFields {
    readonly kind: 'equality';
}

// Group agreement equality: object key order is irrelevant, array order is
// significant. Deliberately distinct from sameJsonValue (stringify equality)
// and from json-compare's order-insensitive exact mode.
export function deepEqualJson(left: any, right: any): boolean {
    if (left === right) {
        return true;
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((entry, index) => deepEqualJson(entry, right[index]));
    }
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length &&
        leftKeys.every((key) =>
            Object.prototype.hasOwnProperty.call(right, key) &&
            deepEqualJson(left[key], right[key])
        );
}

export function computeGroupAssertionVerdict(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    resolved: readonly ResolvedGroupAssertionEvidenceRow[]
): GroupAssertionVerdict {
    switch (assertion.aggregate) {
        case 'allMatch':
        case 'noneMatch':
        case 'countMatching':
            return computePredicateVerdict(assertion, resolved);
        case 'allEqual':
            return computeAllEqualVerdict(resolved);
        case 'allEqualWithin':
            return computeAllEqualWithinVerdict(resolved, assertion.tolerance);
    }
}

function computePredicateVerdict(
    assertion: RallarBlackBoxPredicateGroupAssertion | RallarBlackBoxCountMatchingGroupAssertion,
    resolved: readonly ResolvedGroupAssertionEvidenceRow[]
): PredicateGroupAssertionVerdict {
    const matchingAgentIds = resolved
        .filter((row) =>
            assertValueMatches(
                { exists: true, value: row.value },
                assertion.predicate.operator,
                assertion.predicate.expected
            )
        )
        .map((row) => row.agentId);
    const matchingCount = matchingAgentIds.length;

    if (assertion.aggregate === 'countMatching') {
        const bounds = assertion.count;
        const ok = (bounds.equals === undefined || matchingCount === bounds.equals) &&
            (bounds.gte === undefined || matchingCount >= bounds.gte) &&
            (bounds.lte === undefined || matchingCount <= bounds.lte);
        return {
            kind: 'predicate',
            ok,
            violatingAgentIds: [],
            matchingAgentIds,
            reason: `matching count ${matchingCount} violates ${JSON.stringify(bounds)}`,
            detail: { count: bounds }
        };
    }
    if (assertion.aggregate === 'allMatch') {
        const violating = resolved
            .map((row) => row.agentId)
            .filter((agentId) => !matchingAgentIds.includes(agentId));
        return {
            kind: 'predicate',
            ok: violating.length === 0,
            violatingAgentIds: violating,
            matchingAgentIds,
            reason: `${matchingCount} of ${resolved.length} participants matched the predicate`
        };
    }
    return {
        kind: 'predicate',
        ok: matchingCount === 0,
        violatingAgentIds: matchingAgentIds,
        matchingAgentIds,
        reason: `${matchingCount} participants matched a predicate none may match`
    };
}

function computeAllEqualVerdict(resolved: readonly ResolvedGroupAssertionEvidenceRow[]): EqualityGroupAssertionVerdict {
    const classes: { value: any; agentIds: string[]; }[] = [];
    for (const row of resolved) {
        const existing = classes.find((candidate) => deepEqualJson(candidate.value, row.value));
        if (existing) {
            existing.agentIds.push(row.agentId);
        }
        else {
            classes.push({ value: row.value, agentIds: [row.agentId] });
        }
    }
    const reference = [...classes].sort((left, right) =>
        right.agentIds.length - left.agentIds.length ||
        smallestAgentId(left).localeCompare(smallestAgentId(right))
    )[0];
    const violating = classes
        .filter((candidate) => candidate !== reference)
        .flatMap((candidate) => candidate.agentIds);
    return {
        kind: 'equality',
        ok: classes.length <= 1,
        violatingAgentIds: violating,
        reason: `${classes.length} distinct values across ${resolved.length} participants`,
        detail: reference === undefined ? undefined : { referenceValue: reference.value }
    };
}

function computeAllEqualWithinVerdict(
    resolved: readonly ResolvedGroupAssertionEvidenceRow[],
    tolerance: number
): EqualityGroupAssertionVerdict {
    const nonNumeric = resolved.filter((row) => typeof row.value !== 'number');
    const numericRows = resolved.filter((row) => typeof row.value === 'number');
    const values = numericRows.map((row) => row.value as number);
    const minValue = values.length === 0 ? undefined : Math.min(...values);
    const maxValue = values.length === 0 ? undefined : Math.max(...values);
    const spread = minValue === undefined || maxValue === undefined
        ? 0
        : maxValue - minValue;
    const withinTolerance = spread <= tolerance;
    const extremeAgentIds = withinTolerance ? [] : numericRows
        .filter((row) => row.value === minValue || row.value === maxValue)
        .map((row) => row.agentId);
    const violating = [...nonNumeric.map((row) => row.agentId), ...extremeAgentIds];
    return {
        kind: 'equality',
        ok: nonNumeric.length === 0 && withinTolerance,
        violatingAgentIds: violating,
        reason: nonNumeric.length > 0
            ? `${nonNumeric.length} participants reported non-numeric values`
            : `numeric spread ${spread} exceeds tolerance ${tolerance}`,
        detail: { minValue, maxValue, spread, tolerance }
    };
}

function smallestAgentId(candidate: Readonly<{ agentIds: readonly string[]; }>): string {
    return [...candidate.agentIds].sort((left, right) => left.localeCompare(right))[0] ?? '';
}
