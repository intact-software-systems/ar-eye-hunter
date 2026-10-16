import { describe, expect, it } from 'vitest';

import { resolveTopologyReplanWindow } from '@shared-server/rallar-system/topology/planning/resolve-topology-replan-window.ts';
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
