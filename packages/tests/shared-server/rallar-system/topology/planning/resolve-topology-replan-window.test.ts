import { describe, expect, it } from 'vitest';

import {
    resolveTopologyReplanWindow,
    type TopologyReplanWindow
} from '@shared-server/rallar-system/topology/planning/resolve-topology-replan-window.ts';
import { computeTopologyReplanDueAt } from '@shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-group-revision-work.ts';
import {
    createDefaultGroupLifecyclePolicy,
    resolveGroupLifecyclePolicyPreset
} from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

const SERVER_DEBOUNCE_MS = 250;
const SERVER_MAX_WAIT_MS = 1_750;

/** Window values no preset carries, so a policy read is told apart from the server window. */
function createPolicyWith(replanning: 'auto' | 'debounced' | 'commanded') {
    const policy = createDefaultGroupLifecyclePolicy();
    return {
        ...policy,
        topology: { ...policy.topology, replanning, debounceWindowMs: 3_000, maxReplanWaitMs: 4_000 }
    };
}

describe('resolveTopologyReplanWindow', () => {
    it('gives a debounced policy its own window and maximum wait', () => {
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: createPolicyWith('debounced') },
            serverDebounceMs: SERVER_DEBOUNCE_MS,
            serverMaxWaitMs: SERVER_MAX_WAIT_MS
        })).toEqual({ debounceMs: 3_000, maxWaitMs: 4_000 });
    });

    it('keeps the server window, bounded by the server maximum wait, for an auto policy', () => {
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: createPolicyWith('auto') },
            serverDebounceMs: SERVER_DEBOUNCE_MS,
            serverMaxWaitMs: SERVER_MAX_WAIT_MS
        })).toEqual({ debounceMs: SERVER_DEBOUNCE_MS, maxWaitMs: SERVER_MAX_WAIT_MS });
    });

    it('coalesces commanded follow-ups under the policy window', () => {
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: createPolicyWith('commanded') },
            serverDebounceMs: SERVER_DEBOUNCE_MS,
            serverMaxWaitMs: SERVER_MAX_WAIT_MS
        })).toEqual({ debounceMs: 3_000, maxWaitMs: 4_000 });
    });

    it('follows the default preset when no policy is stored', () => {
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'absent' },
            serverDebounceMs: SERVER_DEBOUNCE_MS,
            serverMaxWaitMs: SERVER_MAX_WAIT_MS
        })).toEqual({ debounceMs: SERVER_DEBOUNCE_MS, maxWaitMs: SERVER_MAX_WAIT_MS });
    });

    it('keeps the bounded server window when the stored policy is unreadable', () => {
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'corrupt', reason: 'not json' },
            serverDebounceMs: SERVER_DEBOUNCE_MS,
            serverMaxWaitMs: SERVER_MAX_WAIT_MS
        })).toEqual({ debounceMs: SERVER_DEBOUNCE_MS, maxWaitMs: SERVER_MAX_WAIT_MS });
    });

    it('lets an auto policy\'s replan fall due within the maximum wait of each burst under a revision every 300 ms', () => {
        const window = resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: resolveGroupLifecyclePolicyPreset('optimistic') },
            serverDebounceMs: 500,
            serverMaxWaitMs: 2_000
        });

        const runs = simulateReplanRuns(window, { revisionIntervalMs: 300, durationMs: 10_000 });

        // Unbounded, each revision moves the due time 500 ms past the next one and nothing ever runs.
        expect(runs.length).toBeGreaterThanOrEqual(4);
        for (const run of runs) {
            expect(run.ranAtEpochMs - run.firstPendingAtEpochMs).toBeLessThanOrEqual(2_000 + 300);
        }
    });
});

interface ReplanRun {
    readonly firstPendingAtEpochMs: number;
    readonly ranAtEpochMs: number;
}

interface PendingReplan {
    readonly windowOpenedAtEpochMs: number;
    readonly dueAtEpochMs: number;
}

interface ReplanStream {
    readonly revisionIntervalMs: number;
    readonly durationMs: number;
}

/**
 * Each outbox pass first merges the new revision into the pending replan (the NEW lane drains the
 * presence summaries), then claims the replan only if it is due (the RETRY lane), as on the hosted run.
 */
function simulateReplanRuns(window: TopologyReplanWindow, stream: ReplanStream): readonly ReplanRun[] {
    const runs: ReplanRun[] = [];
    let pending: PendingReplan | null = null;
    for (let nowEpochMs = 0; nowEpochMs <= stream.durationMs; nowEpochMs += stream.revisionIntervalMs) {
        const merged: PendingReplan = {
            windowOpenedAtEpochMs: pending === null ? nowEpochMs : pending.windowOpenedAtEpochMs,
            dueAtEpochMs: computeTopologyReplanDueAt({
                requestedAtEpochMs: nowEpochMs,
                previous: pending,
                timing: { window, replanNotBeforeEpochMs: null }
            })
        };
        if (merged.dueAtEpochMs <= nowEpochMs) {
            runs.push({ firstPendingAtEpochMs: merged.windowOpenedAtEpochMs, ranAtEpochMs: nowEpochMs });
            pending = null;
        }
        else {
            pending = merged;
        }
    }
    return runs;
}
