import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    rebindControlRunFromSelectionIndex,
    rebindDistributedRunFromSelectionIndex,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import { rememberControlResponseDocument } from
    '../../../apps/rallar-black-box/src/control-response-document.ts';
import {
    createControlSelectionIndexCache,
    controlSelectionIndexCacheWorkForTest,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-selection-index-cache.ts';
import { createControlSnapshotRevisionSession } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-snapshot-revision.ts';
import { isControlSelectionIndexBoundToSnapshot } from
    '../../../apps/rallar-black-box/src/control-selection-index-binding.ts';

const SCALE = 5_000;

describe('Recipe Console control selection index cache', () => {
    it('reuses one index for an exact tagged revision and rebinds current-poll objects', () => {
        const first = snapshot('first', SCALE);
        const second = structuredClone(first);
        const raw = JSON.stringify(first);
        const revisions = createControlSnapshotRevisionSession();
        rememberControlResponseDocument(first, raw);
        rememberControlResponseDocument(second, raw);
        revisions.associate(first, {
            source: 'root-snapshot',
            rootDocument: first,
        });
        revisions.associate(second, {
            source: 'root-snapshot',
            rootDocument: second,
        });
        const cache = createControlSelectionIndexCache();

        const firstIndex = cache.get(first);
        expect(isControlSelectionIndexBoundToSnapshot(first, firstIndex)).toBe(true);
        expect(controlSelectionIndexCacheWorkForTest(cache)).toMatchObject({
            lookupCount: 1,
            hitCount: 0,
            missCount: 1,
            indexBuildCount: 1,
            lastLookup: {
                cacheHit: false,
                indexBuildCount: 1,
                controlRunVisitCount: SCALE,
                distributedRunVisitCount: SCALE,
                selectionIndexLoopVisitCount: SCALE * 8,
            },
        });

        const secondIndex = cache.get(second);
        expect(secondIndex).toBe(firstIndex);
        expect(isControlSelectionIndexBoundToSnapshot(second, secondIndex)).toBe(true);
        expect(controlSelectionIndexCacheWorkForTest(cache)).toEqual({
            lookupCount: 2,
            hitCount: 1,
            missCount: 1,
            indexBuildCount: 1,
            lastLookup: {
                cacheHit: true,
                indexBuildCount: 0,
                controlRunVisitCount: 0,
                distributedRunVisitCount: 0,
                selectionIndexLoopVisitCount: 0,
            },
        });
        const lateOrdinal = SCALE - 1;
        expect(rebindControlRunFromSelectionIndex(
            secondIndex,
            second,
            `control-first-${lateOrdinal}`,
        )).toBe(second.runs[lateOrdinal]);
        expect(rebindDistributedRunFromSelectionIndex(
            secondIndex,
            second,
            `distributed-first-${lateOrdinal}`,
        )).toBe(second.distributedRuns![lateOrdinal]);
        expect(rebindControlRunFromSelectionIndex(
            secondIndex,
            second,
            `control-first-${lateOrdinal}`,
        )).not.toBe(first.runs[lateOrdinal]);
    });

    it('uses untagged object identity and keeps only one entry across A to B to A', () => {
        const first = snapshot('same');
        const second = structuredClone(first);
        const cache = createControlSelectionIndexCache();

        const firstIndex = cache.get(first);
        expect(cache.get(first)).toBe(firstIndex);
        const secondIndex = cache.get(second);
        expect(secondIndex).not.toBe(firstIndex);
        expect(cache.get(first)).not.toBe(firstIndex);
        expect(controlSelectionIndexCacheWorkForTest(cache)).toMatchObject({
            lookupCount: 4,
            hitCount: 1,
            missCount: 3,
            indexBuildCount: 3,
        });
    });

    it('invalidates a tagged poll when exact raw content changes without ID or length drift', () => {
        const first = snapshot('changed');
        const second = structuredClone(first);
        second.runs[1] = {
            ...second.runs[1]!,
            agents: [{
                ...second.runs[1]!.agents[0]!,
                status: 'changed-with-same-identities-and-timestamps',
            }],
        };
        const revisions = createControlSnapshotRevisionSession();
        rememberControlResponseDocument(first, JSON.stringify(first));
        rememberControlResponseDocument(second, JSON.stringify(second));
        revisions.associate(first, {
            source: 'root-snapshot',
            rootDocument: first,
        });
        revisions.associate(second, {
            source: 'root-snapshot',
            rootDocument: second,
        });
        const cache = createControlSelectionIndexCache();

        const firstIndex = cache.get(first);
        const secondIndex = cache.get(second);
        const firstAgainIndex = cache.get(first);

        expect(secondIndex).not.toBe(firstIndex);
        expect(firstAgainIndex).not.toBe(firstIndex);
        expect(firstAgainIndex).not.toBe(secondIndex);
        expect(controlSelectionIndexCacheWorkForTest(cache)).toMatchObject({
            lookupCount: 3,
            hitCount: 0,
            missCount: 3,
            indexBuildCount: 3,
        });
    });
});

function snapshot(suffix: string, size = 2): MutableSnapshot {
    const runs = Array.from({ length: size }, (_, ordinal) =>
        controlRun(`control-${suffix}-${ordinal}`, ordinal));
    const distributedRuns = Array.from({ length: size }, (_, ordinal) =>
        distributedRun(
            `distributed-${suffix}-${ordinal}`,
            runs[ordinal]!.runId,
            ordinal,
        ));
    return { runs, distributedRuns };
}

type MutableSnapshot = {
    runs: ControlRunSnapshot[];
    distributedRuns: ControlDistributedRunSnapshot[];
};

function controlRun(runId: string, updatedAtEpochMs: number): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        agents: [{
            runId,
            agentId: `agent-${runId}`,
            connected: true,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: 0,
            receivedEventCount: 0,
            completedCommandIds: [],
            resumeCompletedCommandIds: [],
        }],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    updatedAtEpochMs: number,
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        manifest: {
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'test',
                workspaceId: 'test',
                groupId: 'test',
            },
            recipes: [],
            targetPolicy: { mode: 'selected-agents', agentIds: [] },
        },
        state: 'running',
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        targetAgentIds: [],
        commandLinks: [],
        rollup: {
            state: 'running',
            ok: false,
            summary: {
                participants: 0,
                requiredParticipants: 0,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: 0,
                recipes: 0,
                requiredRecipes: 0,
                passedRecipes: 0,
                failedRecipes: 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 0,
            },
            failures: [],
        },
    };
}
