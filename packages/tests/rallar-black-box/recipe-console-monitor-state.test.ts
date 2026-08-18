import { afterEach, describe, expect, it, vi } from 'vitest';
import * as distributedRecipes from
    '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { distributedRunMonitorDerivationWorkForTest } from
    '../../shared-test/rallar-bb-test/distributed-run-monitor-index.ts';
import { createControlSnapshotSelectionIndex } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import { createControlSelectionIndexCache } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-selection-index-cache.ts';
import { bindControlSelectionIndexToSnapshot } from
    '../../../apps/rallar-black-box/src/control-selection-index-binding.ts';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import type { ControlQuerySnapshot } from '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import {
    beginMonitorOperation,
    completeMonitorArtifactOperation,
    failMonitorOperation,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-operation-state.ts';
import {
    createInitialMonitorWorkspaceState,
    createMonitorWorkspaceContext,
    projectMonitorMutation,
    reconcileMonitorWorkspaceState,
    monitorWorkspaceReconciliationWorkForTest,
    setMonitorCancelArm,
    setMonitorEvidenceSelection,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-state.ts';
import { deriveMonitorWorkspaceModel } from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts';
import {
    createMonitorRecipeEvidenceSelectionId,
    deriveMonitorRecipeEvidenceStatus,
    deriveMonitorDistributedRunSelection,
    deriveMonitorRunOptions,
    monitorDistributedRunSelectionWorkForTest,
    monitorRunOptionsWorkForTest,
    deriveMonitorUrlEvidenceSelection,
    MONITOR_ARTIFACT_EVIDENCE_ID,
    monitorEvidenceSelectionIdentifier,
    monitorUrlEvidenceKey,
    parseMonitorRecipeEvidenceSelectionId,
    recipeConsoleMonitorControlRunSelectionPatch,
    recipeConsoleMonitorDistributedRunSelectionPatch,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-selection.ts';

const context = createMonitorWorkspaceContext({
    baseUrl: 'https://control.test/root///',
    controlRunId: 'run-a',
    distributedRunId: 'distributed-a',
});

afterEach(() => vi.restoreAllMocks());

function controlRun(
    runId = 'run-a',
    updatedAtEpochMs = 10,
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function distributedRun(
    distributedRunId = 'distributed-a',
    controlRunId = 'run-a',
    state: ControlDistributedRunSnapshot['state'] = 'running',
    updatedAtEpochMs = 10,
    overrides: Partial<ControlDistributedRunSnapshot> = {},
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        state,
        createdAtEpochMs: 1,
        updatedAtEpochMs,
        targetAgentIds: ['agent-a'],
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
            recipes: [{ recipeId: 'health-only', required: true }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-a'],
                expectedParticipantCount: 1,
            },
        },
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: 1,
                passedParticipants: state === 'passed' ? 1 : 0,
                failedParticipants: state === 'failed' ? 1 : 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: state === 'failed' ? 1 : 0,
            },
            failures: [],
        },
        ...overrides,
    };
}

function query(
    status: ControlQuerySnapshot<ControlServerSnapshot>['status'],
    snapshot?: ControlServerSnapshot,
    overrides: Partial<ControlQuerySnapshot<ControlServerSnapshot>> = {},
): ControlQuerySnapshot<ControlServerSnapshot> {
    return {
        status,
        reachability: status === 'offline' ? 'unreachable' : 'reachable',
        authorization: 'ready',
        snapshot,
        receivedAtEpochMs: snapshot ? 100 : undefined,
        isRefreshing: false,
        ...overrides,
    };
}

function forbidGlobalTraversal<Value>(
    values: readonly Value[],
): readonly Value[] {
    return new Proxy(values, {
        get(target, property, receiver) {
            if (
                property === Symbol.iterator || property === 'find' ||
                property === 'filter' || property === 'map' || property === 'some' ||
                property === 'forEach'
            ) {
                throw new Error('global collection traversal is forbidden');
            }
            return Reflect.get(target, property, receiver);
        },
    });
}

function reconcile(
    state: ReturnType<typeof createInitialMonitorWorkspaceState>,
    value: ControlQuerySnapshot<ControlServerSnapshot>,
) {
    return reconcileMonitorWorkspaceState(state, { context, query: value });
}

function artifact(
    distributedRunId = 'distributed-a',
    generatedAtEpochMs = 100,
): ControlDistributedRunArtifactBundle {
    const run = distributedRun(distributedRunId);
    return {
        artifactSchemaVersion: 1,
        distributedRunId,
        generatedAtEpochMs,
        files: {
            'distributed-run.json': JSON.stringify(run),
            'manifest.json': JSON.stringify(run.manifest),
            'control-run.json': JSON.stringify(controlRun()),
        },
    };
}

describe('Recipe Console Monitor selection', () => {
    it('does not traverse run options without a control selection and preserves last-known truth', () => {
        const distributedRuns = forbidGlobalTraversal([
            distributedRun('distributed-a', 'run-a'),
        ]);
        const lastKnown = distributedRun('last-known', 'run-last', 'passed', 40);

        expect(deriveMonitorRunOptions({
            controlRunId: undefined,
            distributedRuns,
        })).toEqual([]);
        expect(deriveMonitorRunOptions({
            controlRunId: undefined,
            distributedRuns,
            lastKnown,
        })).toEqual([lastKnown]);
    });

    it.each([
        {
            label: 'empty topology',
            stale: { runs: [], distributedRuns: [] } satisfies ControlServerSnapshot,
        },
        {
            label: 'same-length replacement topology',
            stale: {
                runs: [controlRun('old-run')],
                distributedRuns: [distributedRun('old-distributed', 'old-run')],
            } satisfies ControlServerSnapshot,
        },
    ])('falls back from $label for selection, options, and coherent state', ({ stale }) => {
        const current: ControlServerSnapshot = {
            runs: [controlRun('run-a')],
            distributedRuns: [distributedRun('distributed-a', 'run-a')],
        };
        const selectionIndex = createControlSnapshotSelectionIndex(stale);
        const selectionInput = {
            controlRunId: 'run-a',
            requestedDistributedRunId: 'distributed-a',
            distributedRuns: current.distributedRuns!,
            distributedRunsAuthoritative: true,
        } as const;
        const legacySelection = deriveMonitorDistributedRunSelection(selectionInput);
        const indexedSelection = deriveMonitorDistributedRunSelection({
            ...selectionInput,
            snapshot: current,
            selectionIndex,
        });
        const legacyOptions = deriveMonitorRunOptions({
            controlRunId: 'run-a',
            distributedRuns: current.distributedRuns!,
        });
        const indexedOptions = deriveMonitorRunOptions({
            controlRunId: 'run-a',
            distributedRuns: current.distributedRuns!,
            snapshot: current,
            selectionIndex,
        });
        const legacyState = reconcileMonitorWorkspaceState(
            createInitialMonitorWorkspaceState(),
            { context, query: query('live', current) },
        );
        const indexedState = reconcileMonitorWorkspaceState(
            createInitialMonitorWorkspaceState(),
            { context, query: query('live', current), selectionIndex },
        );

        expect(indexedSelection).toEqual(legacySelection);
        expect(indexedSelection.run).toBe(current.distributedRuns![0]);
        expect(monitorDistributedRunSelectionWorkForTest(indexedSelection))
            .toEqual({ indexed: false, fallback: true });
        expect(indexedOptions).toEqual(legacyOptions);
        expect(indexedOptions[0]).toBe(current.distributedRuns![0]);
        expect(monitorRunOptionsWorkForTest(indexedOptions))
            .toEqual({ indexed: false, fallback: true });
        expect(indexedState).toEqual(legacyState);
        expect(indexedState.source?.controlRun).toBe(current.runs[0]);
        expect(indexedState.source?.distributedRun).toBe(current.distributedRuns![0]);
        expect(monitorWorkspaceReconciliationWorkForTest(indexedState))
            .toEqual({ indexed: false, fallback: true });
    });

    it('keeps genuinely absent Monitor IDs unavailable without defensive fallback', () => {
        const current: ControlServerSnapshot = {
            runs: [controlRun('run-a')],
            distributedRuns: [distributedRun('distributed-a', 'run-a')],
        };
        const selectionIndex = bindControlSelectionIndexToSnapshot(
            current,
            createControlSnapshotSelectionIndex(current),
        );
        const selection = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            requestedDistributedRunId: 'missing-distributed',
            distributedRuns: current.distributedRuns!,
            distributedRunsAuthoritative: true,
            snapshot: current,
            selectionIndex,
        });

        expect(selection.run).toBeUndefined();
        expect(selection.issue?.code).toBe('unavailable');
        expect(monitorDistributedRunSelectionWorkForTest(selection))
            .toEqual({ indexed: true, fallback: false });
    });

    it('keeps trusted absent Monitor selection, options, and reconciliation O(1)', () => {
        const current: ControlServerSnapshot = {
            runs: [controlRun('run-a')],
            distributedRuns: [distributedRun('distributed-a', 'run-a')],
        };
        const selectionIndex = createControlSelectionIndexCache().get(current);
        Object.defineProperties(current, {
            runs: { value: forbidGlobalTraversal(current.runs) },
            distributedRuns: {
                value: forbidGlobalTraversal(current.distributedRuns!),
            },
        });

        const selection = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            requestedDistributedRunId: 'missing-distributed',
            distributedRuns: current.distributedRuns!,
            distributedRunsAuthoritative: true,
            snapshot: current,
            selectionIndex,
        });
        const options = deriveMonitorRunOptions({
            controlRunId: 'missing-run',
            distributedRuns: current.distributedRuns!,
            snapshot: current,
            selectionIndex,
        });
        const missingContext = createMonitorWorkspaceContext({
            baseUrl: 'https://control.test',
            controlRunId: 'missing-run',
            distributedRunId: 'missing-distributed',
        });
        const state = reconcileMonitorWorkspaceState(
            createInitialMonitorWorkspaceState(),
            {
                context: missingContext,
                query: query('live', current),
                selectionIndex,
            },
        );

        expect(selection.issue?.code).toBe('unavailable');
        expect(monitorDistributedRunSelectionWorkForTest(selection))
            .toEqual({ indexed: true, fallback: false });
        expect(options).toEqual([]);
        expect(monitorRunOptionsWorkForTest(options))
            .toEqual({ indexed: true, fallback: false });
        expect(state.source).toBeUndefined();
        expect(monitorWorkspaceReconciliationWorkForTest(state))
            .toEqual({ indexed: true, fallback: false });
    });

    it('uses indexed global-first explicit selection and rebinds the current poll object', () => {
        const first: ControlServerSnapshot = {
            runs: [controlRun('run-a'), controlRun('run-b')],
            distributedRuns: [
                distributedRun('duplicate\0\u202e', 'run-b'),
                distributedRun('duplicate\0\u202e', 'run-a'),
            ],
        };
        const clone = structuredClone(first);
        const current: ControlServerSnapshot = {
            ...clone,
            distributedRuns: forbidGlobalTraversal(clone.distributedRuns!),
        };
        const selectionIndex = bindControlSelectionIndexToSnapshot(
            current,
            createControlSnapshotSelectionIndex(first),
        );

        const indexed = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            requestedDistributedRunId: 'duplicate\0\u202e',
            distributedRuns: current.distributedRuns!,
            distributedRunsAuthoritative: true,
            snapshot: current,
            selectionIndex,
        });

        expect(indexed).toEqual({
            distributedRunId: 'duplicate\0\u202e',
            run: undefined,
            source: 'explicit',
            issue: {
                code: 'incompatible',
                message: 'Distributed run duplicate\0\u202e belongs to another control run.',
            },
        });
    });

    it('projects indexed compatible run options in legacy order with current objects', () => {
        const first: ControlServerSnapshot = {
            runs: [controlRun('run-a')],
            distributedRuns: [
                distributedRun('older', 'run-a', 'running', 10),
                distributedRun('other', 'run-b', 'running', 30),
                distributedRun('newer', 'run-a', 'running', 20),
            ],
        };
        const clone = structuredClone(first);
        const current: ControlServerSnapshot = {
            ...clone,
            distributedRuns: forbidGlobalTraversal(clone.distributedRuns!),
        };
        const selectionIndex = bindControlSelectionIndexToSnapshot(
            current,
            createControlSnapshotSelectionIndex(first),
        );

        const options = deriveMonitorRunOptions({
            controlRunId: 'run-a',
            distributedRuns: current.distributedRuns!,
            snapshot: current,
            selectionIndex,
        });

        expect(options).toEqual([
            current.distributedRuns![2],
            current.distributedRuns![0],
        ]);
        expect(options[0]).toBe(current.distributedRuns![2]);
    });

    it('canonicalizes only a sole compatible run and never chooses by collection order', () => {
        const sole = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            distributedRuns: [
                distributedRun('other', 'run-b'),
                distributedRun('sole', 'run-a'),
            ],
            distributedRunsAuthoritative: true,
        });
        const ambiguous = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            distributedRuns: [
                distributedRun('first', 'run-a'),
                distributedRun('second', 'run-a'),
            ],
            distributedRunsAuthoritative: true,
        });
        const none = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            distributedRuns: [distributedRun('other', 'run-b')],
            distributedRunsAuthoritative: true,
        });

        expect(sole).toMatchObject({
            distributedRunId: 'sole',
            source: 'sole-compatible',
            urlReplacePatch: { distributedRunId: 'sole' },
        });
        expect(ambiguous).toMatchObject({
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
            issue: { code: 'ambiguous' },
        });
        expect(none).toEqual({
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
        });
    });

    it('preserves explicit unavailable and incompatible IDs without fallback', () => {
        const unavailable = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            requestedDistributedRunId: 'missing',
            distributedRuns: [distributedRun('first', 'run-a')],
            distributedRunsAuthoritative: true,
        });
        const incompatible = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            requestedDistributedRunId: 'other',
            distributedRuns: [distributedRun('other', 'run-b')],
            distributedRunsAuthoritative: true,
        });
        const pending = deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            requestedDistributedRunId: 'missing',
            distributedRuns: [],
            distributedRunsAuthoritative: false,
        });

        expect(unavailable).toMatchObject({
            distributedRunId: 'missing',
            run: undefined,
            source: 'explicit',
            issue: { code: 'unavailable' },
        });
        expect(incompatible).toMatchObject({
            distributedRunId: 'other',
            run: undefined,
            source: 'explicit',
            issue: { code: 'incompatible' },
        });
        expect(pending.issue).toBeUndefined();
    });

    it('does not canonicalize a sole run from a non-authoritative collection', () => {
        expect(deriveMonitorDistributedRunSelection({
            controlRunId: 'run-a',
            distributedRuns: [distributedRun('sole', 'run-a')],
            distributedRunsAuthoritative: false,
        })).toEqual({
            distributedRunId: undefined,
            run: undefined,
            source: 'none',
        });
    });

    it('clears URL-backed evidence dependencies when the distributed run changes', () => {
        expect(recipeConsoleMonitorDistributedRunSelectionPatch('distributed-b'))
            .toEqual({
                distributedRunId: 'distributed-b',
                agentId: undefined,
                recipeId: undefined,
                commandId: undefined,
            });
        expect(context).toEqual({
            key: JSON.stringify({
                baseUrl: 'https://control.test/root',
                controlRunId: 'run-a',
                distributedRunId: 'distributed-a',
            }),
            baseUrl: 'https://control.test/root',
            controlRunId: 'run-a',
            distributedRunId: 'distributed-a',
        });
    });

    it('clears every Monitor evidence dependency when the control run changes', () => {
        expect(recipeConsoleMonitorControlRunSelectionPatch({
            state: {
                v: 1,
                experience: 'recipe-console',
                view: 'monitor',
                controlRunId: 'run-a',
                distributedRunId: 'distributed-a',
                agentId: 'agent-a',
                recipeId: 'recipe-a',
                commandId: 'command-a',
            },
            controlRunId: 'run-b',
            distributedRuns: [distributedRun('distributed-b', 'run-b')],
        })).toEqual({
            controlRunId: 'run-b',
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
    });

    it('restores the most specific shareable evidence selection from URL state', () => {
        const state = {
            v: 1 as const,
            experience: 'recipe-console' as const,
            view: 'monitor' as const,
            agentId: 'agent-a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
        };

        expect(deriveMonitorUrlEvidenceSelection(state)).toEqual({
            kind: 'command',
            id: 'command-a',
        });
        expect(deriveMonitorUrlEvidenceSelection({
            ...state,
            commandId: undefined,
        })).toEqual({ kind: 'recipe', id: 'recipe-a' });
        expect(deriveMonitorUrlEvidenceSelection({
            ...state,
            commandId: undefined,
            recipeId: undefined,
        })).toEqual({ kind: 'agent', id: 'agent-a' });
        expect(deriveMonitorUrlEvidenceSelection({
            ...state,
            commandId: undefined,
            recipeId: undefined,
            agentId: undefined,
        })).toBeUndefined();
        expect(monitorUrlEvidenceKey(state)).toBe(
            JSON.stringify(['agent-a', 'recipe-a', 'command-a']),
        );
    });

    it('keeps role-scoped recipe evidence collision-safe while URL IDs stay shareable', () => {
        const sender = createMonitorRecipeEvidenceSelectionId({
            recipeId: 'recipe-a',
            role: 'sender',
            profile: 'rtc',
        });
        const receiver = createMonitorRecipeEvidenceSelectionId({
            recipeId: 'recipe-a',
            role: 'receiver',
            profile: 'rtc',
        });

        expect(sender).not.toBe(receiver);
        expect(parseMonitorRecipeEvidenceSelectionId(sender)).toEqual({
            recipeId: 'recipe-a',
            role: 'sender',
            profile: 'rtc',
        });
        expect(parseMonitorRecipeEvidenceSelectionId('recipe-a')).toBeUndefined();
        expect(monitorEvidenceSelectionIdentifier({
            kind: 'recipe',
            id: sender,
        })).toBe('recipe-a · sender · rtc');
        const roleRows = [{
            recipeId: 'recipe-a', profile: 'rtc', role: 'sender', required: true,
            targetCount: 1, queuedCount: 0, runningCount: 0,
            passedCount: 1, failedCount: 0, missingCount: 0,
            averageLatencyMs: 10,
        }, {
            recipeId: 'recipe-a', profile: 'rtc', role: 'receiver', required: true,
            targetCount: 1, queuedCount: 0, runningCount: 0,
            passedCount: 0, failedCount: 1, missingCount: 0,
            averageLatencyMs: 20,
        }];
        expect(deriveMonitorRecipeEvidenceStatus(roleRows, 'recipe-a'))
            .toBe('failed');
        expect(deriveMonitorRecipeEvidenceStatus(roleRows, sender))
            .toBe('passed');
        expect(MONITOR_ARTIFACT_EVIDENCE_ID).toBe('artifact');
    });
});

describe('Recipe Console Monitor coherent state', () => {
    it('reconciles indexed query truth by first compatible pair and keeps current identities', () => {
        const first: ControlServerSnapshot = {
            runs: [controlRun('run-a'), controlRun('run-a')],
            distributedRuns: [
                distributedRun('distributed-a', 'run-b', 'failed', 30),
                distributedRun('distributed-a', 'run-a', 'running', 20),
                distributedRun('distributed-a', 'run-a', 'passed', 40),
            ],
        };
        const clone = structuredClone(first);
        const current: ControlServerSnapshot = {
            ...clone,
            runs: forbidGlobalTraversal(clone.runs),
            distributedRuns: forbidGlobalTraversal(clone.distributedRuns!),
        };
        const selectionIndex = bindControlSelectionIndexToSnapshot(
            current,
            createControlSnapshotSelectionIndex(first),
        );

        const state = reconcileMonitorWorkspaceState(
            createInitialMonitorWorkspaceState(),
            {
                context,
                query: query('live', current),
                selectionIndex,
            },
        );

        expect(state.source?.controlRun).toBe(current.runs[0]);
        expect(state.source?.distributedRun).toBe(current.distributedRuns![1]);
    });

    it('projects complete current truth and derives bounded monitor/report/verdict once', () => {
        const monitorDerivation = vi.spyOn(
            distributedRecipes,
            'deriveDistributedRunMonitor',
        );
        const reportDerivation = vi.spyOn(
            distributedRecipes,
            'deriveDistributedRunAnalysisReport',
        );
        const commands = Array.from({ length: 120 }, (_, index) => ({
            envelope: {
                kind: 'command' as const,
                protocolVersion: 1 as const,
                runId: 'run-a',
                agentId: 'agent-a',
                commandId: `unlinked-${index}`,
                command: { kind: 'health' as const },
            },
            queuedAtEpochMs: index,
            dispatchCount: 0,
        }));
        const run = { ...controlRun(), commands };
        const state = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [run], distributedRuns: [distributedRun()] },
        ));
        const model = deriveMonitorWorkspaceModel(state);

        expect(state.source).toMatchObject({
            freshness: 'current',
            completeness: 'complete',
            queryStatus: 'live',
            controlRun: { runId: 'run-a' },
            distributedRun: { distributedRunId: 'distributed-a' },
        });
        expect(model).toMatchObject({
            monitor: { distributedRunId: 'distributed-a' },
            report: {
                distributedRunId: 'distributed-a',
                summary: { snapshotMayBeTruncated: true },
            },
            verdict: { runId: 'distributed-a' },
        });
        expect(model?.report.summary.snapshotWarnings).toContain(
            'Loaded 120 commands; evidence may be truncated by the current snapshot bound.',
        );
        expect(monitorDerivation).toHaveBeenCalledOnce();
        expect(reportDerivation).toHaveBeenCalledOnce();
        expect(reportDerivation.mock.calls[0]?.[0].monitor).toBe(model?.monitor);
        expect(distributedRunMonitorDerivationWorkForTest(model!.report)).toMatchObject({
            monitorDerivationCount: 1,
            reportDerivationCount: 1,
            commandLinkVisitCount: 0,
            controlCommandVisitCount: 120,
            controlResultVisitCount: 0,
            controlEventVisitCount: 0,
        });
    });

    it.each(['stale', 'offline'] as const)(
        'retains a coherent pair as last-known on total %s failure',
        (status) => {
            const current = reconcile(createInitialMonitorWorkspaceState(), query(
                'live',
                { runs: [controlRun()], distributedRuns: [distributedRun()] },
            ));
            const failed = reconcile(current, query(status, undefined, {
                lastError: { kind: 'network', message: 'control unavailable' },
            }));

            expect(failed.source?.controlRun).toBe(current.source?.controlRun);
            expect(failed.source?.distributedRun).toBe(current.source?.distributedRun);
            expect(failed.source).toMatchObject({
                freshness: 'last-known',
                queryStatus: status,
            });
        },
    );

    it('retains the prior same-context pair for partial missing distributed evidence without mixing', () => {
        const oldControl = controlRun('run-a', 10);
        const oldDistributed = distributedRun('distributed-a', 'run-a', 'running', 10);
        const current = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [oldControl], distributedRuns: [oldDistributed] },
        ));
        const partial = reconcile(current, query('partial', {
            runs: [controlRun('run-a', 20)],
        }));
        const unrelated = reconcile(current, query('partial', {
            runs: [controlRun('run-b', 20)],
        }));

        expect(partial.source?.controlRun).toBe(oldControl);
        expect(partial.source?.distributedRun).toBe(oldDistributed);
        expect(partial.source).toMatchObject({
            freshness: 'last-known',
            completeness: 'partial',
        });
        expect(unrelated.source).toBeUndefined();
    });

    it('replaces with coherent partial truth, clears on complete omission, and recovers', () => {
        const initial = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [controlRun()], distributedRuns: [distributedRun()] },
        ));
        const partialRun = distributedRun('distributed-a', 'run-a', 'failed', 20);
        const partial = reconcile(initial, query('partial', {
            runs: [controlRun('run-a', 20)],
            distributedRuns: [partialRun],
        }));
        const deleted = reconcile(partial, query('live', {
            runs: [controlRun('run-a', 30)],
            distributedRuns: [],
        }));
        const recoveredRun = distributedRun('distributed-a', 'run-a', 'passed', 40);
        const recovered = reconcile(deleted, query('live', {
            runs: [controlRun('run-a', 40)],
            distributedRuns: [recoveredRun],
        }));

        expect(partial.source).toMatchObject({
            freshness: 'current',
            completeness: 'partial',
            distributedRun: { state: 'failed' },
        });
        expect(deleted.source).toBeUndefined();
        expect(recovered.source?.distributedRun).toBe(recoveredRun);
    });

    it('treats a present partial distributed collection as authoritative for omission', () => {
        const current = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [controlRun()], distributedRuns: [distributedRun()] },
        ));
        const omitted = reconcile(current, query('partial', {
            runs: [controlRun('run-a', 20)],
            distributedRuns: [],
        }));

        expect(omitted.source).toBeUndefined();
        expect(omitted.mutationRun).toBeUndefined();
    });

    it('retains newer mutation truth over older queries and clears every dependency on context change', () => {
        let state = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [controlRun()], distributedRuns: [distributedRun()] },
        ));
        state = setMonitorEvidenceSelection(state, context.key, {
            kind: 'failure',
            id: 'failure-a',
        });
        state = setMonitorCancelArm(state, context.key, 'cancel-arm-a');
        const pending = beginMonitorOperation(state, context.key, 'load-artifact');
        state = completeMonitorArtifactOperation(
            pending.state,
            pending.authority,
            artifact(),
        );
        state = projectMonitorMutation(
            state,
            context.key,
            distributedRun('distributed-a', 'run-a', 'cancelled', 30),
        );
        state = reconcile(state, query('live', {
            runs: [controlRun('run-a', 20)],
            distributedRuns: [
                distributedRun('distributed-a', 'run-a', 'running', 20),
            ],
        }));

        expect(state.source).toMatchObject({
            origin: 'mutation',
            distributedRun: { state: 'cancelled', updatedAtEpochMs: 30 },
        });
        expect(state.artifact.bundle?.distributedRunId).toBe('distributed-a');

        state = reconcile(state, query('live', {
            runs: [controlRun('run-a', 40)],
            distributedRuns: [
                distributedRun('distributed-a', 'run-a', 'passed', 40),
            ],
        }));
        expect(state.source).toMatchObject({
            origin: 'query',
            distributedRun: { state: 'passed', updatedAtEpochMs: 40 },
        });
        expect(state.mutationRun).toBeUndefined();

        const nextContext = createMonitorWorkspaceContext({
            baseUrl: 'https://control.test/root',
            controlRunId: 'run-a',
            distributedRunId: 'distributed-b',
        });
        const changed = reconcileMonitorWorkspaceState(state, {
            context: nextContext,
            query: query('connecting'),
        });

        expect(changed).toMatchObject({
            contextKey: nextContext.key,
            source: undefined,
            mutationRun: undefined,
            artifact: { status: 'idle', bundle: undefined, error: undefined },
            evidenceSelection: undefined,
            cancelArmKey: undefined,
            operationError: undefined,
            activeOperation: undefined,
        });
        expect(changed.operationGeneration).toBeGreaterThan(state.operationGeneration);
    });

    it('resolves equal-timestamp mutation/query ties without terminal regression', () => {
        const current = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [controlRun()], distributedRuns: [distributedRun()] },
        ));
        const nonTerminalMutation = projectMonitorMutation(
            current,
            context.key,
            distributedRun('distributed-a', 'run-a', 'running', 20),
        );
        const terminalQuery = reconcile(nonTerminalMutation, query('live', {
            runs: [controlRun('run-a', 20)],
            distributedRuns: [
                distributedRun('distributed-a', 'run-a', 'failed', 20),
            ],
        }));
        const terminalMutation = projectMonitorMutation(
            current,
            context.key,
            distributedRun('distributed-a', 'run-a', 'cancelled', 20),
        );
        const nonTerminalQuery = reconcile(terminalMutation, query('live', {
            runs: [controlRun('run-a', 20)],
            distributedRuns: [
                distributedRun('distributed-a', 'run-a', 'running', 20),
            ],
        }));

        expect(terminalQuery.source).toMatchObject({
            origin: 'query',
            distributedRun: { state: 'failed' },
        });
        expect(terminalQuery.mutationRun).toBeUndefined();
        expect(nonTerminalQuery.source).toMatchObject({
            origin: 'mutation',
            distributedRun: { state: 'cancelled' },
        });
    });

    it('keeps equal non-terminal mutation truth and the error-rich terminal tie', () => {
        const current = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [controlRun()], distributedRuns: [distributedRun()] },
        ));
        const nonTerminalMutation = projectMonitorMutation(
            current,
            context.key,
            distributedRun('distributed-a', 'run-a', 'ready', 20),
        );
        const nonTerminalTie = reconcile(nonTerminalMutation, query('live', {
            runs: [controlRun('run-a', 20)],
            distributedRuns: [
                distributedRun('distributed-a', 'run-a', 'running', 20),
            ],
        }));
        const terminalMutation = projectMonitorMutation(
            current,
            context.key,
            distributedRun('distributed-a', 'run-a', 'failed', 30),
        );
        const errorRichQueryRun = distributedRun(
            'distributed-a',
            'run-a',
            'failed',
            30,
            { error: { code: 'QUERY_FAILURE', message: 'Query has evidence.' } },
        );
        const errorRichQuery = reconcile(terminalMutation, query('live', {
            runs: [controlRun('run-a', 30)],
            distributedRuns: [errorRichQueryRun],
        }));
        const errorRichMutationRun = distributedRun(
            'distributed-a',
            'run-a',
            'failed',
            30,
            {
                error: {
                    code: 'MUTATION_FAILURE',
                    message: 'Mutation has evidence.',
                },
            },
        );
        const errorRichMutation = reconcile(
            projectMonitorMutation(
                current,
                context.key,
                errorRichMutationRun,
            ),
            query('live', {
                runs: [controlRun('run-a', 30)],
                distributedRuns: [
                    distributedRun('distributed-a', 'run-a', 'failed', 30),
                ],
            }),
        );
        const richCurrent = reconcile(current, query('live', {
            runs: [controlRun('run-a', 30)],
            distributedRuns: [errorRichQueryRun],
        }));
        const plainMutationAgainstRichQuery = projectMonitorMutation(
            richCurrent,
            context.key,
            distributedRun('distributed-a', 'run-a', 'failed', 30),
        );

        expect(nonTerminalTie.source).toMatchObject({
            origin: 'mutation',
            distributedRun: { state: 'ready' },
        });
        expect(errorRichQuery.source?.distributedRun).toBe(errorRichQueryRun);
        expect(errorRichQuery.source?.origin).toBe('query');
        expect(errorRichQuery.mutationRun).toBeUndefined();
        expect(errorRichMutation.source?.distributedRun)
            .toBe(errorRichMutationRun);
        expect(errorRichMutation.source?.origin).toBe('mutation');
        expect(plainMutationAgainstRichQuery).toBe(richCurrent);
    });
});

describe('Recipe Console Monitor artifact operation state', () => {
    function withCurrentArtifact() {
        let state = reconcile(createInitialMonitorWorkspaceState(), query(
            'live',
            { runs: [controlRun()], distributedRuns: [distributedRun()] },
        ));
        const loading = beginMonitorOperation(state, context.key, 'load-artifact');
        state = completeMonitorArtifactOperation(
            loading.state,
            loading.authority,
            artifact('distributed-a', 100),
        );
        return state;
    }

    it('retains a same-run prior bundle while pending and after failure', () => {
        const ready = withCurrentArtifact();
        const pending = beginMonitorOperation(ready, context.key, 'load-artifact');
        const provenance = Object.assign(new Error('artifact endpoint failed'), {
            status: 403,
            authorizationRequired: true,
        });
        const failed = failMonitorOperation(
            pending.state,
            pending.authority,
            provenance,
        );

        expect(pending.state.artifact).toMatchObject({
            status: 'pending',
            bundle: { generatedAtEpochMs: 100 },
        });
        expect(failed.artifact).toMatchObject({
            status: 'error',
            bundle: { generatedAtEpochMs: 100 },
            error: 'artifact endpoint failed',
        });
        expect(failed.operationError).toBe(provenance);
    });

    it('rejects artifact identity mismatches without replacing prior evidence', () => {
        const ready = withCurrentArtifact();
        const pending = beginMonitorOperation(ready, context.key, 'export-artifact');
        const mismatched = completeMonitorArtifactOperation(
            pending.state,
            pending.authority,
            artifact('distributed-other', 200),
        );

        expect(mismatched.artifact).toMatchObject({
            status: 'error',
            bundle: { distributedRunId: 'distributed-a', generatedAtEpochMs: 100 },
        });
        expect(mismatched.artifact.error).toContain('different distributed run');
    });

    it('uses context-bound generations to ignore abort-resistant late responses', () => {
        const state = withCurrentArtifact();
        const first = beginMonitorOperation(
            state,
            context.key,
            'load-artifact',
            50,
        );
        const second = beginMonitorOperation(first.state, context.key, 'export-artifact');
        const afterLateFailure = failMonitorOperation(
            second.state,
            first.authority,
            new Error('late failure'),
        );
        const afterLateSuccess = completeMonitorArtifactOperation(
            second.state,
            first.authority,
            artifact('distributed-a', 999),
        );

        expect(first.authority.generation).toBe(50);
        expect(second.authority.generation).toBe(51);
        expect(afterLateFailure).toBe(second.state);
        expect(afterLateSuccess).toBe(second.state);

        const nextContext = createMonitorWorkspaceContext({
            baseUrl: 'https://control.test/root',
            controlRunId: 'run-a',
            distributedRunId: 'distributed-b',
        });
        const changed = reconcileMonitorWorkspaceState(second.state, {
            context: nextContext,
            query: query('connecting'),
        });
        expect(completeMonitorArtifactOperation(
            changed,
            second.authority,
            artifact('distributed-a', 999),
        )).toBe(changed);
    });
});
