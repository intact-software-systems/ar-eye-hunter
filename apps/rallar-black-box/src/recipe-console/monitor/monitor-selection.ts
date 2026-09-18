import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { DistributedRunRecipeProgressRow } from '@shared-test/rallar-bb-test/distributed-run-observation/distributed-run-row-contracts.ts';
import { recipeConsoleControlRunSelectionPatch } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type MonitorSelectionIssue = Readonly<{
    code: 'unavailable' | 'incompatible' | 'ambiguous';
    message: string;
}>;

export type MonitorDistributedRunSelection = Readonly<{
    /** Absent when no distributed run is selected, so `source` is `none`. */
    distributedRunId?: string;
    /** Absent when the selected id names no run the current control run owns. */
    run?: ControlDistributedRunSnapshot;
    source: 'explicit' | 'sole-compatible' | 'none';
    /** Absent when the selection is usable, so the operator has nothing to resolve. */
    issue?: MonitorSelectionIssue;
    /** Absent unless the selection was inferred and the URL must adopt it. */
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
}>;

export type MonitorSelectionIndexWork = Readonly<{
    indexed: boolean;
    fallback: boolean;
}>;

export type MonitorEvidenceSelection = Readonly<{
    kind:
        | 'failure'
        | 'agent'
        | 'recipe'
        | 'command'
        | 'diagnostic'
        | 'timeline'
        | 'event'
        | 'artifact';
    id: string;
}>;

export const MONITOR_ARTIFACT_EVIDENCE_ID = 'artifact';

export type MonitorRecipeEvidenceIdentity = Readonly<{
    recipeId: string;
    /** Absent when the progress row assigns the recipe no role. */
    role?: string;
    /** Absent when the progress row names no profile for the recipe. */
    profile?: string;
}>;

export function createMonitorRecipeEvidenceSelectionId(
    identity: MonitorRecipeEvidenceIdentity
): string {
    return JSON.stringify([
        'recipe-role',
        identity.recipeId,
        identity.role ?? null,
        identity.profile ?? null
    ]);
}

export function toMonitorRecipeEvidenceIdentity(
    selectionId: string
): MonitorRecipeEvidenceIdentity | undefined {
    try {
        return decodeMonitorRecipeEvidenceSelectionId(JSON.parse(selectionId));
    }
    catch {
        return undefined;
    }
}

export function toMonitorEvidenceSelectionLabel(
    selection: MonitorEvidenceSelection
): string {
    if (selection.kind !== 'recipe') {
        return selection.id;
    }
    const identity = toMonitorRecipeEvidenceIdentity(selection.id);
    return identity
        ? [identity.recipeId, identity.role, identity.profile]
            .filter(Boolean)
            .join(' · ')
        : selection.id;
}

export function computeMonitorRecipeEvidenceStatus(
    rows: readonly DistributedRunRecipeProgressRow[],
    selectionId: string
): 'failed' | 'warning' | 'passed' | 'partial' {
    const identity = toMonitorRecipeEvidenceIdentity(selectionId);
    const selected = rows.filter((row) =>
        row.recipeId === (identity?.recipeId ?? selectionId) &&
        (!identity || (
            row.role === identity.role && row.profile === identity.profile
        ))
    );
    if (selected.some((row) => row.failedCount > 0)) {
        return 'failed';
    }
    if (selected.some((row) => row.missingCount > 0)) {
        return 'warning';
    }
    if (selected.length > 0 && selected.every((row) => row.targetCount > 0 && row.passedCount >= row.targetCount)) {
        return 'passed';
    }
    return 'partial';
}

export function resolveMonitorUrlEvidenceSelection(
    state: RecipeConsoleUrlState
): MonitorEvidenceSelection | undefined {
    if (state.commandId) {
        return { kind: 'command', id: state.commandId };
    }
    if (state.recipeId) {
        return { kind: 'recipe', id: state.recipeId };
    }
    if (state.agentId) {
        return { kind: 'agent', id: state.agentId };
    }
    return undefined;
}

export function toMonitorUrlEvidenceKey(state: RecipeConsoleUrlState): string {
    return JSON.stringify([
        state.agentId,
        state.recipeId,
        state.commandId
    ]);
}

export function createMonitorDistributedRunSelectionPatch(
    distributedRunId: string
): Partial<RecipeConsoleUrlState> {
    return {
        distributedRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined
    };
}

export function createMonitorControlRunSelectionPatch(
    input: Readonly<{
        state: RecipeConsoleUrlState;
        controlRunId: string;
        distributedRuns: readonly ControlDistributedRunSnapshot[];
    }>
): Partial<RecipeConsoleUrlState> {
    return {
        ...recipeConsoleControlRunSelectionPatch(input),
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined
    };
}

function decodeMonitorRecipeEvidenceSelectionId(
    value: unknown
): MonitorRecipeEvidenceIdentity | undefined {
    if (
        !Array.isArray(value) || value.length !== 4 ||
        value[0] !== 'recipe-role' || typeof value[1] !== 'string' ||
        (value[2] !== null && typeof value[2] !== 'string') ||
        (value[3] !== null && typeof value[3] !== 'string')
    ) {
        return undefined;
    }
    return {
        recipeId: value[1],
        ...(value[2] === null ? {} : { role: value[2] }),
        ...(value[3] === null ? {} : { profile: value[3] })
    };
}
