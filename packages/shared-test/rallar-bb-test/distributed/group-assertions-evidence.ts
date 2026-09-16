import { flattenRallarBlackBoxCompositeResults } from '../composite-results.ts';
import type { ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { lookupPayloadPath } from '../wait/wait-event-match.ts';
import type {
    RallarBlackBoxGroupAssertionSource,
    RallarBlackBoxGroupAssertionValue
} from './group-assertions.ts';

export interface DistributedGroupAssertionParticipant {
    readonly agentId: string;
    readonly roles: readonly string[];
}

export type DistributedGroupAssertionRecipeEvidence =
    | DistributedGroupAssertionRecordedRecipeEvidence
    | DistributedGroupAssertionPendingRecipeEvidence;

interface DistributedGroupAssertionRecipeEvidenceFields {
    readonly agentId: string;
    /** Absent when the start command link names no recipe. */
    readonly recipeId?: string;
    /** Absent when the start command link names no role. */
    readonly role?: string;
}

export interface DistributedGroupAssertionRecordedRecipeEvidence extends DistributedGroupAssertionRecipeEvidenceFields {
    readonly hasResult: true;
    readonly resultValue: RallarBlackBoxGroupAssertionValue;
}

export interface DistributedGroupAssertionPendingRecipeEvidence extends DistributedGroupAssertionRecipeEvidenceFields {
    readonly hasResult: false;
}

export type GroupAssertionEvidenceRow = ResolvedGroupAssertionEvidenceRow | UnusableGroupAssertionEvidenceRow;

interface GroupAssertionEvidenceRowFields {
    readonly agentId: string;
    /** Absent when the participant holds no role. */
    readonly role?: string;
}

export interface ResolvedGroupAssertionEvidenceRow extends GroupAssertionEvidenceRowFields {
    readonly status: 'resolved';
    readonly value: RallarBlackBoxGroupAssertionValue;
}

export interface UnusableGroupAssertionEvidenceRow extends GroupAssertionEvidenceRowFields {
    readonly status: 'missing' | 'duplicate' | 'unresolved';
}

interface RecipeCommandResult {
    readonly commandId: string;
    /** Absent when the command result is not a composite child. */
    readonly originalCommandId?: string;
    readonly result: RallarBlackBoxTestResult;
}

// The participant set is frozen at target resolution: evaluation reads the
// recorded snapshot, never the live agent board, so late joins and drops
// cannot change the assertion denominator after staging.
export function toDistributedGroupAssertionParticipants(
    targetResolution: RallarBlackBoxDistributedTargetResolution | undefined
): readonly DistributedGroupAssertionParticipant[] {
    if (!targetResolution) {
        return [];
    }
    return targetResolution.targetAgentIds.map((agentId) => ({
        agentId,
        roles: targetResolution.roleAssignments
            .filter((assignment) => assignment.agentId === agentId)
            .map((assignment) => assignment.role)
    }));
}

export interface ToDistributedGroupAssertionRecipeEvidenceInput {
    readonly commandLinks: readonly ControlDistributedRunCommandLink[];
    readonly resultByCommandId: ReadonlyMap<string, ControlResultEnvelope>;
}

export function toDistributedGroupAssertionRecipeEvidence(
    input: ToDistributedGroupAssertionRecipeEvidenceInput
): readonly DistributedGroupAssertionRecipeEvidence[] {
    return input.commandLinks
        .filter((link) => link.phase === 'start')
        .map((link): DistributedGroupAssertionRecipeEvidence => {
            const result = input.resultByCommandId.get(link.commandId);
            return result === undefined
                ? { agentId: link.agentId, recipeId: link.recipeId, role: link.role, hasResult: false }
                : {
                    agentId: link.agentId,
                    recipeId: link.recipeId,
                    role: link.role,
                    hasResult: true,
                    resultValue: result.result?.value
                };
        });
}

export interface ComputeGroupAssertionEvidenceRowsInput {
    readonly source: RallarBlackBoxGroupAssertionSource;
    readonly participants: readonly DistributedGroupAssertionParticipant[];
    readonly recipeEvidence: readonly DistributedGroupAssertionRecipeEvidence[];
}

export function computeGroupAssertionEvidenceRows(
    input: ComputeGroupAssertionEvidenceRowsInput
): readonly GroupAssertionEvidenceRow[] {
    return input.participants.map((participant) =>
        toGroupAssertionEvidenceRow(participant, input.source, input.recipeEvidence)
    );
}

function toGroupAssertionEvidenceRow(
    participant: DistributedGroupAssertionParticipant,
    source: RallarBlackBoxGroupAssertionSource,
    recipeEvidence: readonly DistributedGroupAssertionRecipeEvidence[]
): GroupAssertionEvidenceRow {
    const role = participant.roles[0];
    const recipeRows = recipeEvidence.filter((evidence) =>
        evidence.agentId === participant.agentId && evidence.recipeId === source.recipeId
    );
    if (recipeRows.length === 0) {
        return { agentId: participant.agentId, role, status: 'missing' };
    }
    if (recipeRows.length > 1) {
        return { agentId: participant.agentId, role, status: 'duplicate' };
    }

    const recipeRow = recipeRows[0];
    if (!recipeRow.hasResult) {
        return { agentId: participant.agentId, role, status: 'missing' };
    }

    const commandResults = toRecipeCommandResults(recipeRow.resultValue);
    const matches = commandResults.filter((entry) =>
        entry.commandId === source.commandId || entry.originalCommandId === source.commandId
    );
    if (matches.length === 0) {
        return { agentId: participant.agentId, role, status: 'missing' };
    }
    if (matches.length > 1) {
        return { agentId: participant.agentId, role, status: 'duplicate' };
    }

    const lookup = lookupPayloadPath(matches[0].result.value, source.path);
    if (!lookup.exists) {
        return { agentId: participant.agentId, role, status: 'unresolved' };
    }
    return {
        agentId: participant.agentId,
        role,
        status: 'resolved',
        value: lookup.value
    };
}

function toRecipeCommandResults(resultValue: RallarBlackBoxGroupAssertionValue): readonly RecipeCommandResult[] {
    const results = isJsonRecordValue(resultValue) && Array.isArray(resultValue.results) ? resultValue.results : [];
    const rootResults = results.filter(isCommandResult);
    return flattenRallarBlackBoxCompositeResults(rootResults).map((entry) => ({
        commandId: entry.commandId,
        originalCommandId: entry.originalCommandId,
        result: entry.result
    }));
}

function isCommandResult(candidate: unknown): candidate is RallarBlackBoxTestResult {
    return isJsonRecordValue(candidate) &&
        typeof candidate.commandId === 'string' &&
        typeof candidate.kind === 'string';
}
