import { describe, expect, it } from 'vitest';

import { resolveTopologyReplanWindow } from '@shared-server/rallar-system/topology/planning/resolve-topology-replan-window.ts';
import { resolveGroupLifecyclePolicyPreset } from '@shared/api/group-lifecycle/group-lifecycle-policy-presets.ts';

const SERVER_DEBOUNCE_MS = 250;

describe('resolveTopologyReplanWindow', () => {
    it('gives a debounced group the policy window and its maximum wait', () => {
        const managed = resolveGroupLifecyclePolicyPreset('managed');
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: managed },
            serverDebounceMs: SERVER_DEBOUNCE_MS
        })).toEqual({ debounceMs: managed.topology.debounceWindowMs, maxWaitMs: managed.topology.maxReplanWaitMs });
    });

    it('leaves an auto group on the server window while bounding its extension', () => {
        const optimistic = resolveGroupLifecyclePolicyPreset('optimistic');
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: optimistic },
            serverDebounceMs: SERVER_DEBOUNCE_MS
        })).toEqual({ debounceMs: SERVER_DEBOUNCE_MS, maxWaitMs: optimistic.topology.maxReplanWaitMs });
        expect(resolveTopologyReplanWindow({ lifecyclePolicy: { status: 'absent' }, serverDebounceMs: SERVER_DEBOUNCE_MS }))
            .toEqual({ debounceMs: SERVER_DEBOUNCE_MS, maxWaitMs: optimistic.topology.maxReplanWaitMs });
    });

    it('coalesces a commanded group\'s follow-ups under the policy window', () => {
        const match = resolveGroupLifecyclePolicyPreset('match');
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'present', policy: match },
            serverDebounceMs: SERVER_DEBOUNCE_MS
        })).toEqual({ debounceMs: match.topology.debounceWindowMs, maxWaitMs: match.topology.maxReplanWaitMs });
    });

    it('keeps the server window unbounded outside the policy and under a corrupt policy', () => {
        const unbounded = { debounceMs: SERVER_DEBOUNCE_MS, maxWaitMs: null };
        expect(resolveTopologyReplanWindow({ lifecyclePolicy: null, serverDebounceMs: SERVER_DEBOUNCE_MS })).toEqual(unbounded);
        expect(resolveTopologyReplanWindow({
            lifecyclePolicy: { status: 'corrupt', reason: 'bad row' },
            serverDebounceMs: SERVER_DEBOUNCE_MS
        })).toEqual(unbounded);
    });
});
