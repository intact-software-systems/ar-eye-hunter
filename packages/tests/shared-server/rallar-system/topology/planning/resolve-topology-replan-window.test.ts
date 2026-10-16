import { describe, expect, it } from 'vitest';

import {
    resolveTopologyExpectedMemberCount,
    resolveTopologyReplanWindow
} from '@shared-server/rallar-system/topology/planning/resolve-topology-replan-window.ts';
import { createDefaultGroupLifecyclePolicy } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

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
});

describe('resolveTopologyExpectedMemberCount', () => {
    function createPolicyUntil(untilMemberCount: number | null) {
        const policy = createDefaultGroupLifecyclePolicy();
        return { ...policy, admission: { ...policy.admission, untilMemberCount } };
    }

    it('expects the group\'s capacity when no policy was read', () => {
        expect(resolveTopologyExpectedMemberCount({ maxMembers: 50 }, null)).toBe(50);
    });

    it('expects whichever of the capacity and the admission limit closes first', () => {
        expect(resolveTopologyExpectedMemberCount(
            { maxMembers: 50 },
            { status: 'present', policy: createPolicyUntil(30) }
        )).toBe(30);
        expect(resolveTopologyExpectedMemberCount(
            { maxMembers: 20 },
            { status: 'present', policy: createPolicyUntil(30) }
        )).toBe(20);
        expect(resolveTopologyExpectedMemberCount(
            { maxMembers: null },
            { status: 'present', policy: createPolicyUntil(30) }
        )).toBe(30);
    });

    it('expects no count from an unbounded group, an absent policy or an unreadable one', () => {
        expect(resolveTopologyExpectedMemberCount({ maxMembers: null }, null)).toBeNull();
        expect(resolveTopologyExpectedMemberCount({ maxMembers: null }, { status: 'absent' })).toBeNull();
        expect(resolveTopologyExpectedMemberCount({ maxMembers: null }, { status: 'corrupt', reason: 'not json' }))
            .toBeNull();
    });
});
