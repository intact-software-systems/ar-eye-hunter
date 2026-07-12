import { describe, expect, it } from 'vitest';
import {
    beginAnalyzeWorkspaceOperation,
    clearAnalyzeWorkspaceArtifact,
    completeAnalyzeWorkspaceOperation,
    createAnalyzeWorkspaceContext,
    createInitialAnalyzeWorkspaceState,
    failAnalyzeWorkspaceOperation,
    reconcileAnalyzeWorkspaceContext,
    selectAnalyzeWorkspaceEvidence,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-workspace-state.ts';

type TestArtifact = Readonly<{
    distributedRunId: string;
    controlRunId?: string;
    label: string;
}>;

const contextA = createAnalyzeWorkspaceContext({
    baseUrl: 'https://control.test/root///',
    controlRunId: 'control-a',
    distributedRunId: 'distributed-a',
});
const contextB = createAnalyzeWorkspaceContext({
    baseUrl: 'https://control.test/root',
    controlRunId: 'control-b',
    distributedRunId: 'distributed-b',
});

function artifact(
    distributedRunId: string,
    label = distributedRunId,
    controlRunId?: string,
): TestArtifact {
    return { distributedRunId, label, ...(controlRunId ? { controlRunId } : {}) };
}

describe('Recipe Console Analyze workspace state', () => {
    it('normalizes control context and completes a local import atomically', () => {
        const initial = reconcileAnalyzeWorkspaceContext(
            createInitialAnalyzeWorkspaceState<TestArtifact>(),
            contextA,
        );
        const started = beginAnalyzeWorkspaceOperation(initial, {
            action: 'import-local',
            contextKey: 'local-import',
        });
        const completed = completeAnalyzeWorkspaceOperation(
            started.state,
            started.authority,
            {
                artifact: artifact('distributed-local'),
                selectedEvidenceId: 'failure:first',
            },
        );

        expect(contextA).toEqual({
            key: JSON.stringify({
                baseUrl: 'https://control.test/root',
                controlRunId: 'control-a',
                distributedRunId: 'distributed-a',
            }),
            baseUrl: 'https://control.test/root',
            controlRunId: 'control-a',
            distributedRunId: 'distributed-a',
        });
        expect(started.state).toMatchObject({
            activeOperation: started.authority,
            operationGeneration: 1,
        });
        expect(completed).toMatchObject({
            artifact: artifact('distributed-local'),
            artifactStatus: 'ready',
            selectedEvidenceId: 'failure:first',
            activeOperation: undefined,
            operationError: undefined,
        });
    });

    it('retains the last usable artifact when a replacement import fails', () => {
        const initial = {
            ...createInitialAnalyzeWorkspaceState<TestArtifact>(),
            artifact: artifact('distributed-good'),
            artifactStatus: 'ready' as const,
            selectedEvidenceId: 'event:good',
        };
        const started = beginAnalyzeWorkspaceOperation(initial, {
            action: 'import-local',
            contextKey: 'local-import',
        });
        const error = new Error('events.jsonl line 4 is malformed.');
        const failed = failAnalyzeWorkspaceOperation(
            started.state,
            started.authority,
            error,
        );

        expect(failed).toMatchObject({
            artifact: artifact('distributed-good'),
            artifactStatus: 'error',
            selectedEvidenceId: 'event:good',
            activeOperation: undefined,
            operationError: error,
        });
    });

    it('invalidates a control load when context changes and ignores its late result', () => {
        const previous = {
            ...reconcileAnalyzeWorkspaceContext(
                createInitialAnalyzeWorkspaceState<TestArtifact>(),
                contextA,
            ),
            artifact: artifact('distributed-local'),
            artifactStatus: 'ready' as const,
        };
        const started = beginAnalyzeWorkspaceOperation(previous, {
            action: 'load-control',
            contextKey: contextA.key,
            expectedDistributedRunId: 'distributed-a',
        });
        const changed = reconcileAnalyzeWorkspaceContext(
            started.state,
            contextB,
        );
        const late = completeAnalyzeWorkspaceOperation(
            changed,
            started.authority,
            { artifact: artifact('distributed-a') },
        );

        expect(changed.contextKey).toBe(contextB.key);
        expect(changed.activeOperation).toBeUndefined();
        expect(changed.operationGeneration).toBeGreaterThan(
            started.authority.generation,
        );
        expect(changed.artifact).toEqual(artifact('distributed-local'));
        expect(changed.operationError).toMatchObject({ name: 'AbortError' });
        expect(late).toBe(changed);
    });

    it('rejects an artifact response for another distributed run', () => {
        const initial = reconcileAnalyzeWorkspaceContext(
            createInitialAnalyzeWorkspaceState<TestArtifact>(),
            contextA,
        );
        const started = beginAnalyzeWorkspaceOperation(initial, {
            action: 'load-control',
            contextKey: contextA.key,
            expectedDistributedRunId: 'distributed-a',
        });
        const completed = completeAnalyzeWorkspaceOperation(
            started.state,
            started.authority,
            { artifact: artifact('distributed-other') },
        );

        expect(completed.artifact).toBeUndefined();
        expect(completed.artifactStatus).toBe('error');
        expect(completed.activeOperation).toBeUndefined();
        expect(completed.operationError).toMatchObject({
            message: 'Artifact response belongs to distributed-other, not distributed-a.',
        });
    });

    it('retains but marks loaded evidence stale when the selected context changes', () => {
        const loaded = {
            ...reconcileAnalyzeWorkspaceContext(
                createInitialAnalyzeWorkspaceState<TestArtifact>(),
                contextA,
            ),
            artifact: artifact('distributed-a', 'Run A', 'control-a'),
            artifactStatus: 'ready' as const,
        };

        const changed = reconcileAnalyzeWorkspaceContext(loaded, contextB);
        expect(changed).toMatchObject({
            contextKey: contextB.key,
            artifact: loaded.artifact,
            artifactStatus: 'error',
            operationError: {
                message: expect.stringMatching(/distributed-a.*distributed-b/),
            },
        });

        const returned = reconcileAnalyzeWorkspaceContext(changed, contextA);
        expect(returned).toMatchObject({
            artifact: loaded.artifact,
            artifactStatus: 'ready',
            operationError: undefined,
        });

        const clearedSelection = reconcileAnalyzeWorkspaceContext(loaded, undefined);
        expect(clearedSelection.artifact).toBe(loaded.artifact);
        expect(clearedSelection.artifactStatus).toBe('error');
        expect(clearedSelection.operationError).toMatchObject({
            message: expect.stringContaining('no distributed run is selected'),
        });
    });

    it('rejects a matching distributed artifact owned by another control run', () => {
        const initial = reconcileAnalyzeWorkspaceContext(
            createInitialAnalyzeWorkspaceState<TestArtifact>(),
            contextA,
        );
        const started = beginAnalyzeWorkspaceOperation(initial, {
            action: 'load-control',
            contextKey: contextA.key,
            expectedControlRunId: 'control-a',
            expectedDistributedRunId: 'distributed-a',
        });
        const completed = completeAnalyzeWorkspaceOperation(
            started.state,
            started.authority,
            { artifact: artifact('distributed-a', 'Wrong owner', 'control-b') },
        );

        expect(completed.artifact).toBeUndefined();
        expect(completed.artifactStatus).toBe('error');
        expect(completed.operationError).toMatchObject({
            message: 'Artifact response belongs to control run control-b, not control-a.',
        });
    });

    it('uses monotonic authority and lets clear invalidate pending work', () => {
        const initial = createInitialAnalyzeWorkspaceState<TestArtifact>();
        const first = beginAnalyzeWorkspaceOperation(initial, {
            action: 'import-local',
            contextKey: 'local-import',
        }, 7);
        const cleared = clearAnalyzeWorkspaceArtifact(first.state);
        const second = beginAnalyzeWorkspaceOperation(cleared, {
            action: 'import-local',
            contextKey: 'local-import',
        }, 2);
        const late = completeAnalyzeWorkspaceOperation(
            second.state,
            first.authority,
            { artifact: artifact('late') },
        );

        expect(first.authority.generation).toBe(7);
        expect(cleared.operationGeneration).toBe(8);
        expect(second.authority.generation).toBe(9);
        expect(late).toBe(second.state);
    });

    it('updates evidence selection without changing the loaded artifact', () => {
        const state = {
            ...createInitialAnalyzeWorkspaceState<TestArtifact>(),
            artifact: artifact('distributed-a'),
            artifactStatus: 'ready' as const,
        };
        const selected = selectAnalyzeWorkspaceEvidence(state, 'result:command-a');

        expect(selected.artifact).toBe(state.artifact);
        expect(selected.selectedEvidenceId).toBe('result:command-a');
        expect(selectAnalyzeWorkspaceEvidence(selected, undefined)
            .selectedEvidenceId).toBeUndefined();
    });
});
