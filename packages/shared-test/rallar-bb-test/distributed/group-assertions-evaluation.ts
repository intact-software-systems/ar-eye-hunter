// deno-lint-ignore-file no-explicit-any
import type {
    RallarBlackBoxDistributedRecipeResult,
    RallarBlackBoxDistributedRunItemState,
    RallarBlackBoxDistributedRunManifest
} from '../distributed-run.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import type { RallarBlackBoxTestRedactionOptions } from '../types.ts';
import { evaluateGroupAssertionAggregate, type GroupAssertionVerdict } from './group-assertions-aggregates.ts';
import {
    collectGroupAssertionEvidence,
    type DistributedGroupAssertionParticipant,
    type DistributedGroupAssertionRecipeEvidence,
    type GroupAssertionEvidenceRow
} from './group-assertions-evidence.ts';
import {
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING,
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED,
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS,
    type RallarBlackBoxDistributedGroupAssertion,
    type RallarBlackBoxDistributedGroupAssertionResult,
    type RallarBlackBoxGroupAssertionAgentRow
} from './group-assertions.ts';

const COMPLETED_RECIPE_STATES: readonly RallarBlackBoxDistributedRunItemState[] = [
    'passed',
    'failed',
    'cancelled',
    'timed-out',
    'disconnected',
    'skipped'
];

export interface EvaluateDistributedGroupAssertionsInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly participants: readonly DistributedGroupAssertionParticipant[];
    readonly recipeResults: readonly RallarBlackBoxDistributedRecipeResult[];
    readonly recipeEvidence: readonly DistributedGroupAssertionRecipeEvidence[];
    readonly redaction?: RallarBlackBoxTestRedactionOptions;
}

// Coordinator-side evaluation over the frozen participant set. Returns
// undefined while dispatched recipes are still executing; the control-server
// rollup calls this on every refresh, so the first fully completed pass is
// the one that decides.
export function evaluateDistributedGroupAssertions(
    input: EvaluateDistributedGroupAssertionsInput
): readonly RallarBlackBoxDistributedGroupAssertionResult[] | undefined {
    const groupAssertions = input.manifest.groupAssertions ?? [];
    if (groupAssertions.length === 0) {
        return undefined;
    }
    const dispatched = input.recipeResults;
    const complete = dispatched.length > 0 &&
        dispatched.every((recipe) => COMPLETED_RECIPE_STATES.includes(recipe.state));
    if (!complete) {
        return undefined;
    }
    return groupAssertions.map((assertion) => evaluateGroupAssertion(assertion, input));
}

function evaluateGroupAssertion(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    input: EvaluateDistributedGroupAssertionsInput
): RallarBlackBoxDistributedGroupAssertionResult {
    const scopeRole = assertion.scope?.role;
    const scopedParticipants = scopeRole === undefined
        ? input.participants
        : input.participants.filter((participant) => participant.roles.includes(scopeRole));
    if (scopedParticipants.length === 0) {
        return toNoParticipantsResult(assertion);
    }

    const rows = collectGroupAssertionEvidence({
        source: assertion.source,
        participants: scopedParticipants,
        recipeEvidence: input.recipeEvidence
    });
    const resolved = rows.filter((row) => row.status === 'resolved');
    const requiredParticipants = assertion.minParticipants ?? scopedParticipants.length;
    const brokenEvidence = rows.filter((row) => row.status === 'duplicate' || row.status === 'unresolved');
    const missingAgentIds = rows
        .filter((row) => row.status === 'missing')
        .map((row) => row.agentId);
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
            matching: verdict.matchingCount
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
                redaction: input.redaction
            })
    };
}

function toRedactedAgentRows(
    rows: readonly GroupAssertionEvidenceRow[],
    verdict: GroupAssertionVerdict,
    redaction: RallarBlackBoxTestRedactionOptions | undefined
): readonly RallarBlackBoxGroupAssertionAgentRow[] {
    return rows.map((row) => ({
        agentId: row.agentId,
        role: row.role,
        evidence: row.status,
        verdict: row.status === 'resolved' ? verdict.verdictByAgentId.get(row.agentId) : undefined,
        value: row.status === 'resolved'
            ? redactRallarBlackBoxValue(row.value, redaction)
            : undefined
    }));
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
    input: ToGroupAssertionErrorInput
): RallarBlackBoxDistributedGroupAssertionResult['error'] {
    const assertion = input.assertion;
    const details = redactRallarBlackBoxValue({
        aggregate: assertion.aggregate,
        source: assertion.source,
        scopeRole: assertion.scope?.role,
        minParticipants: assertion.minParticipants,
        missingAgentIds: input.missingAgentIds,
        brokenEvidenceAgentIds: input.brokenEvidence.map((row) => row.agentId),
        violatingAgentIds: input.verdict.violatingAgentIds,
        aggregateDetail: input.verdict.detail,
        perAgent: toRedactedAgentRows(input.rows, input.verdict, input.redaction)
    }, input.redaction);

    if (!input.evidenceOk) {
        const broken = input.brokenEvidence.map((row) => `${row.agentId} (${row.status})`);
        const missing = [...input.missingAgentIds, ...broken].join(', ');
        return {
            code: RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING,
            message: `Group assertion ${assertion.groupAssertionId} lacks usable evidence at ` +
                `${assertion.source.recipeId}/${assertion.source.commandId}/` +
                `${assertion.source.path} from: ${missing}.`,
            details
        };
    }
    return {
        code: RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED,
        message: `Group assertion ${assertion.groupAssertionId} failed: ${input.verdict.reason}.`,
        details
    };
}

function toNoParticipantsResult(
    assertion: RallarBlackBoxDistributedGroupAssertion
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
            message: `Group assertion ${assertion.groupAssertionId} cannot evaluate: ${scopeText}.`
        }
    };
}
