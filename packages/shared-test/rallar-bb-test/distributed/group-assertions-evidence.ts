import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import { isRallarBlackBoxTestResult, toRallarBlackBoxCompositeResultFlatEntries } from '../composite-results.ts';
import type { ControlResultEnvelope } from '../control-protocol.ts';
import type { ControlDistributedRunCommandLink } from '../control-snapshots.ts';
import type { RallarBlackBoxDistributedTargetResolution } from '../distributed-run.ts';
import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodePayloadPathValue } from '../wait/wait-event-match.ts';
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

export interface DistributedGroupAssertionRecordedRecipeEvidence extends DistributedGroupAssertionRecipeEvidenceFields {
    readonly hasResult: true;
    readonly resultValue: RallarBlackBoxGroupAssertionValue;
}

export interface DistributedGroupAssertionPendingRecipeEvidence extends DistributedGroupAssertionRecipeEvidenceFields {
    readonly hasResult: false;
}

export type GroupAssertionEvidenceRow = ResolvedGroupAssertionEvidenceRow | UnusableGroupAssertionEvidenceRow;

export interface ResolvedGroupAssertionEvidenceRow extends GroupAssertionEvidenceRowFields {
    readonly status: 'resolved';
    /** The value the source path reaches, in its JSON form. */
    readonly value: ApiJsonValue;
}

export interface UnusableGroupAssertionEvidenceRow extends GroupAssertionEvidenceRowFields {
    readonly status: 'missing' | 'duplicate' | 'unresolved' | 'undecodable';
}

export interface ToDistributedGroupAssertionRecipeEvidenceInput {
    readonly commandLinks: readonly ControlDistributedRunCommandLink[];
    readonly resultByCommandId: ReadonlyMap<string, ControlResultEnvelope>;
}

/** Each agent's start-recipe evidence with its recorded result tree flattened once. */
export interface GroupAssertionEvidenceIndex {
    readonly recipesByAgentId: ReadonlyMap<string, readonly IndexedGroupAssertionRecipeEvidence[]>;
}

export interface ComputeGroupAssertionEvidenceRowsInput {
    readonly source: RallarBlackBoxGroupAssertionSource;
    readonly participants: readonly DistributedGroupAssertionParticipant[];
    readonly evidenceIndex: GroupAssertionEvidenceIndex;
}

interface DistributedGroupAssertionRecipeEvidenceFields {
    readonly agentId: string;
    /** Absent when the start command link names no recipe. */
    readonly recipeId?: string;
    /** Absent when the start command link names no role. */
    readonly role?: string;
}

interface GroupAssertionEvidenceRowFields {
    readonly agentId: string;
    /** Absent when the participant holds no role. */
    readonly role?: string;
}

interface IndexedGroupAssertionRecipeEvidence {
    /** Absent when the start command link names no recipe. */
    readonly recipeId?: string;
    /** Absent while the recipe has no recorded result. */
    readonly commandResults?: RecipeCommandResults;
}

interface RecipeCommandResults {
    /** A composite child is listed under its own command id and under the recipe command id it ran. */
    readonly resultsByCommandId: ReadonlyMap<string, readonly RallarBlackBoxTestResult[]>;
    /** True when a recorded command result or composite child does not decode, so it may hide the addressed command. */
    readonly hasUndecodableResults: boolean;
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

export function toGroupAssertionEvidenceIndex(
    recipeEvidence: readonly DistributedGroupAssertionRecipeEvidence[]
): GroupAssertionEvidenceIndex {
    const recipesByAgentId = new Map<string, IndexedGroupAssertionRecipeEvidence[]>();
    for (const evidence of recipeEvidence) {
        const recipes = recipesByAgentId.get(evidence.agentId) ?? [];
        recipes.push({
            recipeId: evidence.recipeId,
            commandResults: evidence.hasResult ? toRecipeCommandResults(evidence.resultValue) : undefined
        });
        recipesByAgentId.set(evidence.agentId, recipes);
    }
    return { recipesByAgentId };
}

export function computeGroupAssertionEvidenceRows(
    input: ComputeGroupAssertionEvidenceRowsInput
): readonly GroupAssertionEvidenceRow[] {
    return input.participants.map((participant) =>
        toGroupAssertionEvidenceRow(participant, input.source, input.evidenceIndex)
    );
}

function toGroupAssertionEvidenceRow(
    participant: DistributedGroupAssertionParticipant,
    source: RallarBlackBoxGroupAssertionSource,
    evidenceIndex: GroupAssertionEvidenceIndex
): GroupAssertionEvidenceRow {
    const fields: GroupAssertionEvidenceRowFields = { agentId: participant.agentId, role: participant.roles[0] };
    const recipes = (evidenceIndex.recipesByAgentId.get(participant.agentId) ?? [])
        .filter((recipe) => recipe.recipeId === source.recipeId);
    if (recipes.length > 1) {
        return { ...fields, status: 'duplicate' };
    }
    const commandResults = recipes[0]?.commandResults;
    return commandResults === undefined
        ? { ...fields, status: 'missing' }
        : toRecordedGroupAssertionEvidenceRow(fields, source, commandResults);
}

/** The addressed command must appear exactly once among the recipe's decodable results and reach a value at the path. */
function toRecordedGroupAssertionEvidenceRow(
    fields: GroupAssertionEvidenceRowFields,
    source: RallarBlackBoxGroupAssertionSource,
    commandResults: RecipeCommandResults
): GroupAssertionEvidenceRow {
    const matches = commandResults.resultsByCommandId.get(source.commandId) ?? [];
    if (matches.length === 0) {
        return { ...fields, status: commandResults.hasUndecodableResults ? 'undecodable' : 'missing' };
    }
    if (matches.length > 1) {
        return { ...fields, status: 'duplicate' };
    }
    const lookup = decodePayloadPathValue(matches[0].value, source.path);
    return lookup.exists ? { ...fields, status: 'resolved', value: lookup.value } : { ...fields, status: 'unresolved' };
}

function toRecipeCommandResults(resultValue: RallarBlackBoxGroupAssertionValue): RecipeCommandResults {
    const recordedResults = isJsonRecordValue(resultValue) && Array.isArray(resultValue.results)
        ? resultValue.results
        : [];
    const rootResults = recordedResults.filter(isRallarBlackBoxTestResult);
    const entries = toRallarBlackBoxCompositeResultFlatEntries(rootResults);
    const resultsByCommandId = new Map<string, RallarBlackBoxTestResult[]>();
    for (const entry of entries) {
        const originalCommandId = entry.position.kind === 'root' ? undefined : entry.position.originalCommandId;
        const commandIds = originalCommandId === undefined || originalCommandId === entry.commandId
            ? [entry.commandId]
            : [entry.commandId, originalCommandId];
        for (const commandId of commandIds) {
            const results = resultsByCommandId.get(commandId) ?? [];
            results.push(entry.result);
            resultsByCommandId.set(commandId, results);
        }
    }
    return {
        resultsByCommandId,
        hasUndecodableResults: rootResults.length < recordedResults.length ||
            entries.some((entry) => entry.childDecodeIssues.length > 0)
    };
}
