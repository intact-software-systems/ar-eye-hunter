import { describe, expect, it } from 'vitest';
import type { ControlDistributedRunSnapshot } from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    classifyExecuteMutationResponse,
    createExecuteTargetContextKey,
    DEFAULT_EXECUTE_RECIPE_ID,
    deriveExecuteRecipeSelection,
    filterExecuteRecipeCatalog,
    recipeConsoleExecuteRecipeSelectionPatch,
    reconcileExecuteRunTruth,
    reconcileExecuteTargetSelection,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-workflow-state.ts';
import {
    executeConnectionTruth,
} from '../../../apps/rallar-black-box/src/recipe-console/execute/execute-workflow-context.ts';
import type {
    RecipeConsoleControlConnection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import {
    projectDistributedRecipeCatalog,
    type DistributedRecipeCatalogEntryProjection,
} from '../../../packages/shared-test/rallar-bb-test/distributed-recipe-catalog.ts';
import type { RallarBlackBoxDistributedRunState } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const catalog = projectDistributedRecipeCatalog().entries;

function catalogEntry(
    recipeId: string,
): DistributedRecipeCatalogEntryProjection {
    const entry = catalog.find((candidate) =>
        candidate.item.recipe.recipeId === recipeId
    );
    if (!entry) throw new Error(`Missing test recipe ${recipeId}.`);
    return entry;
}

function distributedRun(
    state: RallarBlackBoxDistributedRunState,
    overrides: Partial<ControlDistributedRunSnapshot> = {},
): ControlDistributedRunSnapshot {
    const distributedRunId = overrides.distributedRunId ?? 'distributed-a';
    return {
        distributedRunId,
        controlRunId: 'run-a',
        state,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 10,
        targetAgentIds: ['agent-a'],
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId: 'run-a',
            group: {
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
            recipes: [{ recipeId: DEFAULT_EXECUTE_RECIPE_ID }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-a'],
                expectedParticipantCount: 1,
            },
            startMode: 'manual',
        },
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: state === 'ready' ? 1 : 0,
                passedParticipants: state === 'passed' ? 1 : 0,
                failedParticipants: state === 'failed' ? 1 : 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                blockingFailures: state === 'failed' ? 1 : 0,
            },
            failures: [],
        },
        ...overrides,
    };
}

describe('Recipe Console Execute pure workflow state', () => {
    it('keeps reachable protocol failures distinct from unreachable control', () => {
        const connection = {
            query: {
                status: 'offline',
                reachability: 'reachable',
                authorization: 'ready',
            },
        } as RecipeConsoleControlConnection;

        expect(executeConnectionTruth(connection)).toBe('error');
    });

    it('keeps credential trust blocking distinct from ordinary authorization', () => {
        const connection = {
            query: {
                status: 'offline',
                reachability: 'reachable',
                authorization: 'required',
                lastError: {
                    kind: 'http',
                    message: 'Automatic credentials were withheld.',
                    credentialTrustRequired: true,
                },
            },
        } as RecipeConsoleControlConnection;

        expect(executeConnectionTruth(connection)).toBe('credential-trust');
    });

    it('selects the approved canonical default independent of catalog order', () => {
        const selection = deriveExecuteRecipeSelection({
            entries: [...catalog].reverse(),
        });

        expect(DEFAULT_EXECUTE_RECIPE_ID).toBe('rtc-realtime-stability');
        expect(selection).toMatchObject({
            source: 'default',
            selected: {
                item: { recipe: { recipeId: DEFAULT_EXECUTE_RECIPE_ID } },
            },
            urlReplacePatch: { recipeId: DEFAULT_EXECUTE_RECIPE_ID },
        });
    });

    it('blocks unknown, duplicate, and missing-default recipe identities without index fallback', () => {
        const selected = catalogEntry(DEFAULT_EXECUTE_RECIPE_ID);
        const duplicate: DistributedRecipeCatalogEntryProjection = {
            ...selected,
            item: {
                ...selected.item,
                itemId: 'duplicate-item-id',
            },
        };
        const first = catalog.find((entry) =>
            entry.item.recipe.recipeId !== DEFAULT_EXECUTE_RECIPE_ID
        );

        expect(deriveExecuteRecipeSelection({
            entries: catalog,
            recipeId: 'unknown-recipe',
        })).toMatchObject({
            source: 'explicit',
            selected: undefined,
            issue: { code: 'unavailable' },
        });
        expect(deriveExecuteRecipeSelection({
            entries: [selected, duplicate],
            recipeId: DEFAULT_EXECUTE_RECIPE_ID,
        })).toMatchObject({
            selected: undefined,
            issue: { code: 'ambiguous' },
        });
        expect(deriveExecuteRecipeSelection({
            entries: first ? [first] : [],
        })).toMatchObject({
            source: 'none',
            selected: undefined,
            issue: { code: 'default-unavailable' },
        });
    });

    it('matches explicit canonical recipe IDs rather than catalog item IDs', () => {
        const selected = catalogEntry(DEFAULT_EXECUTE_RECIPE_ID);
        const entry = {
            ...selected,
            item: { ...selected.item, itemId: 'different-item-id' },
        };

        expect(deriveExecuteRecipeSelection({
            entries: [entry],
            recipeId: DEFAULT_EXECUTE_RECIPE_ID,
        }).selected?.item.itemId).toBe('different-item-id');
        expect(deriveExecuteRecipeSelection({
            entries: [entry],
            recipeId: 'different-item-id',
        }).selected).toBeUndefined();
    });

    it('filters search and profile together without changing catalog order', () => {
        const filtered = filterExecuteRecipeCatalog({
            entries: catalog,
            query: 'stability stream',
            profile: 'green',
        });

        expect(filtered.map((entry) => entry.item.recipe.recipeId)).toEqual([
            DEFAULT_EXECUTE_RECIPE_ID,
        ]);
        expect(filterExecuteRecipeCatalog({
            entries: catalog,
            query: 'stability stream',
            profile: 'negative',
        })).toEqual([]);
    });

    it('clears dependent run and command URL identity when recipe selection changes', () => {
        expect(recipeConsoleExecuteRecipeSelectionPatch('recipe-next')).toEqual({
            recipeId: 'recipe-next',
            distributedRunId: undefined,
            commandId: undefined,
        });
    });

    it('defaults targets only for a new context and never expands the same context silently', () => {
        const contextKey = createExecuteTargetContextKey({
            controlRunId: 'run-a',
            group: {
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
            recipeId: 'recipe-a',
        });
        const rows = [
            { agentId: 'agent-b', targetable: true },
            { agentId: 'agent-a', targetable: true },
            { agentId: 'agent-c', targetable: false },
        ];
        const initial = reconcileExecuteTargetSelection({
            contextKey,
            rows,
        });
        const refreshed = reconcileExecuteTargetSelection({
            contextKey: initial.contextKey,
            previous: initial,
            rows: [
                { agentId: 'agent-a', targetable: false },
                { agentId: 'agent-b', targetable: true },
                { agentId: 'agent-new', targetable: true },
            ],
        });
        const changed = reconcileExecuteTargetSelection({
            contextKey: createExecuteTargetContextKey({
                controlRunId: 'run-a',
                group: {
                    applicationId: 'app-a',
                    workspaceId: 'workspace-a',
                    groupId: 'group-a',
                },
                recipeId: 'recipe-b',
            }),
            previous: refreshed,
            rows: [
                { agentId: 'agent-new', targetable: true },
                { agentId: 'agent-b', targetable: true },
            ],
        });

        expect(initial.agentIds).toEqual(['agent-a', 'agent-b']);
        expect(refreshed.agentIds).toEqual(['agent-b']);
        expect(changed.agentIds).toEqual(['agent-b', 'agent-new']);
    });

    it('binds target selection context to control run, complete group, and recipe identity', () => {
        const base = {
            controlRunId: 'run-a',
            group: {
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
            recipeId: 'recipe-a',
        } as const;
        const baseline = createExecuteTargetContextKey(base);
        const variants = [
            createExecuteTargetContextKey({ ...base, controlRunId: 'run-b' }),
            createExecuteTargetContextKey({
                ...base,
                group: { ...base.group, applicationId: 'app-b' },
            }),
            createExecuteTargetContextKey({
                ...base,
                group: { ...base.group, workspaceId: 'workspace-b' },
            }),
            createExecuteTargetContextKey({
                ...base,
                group: { ...base.group, groupId: 'group-b' },
            }),
            createExecuteTargetContextKey({ ...base, recipeId: 'recipe-b' }),
        ];

        expect(variants.every((key) => key !== baseline)).toBe(true);
        expect(new Set(variants).size).toBe(variants.length);
    });

    it('reconciles only the selected run using timestamp and deterministic tie truth', () => {
        const olderOptimistic = distributedRun('waiting-for-ack', {
            updatedAtEpochMs: 10,
        });
        const newerQuery = distributedRun('ready', { updatedAtEpochMs: 11 });
        const terminalTie = distributedRun('failed', {
            updatedAtEpochMs: 11,
            error: { code: 'ack-failed', message: 'ACK failed.' },
        });

        expect(reconcileExecuteRunTruth({
            distributedRunId: 'distributed-a',
            optimisticRun: olderOptimistic,
            queriedRun: newerQuery,
        })?.state).toBe('ready');
        expect(reconcileExecuteRunTruth({
            distributedRunId: 'distributed-a',
            optimisticRun: newerQuery,
            queriedRun: terminalTie,
        })?.state).toBe('failed');
        expect(reconcileExecuteRunTruth({
            distributedRunId: 'distributed-a',
            optimisticRun: distributedRun('running', {
                distributedRunId: 'other-run',
            }),
            queriedRun: newerQuery,
        })).toBe(newerQuery);
        expect(reconcileExecuteRunTruth({
            distributedRunId: 'missing-run',
            optimisticRun: olderOptimistic,
            queriedRun: newerQuery,
        })).toBeUndefined();
    });

    it('retains mutation truth on equal non-terminal timestamps without proven query recency', () => {
        const optimistic = distributedRun('running', { updatedAtEpochMs: 20 });
        const queryError = distributedRun('running', {
            updatedAtEpochMs: 20,
            error: { code: 'runtime-warning', message: 'Runtime warning.' },
        });
        const queryTie = distributedRun('ready', { updatedAtEpochMs: 20 });

        expect(reconcileExecuteRunTruth({
            distributedRunId: 'distributed-a',
            optimisticRun: optimistic,
            queriedRun: queryError,
        })).toBe(optimistic);
        expect(reconcileExecuteRunTruth({
            distributedRunId: 'distributed-a',
            optimisticRun: optimistic,
            queriedRun: queryTie,
        })).toBe(optimistic);
    });

    it.each([
        ['create', 'draft', true],
        ['stage', 'waiting-for-ack', true],
        ['stage', 'ready', true],
        ['start', 'running', true],
        ['start', 'passed', true],
        ['cancel', 'cancelled', true],
        ['stage', 'failed', false],
        ['start', 'waiting-for-ack', false],
        ['cancel', 'passed', false],
    ] as const)('classifies %s HTTP success by authoritative %s state', (
        action,
        state,
        ok,
    ) => {
        const result = classifyExecuteMutationResponse(
            action,
            distributedRun(state),
        );

        expect(result.ok).toBe(ok);
        if (!ok) {
            expect(result.reason).toBeTruthy();
            expect(result.code).toBe(
                state === 'failed' ? 'terminal-failure' : 'unexpected-state',
            );
        }
    });
});
