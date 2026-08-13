// deno-lint-ignore-file no-explicit-any
import { assertValueMatches } from '../assert/assert-value-operators.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import type { RallarBlackBoxTestRedactionOptions } from '../types.ts';
import type {
    RallarBlackBoxDistributedRecipeResult,
    RallarBlackBoxDistributedRunItemState,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution,
} from '../distributed-run.ts';
import {
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING,
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED,
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS,
    type RallarBlackBoxDistributedGroupAssertion,
    type RallarBlackBoxDistributedGroupAssertionResult,
    type RallarBlackBoxGroupAssertionAgentRow,
} from './group-assertions.ts';
import {
    collectGroupAssertionEvidence,
    type DistributedGroupAssertionParticipant,
    type DistributedGroupAssertionRecipeEvidence,
    type GroupAssertionEvidenceRow,
} from './group-assertions-evidence.ts';

const COMPLETED_RECIPE_STATES: readonly RallarBlackBoxDistributedRunItemState[] = [
    'passed',
    'failed',
    'cancelled',
    'timed-out',
    'disconnected',
    'skipped',
];

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
        leftKeys.every(key =>
            Object.prototype.hasOwnProperty.call(right, key) &&
            deepEqualJson(left[key], right[key])
        );
}

export interface EvaluateDistributedGroupAssertionsInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly participants: readonly DistributedGroupAssertionParticipant[];
    readonly recipeResults: readonly RallarBlackBoxDistributedRecipeResult[];
    readonly recipeEvidence: readonly DistributedGroupAssertionRecipeEvidence[];
    readonly redaction?: RallarBlackBoxTestRedactionOptions;
}

// Coordinator-side evaluation over the frozen participant set. Returns
// undefined while required recipes are still executing; the control-server
// rollup calls this on every refresh, so the first fully completed pass is
// the one that decides.
export function evaluateDistributedGroupAssertions(
    input: EvaluateDistributedGroupAssertionsInput,
): readonly RallarBlackBoxDistributedGroupAssertionResult[] | undefined {
    const groupAssertions = input.manifest.groupAssertions ?? [];
    if (groupAssertions.length === 0) {
        return undefined;
    }
    const dispatched = input.recipeResults;
    const complete = dispatched.length > 0 &&
        dispatched.every(recipe => COMPLETED_RECIPE_STATES.includes(recipe.state));
    if (!complete) {
        return undefined;
    }
    return groupAssertions.map(assertion => evaluateGroupAssertion(assertion, input));
}

function evaluateGroupAssertion(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    input: EvaluateDistributedGroupAssertionsInput,
): RallarBlackBoxDistributedGroupAssertionResult {
    const scopedParticipants = assertion.scope?.role === undefined
        ? input.participants
        : input.participants.filter(participant =>
            participant.roles.includes(assertion.scope!.role)
        );
    if (scopedParticipants.length === 0) {
        return toNoParticipantsResult(assertion);
    }

    const rows = collectGroupAssertionEvidence({
        source: assertion.source,
        participants: scopedParticipants,
        recipeEvidence: input.recipeEvidence,
    });
    const resolved = rows.filter(row => row.status === 'resolved');
    const requiredParticipants = assertion.minParticipants ?? scopedParticipants.length;
    const brokenEvidence = rows.filter(row =>
        row.status === 'duplicate' || row.status === 'unresolved'
    );
    const missingAgentIds = rows
        .filter(row => row.status === 'missing')
        .map(row => row.agentId);
    const evidenceOk = brokenEvidence.length === 0 && resolved.length >= requiredParticipants;
    const verdict = evaluateGroupAssertionAggregate(assertion, resolved);

    return {
        groupAssertionId: assertion.groupAssertionId,
        aggregate: assertion.aggregate,
        ok: evidenceOk && verdict.ok,
        participants: {
            expected: scopedParticipants.length,
            required: requiredParticipants,
            withEvidence: resolved.length,
            matching: verdict.matchingCount,
        },
        missingAgentIds,
        violatingAgentIds: verdict.violatingAgentIds,
        perAgent: toRedactedAgentRows(rows, verdict, input.redaction),
        error: evidenceOk && verdict.ok
            ? undefined
            : toGroupAssertionError({
                assertion,
                rows,
                verdict,
                evidenceOk,
                missingAgentIds,
                brokenEvidence,
                redaction: input.redaction,
            }),
    };
}

interface GroupAssertionVerdict {
    readonly ok: boolean;
    readonly violatingAgentIds: readonly string[];
    readonly matchingCount?: number;
    readonly reason: string;
    readonly detail?: any;
    readonly verdictByAgentId: ReadonlyMap<string, RallarBlackBoxGroupAssertionAgentRow['verdict']>;
}

function evaluateGroupAssertionAggregate(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    resolved: readonly GroupAssertionEvidenceRow[],
): GroupAssertionVerdict {
    switch (assertion.aggregate) {
        case 'allMatch':
        case 'noneMatch':
        case 'countMatching':
            return evaluatePredicateAggregate(assertion, resolved);
        case 'allEqual':
            return evaluateAllEqual(resolved);
        case 'allEqualWithin':
            return evaluateAllEqualWithin(resolved, assertion.tolerance);
    }
}

function evaluatePredicateAggregate(
    assertion: RallarBlackBoxDistributedGroupAssertion & Readonly<{
        aggregate: 'allMatch' | 'noneMatch' | 'countMatching';
    }>,
    resolved: readonly GroupAssertionEvidenceRow[],
): GroupAssertionVerdict {
    const verdictByAgentId = new Map<string, RallarBlackBoxGroupAssertionAgentRow['verdict']>();
    const matchingAgentIds: string[] = [];
    for (const row of resolved) {
        const matches = assertValueMatches(
            { exists: true, value: row.value },
            assertion.predicate.operator,
            assertion.predicate.expected,
        );
        verdictByAgentId.set(row.agentId, matches ? 'matching' : 'not-matching');
        if (matches) {
            matchingAgentIds.push(row.agentId);
        }
    }
    const matchingCount = matchingAgentIds.length;

    if (assertion.aggregate === 'allMatch') {
        const violating = resolved
            .map(row => row.agentId)
            .filter(agentId => !matchingAgentIds.includes(agentId));
        return {
            ok: violating.length === 0,
            violatingAgentIds: violating,
            matchingCount,
            reason: `${matchingCount} of ${resolved.length} participants matched the predicate`,
            verdictByAgentId,
        };
    }
    if (assertion.aggregate === 'noneMatch') {
        return {
            ok: matchingCount === 0,
            violatingAgentIds: matchingAgentIds,
            matchingCount,
            reason: `${matchingCount} participants matched a predicate none may match`,
            verdictByAgentId,
        };
    }
    const bounds = assertion.count;
    const ok = (bounds.equals === undefined || matchingCount === bounds.equals) &&
        (bounds.gte === undefined || matchingCount >= bounds.gte) &&
        (bounds.lte === undefined || matchingCount <= bounds.lte);
    return {
        ok,
        violatingAgentIds: [],
        matchingCount,
        reason: `matching count ${matchingCount} violates ${JSON.stringify(bounds)}`,
        detail: { count: bounds },
        verdictByAgentId,
    };
}

function evaluateAllEqual(resolved: readonly GroupAssertionEvidenceRow[]): GroupAssertionVerdict {
    const classes: { value: any; agentIds: string[] }[] = [];
    for (const row of resolved) {
        const existing = classes.find(candidate => deepEqualJson(candidate.value, row.value));
        if (existing) {
            existing.agentIds.push(row.agentId);
        } else {
            classes.push({ value: row.value, agentIds: [row.agentId] });
        }
    }
    const reference = [...classes].sort((left, right) =>
        right.agentIds.length - left.agentIds.length ||
        smallestAgentId(left).localeCompare(smallestAgentId(right))
    )[0];
    const violating = classes
        .filter(candidate => candidate !== reference)
        .flatMap(candidate => candidate.agentIds);
    const verdictByAgentId = new Map<string, RallarBlackBoxGroupAssertionAgentRow['verdict']>();
    for (const row of resolved) {
        verdictByAgentId.set(row.agentId, violating.includes(row.agentId) ? 'violating' : 'agreeing');
    }
    return {
        ok: classes.length <= 1,
        violatingAgentIds: violating,
        reason: `${classes.length} distinct values across ${resolved.length} participants`,
        detail: reference === undefined ? undefined : { referenceValue: reference.value },
        verdictByAgentId,
    };
}

function evaluateAllEqualWithin(
    resolved: readonly GroupAssertionEvidenceRow[],
    tolerance: number,
): GroupAssertionVerdict {
    const nonNumeric = resolved.filter(row => typeof row.value !== 'number');
    const numericRows = resolved.filter(row => typeof row.value === 'number');
    const values = numericRows.map(row => row.value as number);
    const minValue = values.length === 0 ? undefined : Math.min(...values);
    const maxValue = values.length === 0 ? undefined : Math.max(...values);
    const spread = minValue === undefined || maxValue === undefined
        ? 0
        : maxValue - minValue;
    const withinTolerance = spread <= tolerance;
    const extremeAgentIds = withinTolerance ? [] : numericRows
        .filter(row => row.value === minValue || row.value === maxValue)
        .map(row => row.agentId);
    const violating = [...nonNumeric.map(row => row.agentId), ...extremeAgentIds];
    const verdictByAgentId = new Map<string, RallarBlackBoxGroupAssertionAgentRow['verdict']>();
    for (const row of resolved) {
        verdictByAgentId.set(row.agentId, violating.includes(row.agentId) ? 'violating' : 'agreeing');
    }
    return {
        ok: nonNumeric.length === 0 && withinTolerance,
        violatingAgentIds: violating,
        reason: nonNumeric.length > 0
            ? `${nonNumeric.length} participants reported non-numeric values`
            : `numeric spread ${spread} exceeds tolerance ${tolerance}`,
        detail: { minValue, maxValue, spread, tolerance },
        verdictByAgentId,
    };
}

function toRedactedAgentRows(
    rows: readonly GroupAssertionEvidenceRow[],
    verdict: GroupAssertionVerdict,
    redaction: RallarBlackBoxTestRedactionOptions | undefined,
): readonly RallarBlackBoxGroupAssertionAgentRow[] {
    return rows.map(row => ({
        agentId: row.agentId,
        role: row.role,
        evidence: row.status,
        verdict: verdictByAgent(verdict, row),
        value: row.status === 'resolved'
            ? redactRallarBlackBoxValue(row.value, redaction)
            : undefined,
    }));
}

function verdictByAgent(
    verdict: GroupAssertionVerdict,
    row: GroupAssertionEvidenceRow,
): RallarBlackBoxGroupAssertionAgentRow['verdict'] {
    return row.status === 'resolved' ? verdict.verdictByAgentId.get(row.agentId) : undefined;
}

interface ToGroupAssertionErrorInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly rows: readonly GroupAssertionEvidenceRow[];
    readonly verdict: GroupAssertionVerdict;
    readonly evidenceOk: boolean;
    readonly missingAgentIds: readonly string[];
    readonly brokenEvidence: readonly GroupAssertionEvidenceRow[];
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
}

function toGroupAssertionError(
    input: ToGroupAssertionErrorInput,
): RallarBlackBoxDistributedGroupAssertionResult['error'] {
    const assertion = input.assertion;
    const details = redactRallarBlackBoxValue({
        aggregate: assertion.aggregate,
        source: assertion.source,
        scopeRole: assertion.scope?.role,
        minParticipants: assertion.minParticipants,
        missingAgentIds: input.missingAgentIds,
        brokenEvidenceAgentIds: input.brokenEvidence.map(row => row.agentId),
        violatingAgentIds: input.verdict.violatingAgentIds,
        aggregateDetail: input.verdict.detail,
        perAgent: toRedactedAgentRows(input.rows, input.verdict, input.redaction),
    }, input.redaction);

    if (!input.evidenceOk) {
        const broken = input.brokenEvidence.map(row => `${row.agentId} (${row.status})`);
        const missing = [...input.missingAgentIds, ...broken].join(', ');
        return {
            code: RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING,
            message: `Group assertion ${assertion.groupAssertionId} lacks usable evidence at ` +
                `${assertion.source.recipeId}/${assertion.source.commandId}/` +
                `${assertion.source.path} from: ${missing}.`,
            details,
        };
    }
    return {
        code: RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED,
        message: `Group assertion ${assertion.groupAssertionId} failed: ${input.verdict.reason}.`,
        details,
    };
}

function toNoParticipantsResult(
    assertion: RallarBlackBoxDistributedGroupAssertion,
): RallarBlackBoxDistributedGroupAssertionResult {
    const scopeText = assertion.scope?.role === undefined
        ? 'the frozen participant set is empty'
        : `no frozen participant holds role ${assertion.scope.role}`;
    return {
        groupAssertionId: assertion.groupAssertionId,
        aggregate: assertion.aggregate,
        ok: false,
        participants: { expected: 0, required: assertion.minParticipants ?? 0, withEvidence: 0 },
        missingAgentIds: [],
        violatingAgentIds: [],
        perAgent: [],
        error: {
            code: RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS,
            message: `Group assertion ${assertion.groupAssertionId} cannot evaluate: ${scopeText}.`,
        },
    };
}

function smallestAgentId(candidate: Readonly<{ agentIds: readonly string[] }>): string {
    return [...candidate.agentIds].sort((left, right) => left.localeCompare(right))[0] ?? '';
}
