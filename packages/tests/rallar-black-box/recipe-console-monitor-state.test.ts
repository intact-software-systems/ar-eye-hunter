import { describe, expect, it } from 'vitest';
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
    setMonitorCancelArm,
    setMonitorEvidenceSelection,
} from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-state.ts';
import { deriveMonitorWorkspaceModel } from '../../../apps/rallar-black-box/src/recipe-console/monitor/monitor-workspace-model.ts';
import {
    createMonitorRecipeEvidenceSelectionId,
    deriveMonitorRecipeEvidenceStatus,
    deriveMonitorDistributedRunSelection,
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
    it('projects complete current truth and derives bounded monitor/report/verdict once', () => {
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
