import { describe, expect, it } from 'vitest';

import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { decodeBackoffGateState } from '@shared/encoding/decode-backoff-gate-state.ts';
import type { BackoffGateState } from '@shared/resilience/backoff-gate.ts';

const HELD: BackoffGateState = { lastPassAtEpochMs: 10_000, consecutiveHeldPasses: 2, heldAtEpochMs: 13_000 };

describe('decodeBackoffGateState', () => {
    it('round-trips a held gate and one that never passed', () => {
        const fresh: BackoffGateState = { lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: null };

        expect(decodeBackoffGateState({ ...HELD }).right).toEqual(HELD);
        expect(decodeBackoffGateState({ ...fresh }).right).toEqual(fresh);
    });

    it.each<[string, ApiJsonValue]>([
        ['an unknown key', { ...HELD, extra: 1 }],
        ['a missing key', { lastPassAtEpochMs: 0, consecutiveHeldPasses: 0 }],
        ['a value that is no object', 'gate'],
        ['an array', [{ ...HELD }]]
    ])('refuses %s as no exact object', (_label, value) => {
        expect(decodeBackoffGateState(value).left).toBe('Backoff gate state must be an exact object with its own fields');
    });

    it.each<[string, ApiJsonValue]>([
        ['a negative count', { ...HELD, consecutiveHeldPasses: -1 }],
        ['a null count', { ...HELD, consecutiveHeldPasses: null }],
        ['a fractional instant', { ...HELD, lastPassAtEpochMs: 1.5 }],
        ['a string instant', { ...HELD, heldAtEpochMs: '13000' }]
    ])('refuses %s', (_label, value) => {
        expect(decodeBackoffGateState(value).left).toBe(
            'Backoff gate state fields must be non-negative integers, the instants or null'
        );
    });

    it('refuses a hold without a previous pass', () => {
        expect(decodeBackoffGateState({ lastPassAtEpochMs: null, consecutiveHeldPasses: 0, heldAtEpochMs: 3_000 }).left)
            .toBe('Backoff gate state heldAtEpochMs must be null before the first pass');
    });
});
