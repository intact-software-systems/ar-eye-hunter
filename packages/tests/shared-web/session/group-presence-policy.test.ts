import {
    describe,
    expect,
    it
} from 'vitest';

import { cloneRallarRuntimeDefaults } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { captureGroupPresencePolicy } from '@shared-web/browser/session/group-presence-policy.ts';

const shortPresence = { leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 };

describe('opt-in group presence policy', () => {
    it('preserves the default selection when no policy is supplied', () => {
        expect(captureGroupPresencePolicy(undefined)).toBeUndefined();
        expect(cloneRallarRuntimeDefaults({})).toEqual({});
    });

    it('captures immutable timing through facade defaults without retaining caller-owned objects', () => {
        const supplied = { ...shortPresence };
        const captured = cloneRallarRuntimeDefaults({ groupPresence: supplied });
        supplied.leaseMs = 120_000;
        expect(captured.groupPresence).toEqual(shortPresence);
        expect(Object.isFrozen(captured.groupPresence)).toBe(true);
    });

    for (const field of ['leaseMs', 'renewalIntervalMs', 'requestTimeoutMs', 'retryMs'] as const) {
        it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648, Number.MAX_SAFE_INTEGER])(`rejects invalid ${field} %s`, (value) => {
            expect(() => captureGroupPresencePolicy({ ...shortPresence, [field]: value })).toThrow(TypeError);
        });
    }

    it.each([5_500, 7_000, 7_500])('rejects lease %s that cannot accommodate completion, renewal and retry work', (leaseMs) => {
        expect(() => captureGroupPresencePolicy({ ...shortPresence, leaseMs })).toThrow(RangeError);
    });
});
