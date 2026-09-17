import type {
    RallarBlackBoxDistributedRecipeResult,
    RallarBlackBoxDistributedRunItemState,
    RallarBlackBoxDistributedRunManifest
} from '../distributed-run.ts';
import type { RallarBlackBoxTestRedactionOptions } from '../rallar-black-box-test-contracts.ts';
import { redactRallarBlackBoxValue } from '../redaction.ts';
import { evaluateGroupAssertionAggregate, type GroupAssertionVerdict } from './group-assertions-aggregates.ts';
import {
    computeGroupAssertionEvidenceRows,
    type DistributedGroupAssertionParticipant,
    type DistributedGroupAssertionRecipeEvidence,
    type GroupAssertionEvidenceRow,
    type ResolvedGroupAssertionEvidenceRow
} from './group-assertions-evidence.ts';
import {
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_EVIDENCE_MISSING,
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_FAILED,
    RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS,
    type RallarBlackBoxDistributedGroupAssertion,
    type RallarBlackBoxDistributedGroupAssertionResult,
    type RallarBlackBoxGroupAssertionAgentRow,
    type RallarBlackBoxGroupAssertionAgentVerdict,
    type RallarBlackBoxGroupAssertionParticipantCounts,
    type RallarBlackBoxMatchingGroupAssertionResult
} from './group-assertions.ts';

const COMPLETED_RECIPE_STATES: readonly RallarBlackBoxDistributedRunItemState[] = [
    'passed',
    'failed',
    'cancelled',
    'timed-out',
    'disconnected',
    'skipped'
];

export interface ComputeDistributedGroupAssertionResultsInput {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly participants: readonly DistributedGroupAssertionParticipant[];
    readonly recipeResults: readonly RallarBlackBoxDistributedRecipeResult[];
    readonly recipeEvidence: readonly DistributedGroupAssertionRecipeEvidence[];
    /** Absent when recorded evidence values are reported without redaction. */
    readonly redaction?: RallarBlackBoxTestRedactionOptions;
}

// Coordinator-side evaluation over the frozen participant set. Returns
// undefined while dispatched recipes are still executing; the control-server
// rollup calls this on every refresh, so the first fully completed pass is
// the one that decides.
export function computeDistributedGroupAssertionResults(
    input: ComputeDistributedGroupAssertionResultsInput
): readonly RallarBlackBoxDistributedGroupAssertionResult[] | undefined {
    const groupAssertions = input.manifest.groupAssertions;
    if (groupAssertions.length === 0) {
        return undefined;
    }
    const dispatched = input.recipeResults;
    const complete = dispatched.length > 0 &&
        dispatched.every((recipe) => COMPLETED_RECIPE_STATES.includes(recipe.state));
    if (!complete) {
        return undefined;
    }
    return groupAssertions.map((assertion) => computeGroupAssertionResult(assertion, input));
}

function computeGroupAssertionResult(
    assertion: RallarBlackBoxDistributedGroupAssertion,
    input: ComputeDistributedGroupAssertionResultsInput
): RallarBlackBoxDistributedGroupAssertionResult {
    const scopeRole = assertion.scope?.role;
    const scopedParticipants = scopeRole === undefined
        ? input.participants
        : input.participants.filter((participant) => participant.roles.includes(scopeRole));
    if (scopedParticipants.length === 0) {
        return toNoParticipantsResult(assertion);
    }

    const rows = computeGroupAssertionEvidenceRows({
        source: assertion.source,
        participants: scopedParticipants,
        recipeEvidence: input.recipeEvidence
    });
    const resolved = rows.filter((row): row is ResolvedGroupAssertionEvidenceRow => row.status === 'resolved');
    const requiredParticipants = assertion.minParticipants ?? scopedParticipants.length;
    const brokenEvidence = rows.filter((row) => row.status === 'duplicate' || row.status === 'unresolved');
    const verdict = evaluateGroupAssertionAggregate(assertion, resolved);

    return toGroupAssertionResult({
        assertion,
        counts: {
            expected: scopedParticipants.length,
            required: requiredParticipants,
            withEvidence: resolved.length
        },
        outcome: toGroupAssertionOutcome({
            assertion,
            perAgent: toRedactedAgentRows(rows, verdict, input.redaction),
            verdict,
            evidenceOk: brokenEvidence.length === 0 && resolved.length >= requiredParticipants,
            missingAgentIds: rows.filter((row) => row.status === 'missing').map((row) => row.agentId),
            brokenEvidence,
            redaction: input.redaction
        })
    });
}

function toGroupAssertionOutcome(input: ToGroupAssertionOutcomeInput): GroupAssertionOutcome {
    const ok = input.evidenceOk && input.verdict.ok;
    return {
        ok,
        missingAgentIds: input.missingAgentIds,
        violatingAgentIds: input.verdict.violatingAgentIds,
        perAgent: input.perAgent,
        error: ok ? undefined : toGroupAssertionError(input)
    };
}

function toGroupAssertionResult(input: ToGroupAssertionResultInput): RallarBlackBoxDistributedGroupAssertionResult {
    const { assertion } = input;
    if (assertion.aggregate === 'allEqual' || assertion.aggregate === 'allEqualWithin') {
        return {
            groupAssertionId: assertion.groupAssertionId,
            aggregate: assertion.aggregate,
            participants: input.counts,
            ...input.outcome
        };
    }
    const matching = input.outcome.perAgent
        .filter((row) => row.evidence === 'resolved' && row.verdict === 'matching')
        .length;
    return {
        groupAssertionId: assertion.groupAssertionId,
        aggregate: assertion.aggregate,
        participants: { ...input.counts, matching },
        ...input.outcome
    };
}

function toRedactedAgentRows(
    rows: readonly GroupAssertionEvidenceRow[],
    verdict: GroupAssertionVerdict,
    redaction: RallarBlackBoxTestRedactionOptions | undefined
): readonly RallarBlackBoxGroupAssertionAgentRow[] {
    const matchingAgentIds = new Set(verdict.kind === 'predicate' ? verdict.matchingAgentIds : []);
    const violatingAgentIds = new Set(verdict.violatingAgentIds);
    const toAgentVerdict = (agentId: string): RallarBlackBoxGroupAssertionAgentVerdict =>
        verdict.kind === 'predicate'
            ? matchingAgentIds.has(agentId) ? 'matching' : 'not-matching'
            : violatingAgentIds.has(agentId)
            ? 'violating'
            : 'agreeing';
    return rows.map((row) =>
        row.status === 'resolved'
            ? {
                agentId: row.agentId,
                role: row.role,
                evidence: row.status,
                verdict: toAgentVerdict(row.agentId),
                value: redactRallarBlackBoxValue(row.value, redaction)
            }
            : { agentId: row.agentId, role: row.role, evidence: row.status }
    );
}

type GroupAssertionOutcome = Pick<
    RallarBlackBoxMatchingGroupAssertionResult,
    'ok' | 'missingAgentIds' | 'violatingAgentIds' | 'perAgent' | 'error'
>;

interface ToGroupAssertionResultInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly counts: RallarBlackBoxGroupAssertionParticipantCounts;
    readonly outcome: GroupAssertionOutcome;
}

interface ToGroupAssertionOutcomeInput {
    readonly assertion: RallarBlackBoxDistributedGroupAssertion;
    readonly perAgent: readonly RallarBlackBoxGroupAssertionAgentRow[];
    readonly verdict: GroupAssertionVerdict;
    readonly evidenceOk: boolean;
    readonly missingAgentIds: readonly string[];
    readonly brokenEvidence: readonly GroupAssertionEvidenceRow[];
    readonly redaction: RallarBlackBoxTestRedactionOptions | undefined;
}

function toGroupAssertionError(
    input: ToGroupAssertionOutcomeInput
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
        perAgent: input.perAgent
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
    return toGroupAssertionResult({
        assertion,
        counts: { expected: 0, required: assertion.minParticipants ?? 0, withEvidence: 0 },
        outcome: {
            ok: false,
            missingAgentIds: [],
            violatingAgentIds: [],
            perAgent: [],
            error: {
                code: RALLAR_BB_DISTRIBUTED_GROUP_ASSERTION_NO_PARTICIPANTS,
                message: `Group assertion ${assertion.groupAssertionId} cannot evaluate: ${scopeText}.`
            }
        }
    });
}
