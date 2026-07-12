import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { DistributedRunRecipeProgressRow } from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
import { recipeConsoleControlRunSelectionPatch } from '../control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type MonitorSelectionIssue = Readonly<{
    code: 'unavailable' | 'incompatible' | 'ambiguous';
    message: string;
}>;

export type MonitorDistributedRunSelection = Readonly<{
    distributedRunId?: string;
    run?: ControlDistributedRunSnapshot;
    source: 'explicit' | 'sole-compatible' | 'none';
    issue?: MonitorSelectionIssue;
    urlReplacePatch?: Partial<RecipeConsoleUrlState>;
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
    role?: string;
    profile?: string;
}>;

export function createMonitorRecipeEvidenceSelectionId(
    identity: MonitorRecipeEvidenceIdentity,
): string {
    return JSON.stringify([
        'recipe-role',
        identity.recipeId,
        identity.role ?? null,
        identity.profile ?? null,
    ]);
}

export function parseMonitorRecipeEvidenceSelectionId(
    selectionId: string,
): MonitorRecipeEvidenceIdentity | undefined {
    try {
        const value: unknown = JSON.parse(selectionId);
        if (!Array.isArray(value) || value.length !== 4 ||
            value[0] !== 'recipe-role' || typeof value[1] !== 'string' ||
            (value[2] !== null && typeof value[2] !== 'string') ||
            (value[3] !== null && typeof value[3] !== 'string')) {
            return undefined;
        }
        return {
            recipeId: value[1],
            ...(value[2] === null ? {} : { role: value[2] }),
            ...(value[3] === null ? {} : { profile: value[3] }),
        };
    } catch {
        return undefined;
    }
}

export function monitorEvidenceSelectionIdentifier(
    selection: MonitorEvidenceSelection | undefined,
): string | undefined {
    if (selection?.kind !== 'recipe') return selection?.id;
    const identity = parseMonitorRecipeEvidenceSelectionId(selection.id);
    return identity
        ? [identity.recipeId, identity.role, identity.profile]
            .filter(Boolean)
            .join(' · ')
        : selection.id;
}

export function deriveMonitorRecipeEvidenceStatus(
    rows: readonly DistributedRunRecipeProgressRow[],
    selectionId: string,
): 'failed' | 'warning' | 'passed' | 'partial' {
    const identity = parseMonitorRecipeEvidenceSelectionId(selectionId);
    const selected = rows.filter(row =>
        row.recipeId === (identity?.recipeId ?? selectionId) &&
        (!identity || (
            row.role === identity.role && row.profile === identity.profile
        ))
    );
    if (selected.some(row => row.failedCount > 0)) return 'failed';
    if (selected.some(row => row.missingCount > 0)) return 'warning';
    if (selected.length > 0 && selected.every(row =>
        row.targetCount > 0 && row.passedCount >= row.targetCount
    )) return 'passed';
    return 'partial';
}

export function deriveMonitorUrlEvidenceSelection(
    state: RecipeConsoleUrlState,
): MonitorEvidenceSelection | undefined {
    if (state.commandId) return { kind: 'command', id: state.commandId };
    if (state.recipeId) return { kind: 'recipe', id: state.recipeId };
    if (state.agentId) return { kind: 'agent', id: state.agentId };
    return undefined;
}

export function monitorUrlEvidenceKey(state: RecipeConsoleUrlState): string {
    return JSON.stringify([
        state.agentId,
        state.recipeId,
        state.commandId,
    ]);
}

export function deriveMonitorDistributedRunSelection(input: Readonly<{
    controlRunId?: string;
    requestedDistributedRunId?: string;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    distributedRunsAuthoritative: boolean;
}>): MonitorDistributedRunSelection {
    const compatible = input.controlRunId
        ? input.distributedRuns.filter(run =>
            run.controlRunId === input.controlRunId
        )
        : [];

    if (input.requestedDistributedRunId) {
        const candidate = input.distributedRuns.find(run =>
            run.distributedRunId === input.requestedDistributedRunId
        );
        const run = candidate?.controlRunId === input.controlRunId
            ? candidate
            : undefined;
        if (run) {
            return {
                distributedRunId: input.requestedDistributedRunId,
                run,
                source: 'explicit',
            };
        }
        return {
            distributedRunId: input.requestedDistributedRunId,
            run: undefined,
            source: 'explicit',
            issue: !input.distributedRunsAuthoritative
                ? undefined
                : candidate
                ? {
                    code: 'incompatible',
                    message: `Distributed run ${input.requestedDistributedRunId} belongs to another control run.`,
                }
                : {
                    code: 'unavailable',
                    message: `Distributed run ${input.requestedDistributedRunId} is not available in the selected control run.`,
                },
        };
    }

    if (input.distributedRunsAuthoritative && compatible.length === 1) {
        const run = compatible[0];
        return {
            distributedRunId: run.distributedRunId,
            run,
            source: 'sole-compatible',
            urlReplacePatch: { distributedRunId: run.distributedRunId },
        };
    }
    if (compatible.length > 1) {
        return {
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
            issue: {
                code: 'ambiguous',
                message: 'Multiple compatible distributed runs are available; select one explicitly.',
            },
        };
    }
    return { distributedRunId: undefined, run: undefined, source: 'none' };
}

export function recipeConsoleMonitorDistributedRunSelectionPatch(
    distributedRunId: string,
): Partial<RecipeConsoleUrlState> {
    return {
        distributedRunId,
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined,
    };
}

export function recipeConsoleMonitorControlRunSelectionPatch(input: Readonly<{
    state: RecipeConsoleUrlState;
    controlRunId: string;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
}>): Partial<RecipeConsoleUrlState> {
    return {
        ...recipeConsoleControlRunSelectionPatch(input),
        agentId: undefined,
        recipeId: undefined,
        commandId: undefined,
    };
}
