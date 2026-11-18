import {
    decodeSeededTransportFaultAction
} from '@shared/transport-faults/seeded-transport-fault-action.ts';
import { describe, expect, it } from 'vitest';

describe('a seeded fault action read from a command', () => {
    it('reads a loss and a jitter as they were named', () => {
        expect(decodeSeededTransportFaultAction({ loss: { ratio: 0.1, seed: 7 } }).right)
            .toEqual({ loss: { ratio: 0.1, seed: 7 } });
        expect(decodeSeededTransportFaultAction({ jitter: { minDelayMs: 0, maxDelayMs: 80, seed: 3 } }).right)
            .toEqual({ jitter: { minDelayMs: 0, maxDelayMs: 80, seed: 3 } });
    });

    it.each(['drop', { delayMs: 20 }, { rewrite: 'strip-proof' }, undefined])(
        'leaves %j to its own reader',
        (action) => {
            expect(decodeSeededTransportFaultAction(action).right).toBeNull();
        }
    );

    it.each([
        ['a ratio of zero', { loss: { ratio: 0, seed: 1 } }, 'loss.ratio'],
        ['a ratio above one', { loss: { ratio: 1.5, seed: 1 } }, 'loss.ratio'],
        ['a loss with no seed', { loss: { ratio: 0.5 } }, 'loss.seed'],
        ['a seed that is no integer', { loss: { ratio: 0.5, seed: 1.5 } }, 'loss.seed'],
        ['a loss field nothing reads', { loss: { ratio: 0.5, seed: 1, burst: 3 } }, 'loss.burst'],
        ['a loss that is no object', { loss: 0.5 }, 'loss must be an object'],
        ['a negative minimum delay', { jitter: { minDelayMs: -1, maxDelayMs: 5, seed: 1 } }, 'jitter.minDelayMs'],
        ['a maximum below the minimum', { jitter: { minDelayMs: 9, maxDelayMs: 5, seed: 1 } }, 'jitter.maxDelayMs'],
        ['a fractional delay', { jitter: { minDelayMs: 0.5, maxDelayMs: 5, seed: 1 } }, 'jitter.minDelayMs'],
        ['a jitter with no maximum', { jitter: { minDelayMs: 1, seed: 1 } }, 'jitter.maxDelayMs'],
        ['a loss beside a jitter', {
            loss: { ratio: 0.5, seed: 1 },
            jitter: { minDelayMs: 0, maxDelayMs: 5, seed: 1 }
        }, 'nothing else'],
        ['a loss beside a delay', { loss: { ratio: 0.5, seed: 1 }, delayMs: 5 }, 'nothing else']
    ])('refuses %s and says which field', (_label, action, field) => {
        const decoded = decodeSeededTransportFaultAction(action);

        expect(decoded.right).toBeUndefined();
        expect(decoded.left).toContain(field);
    });

    it('names every issue of one action at once', () => {
        const decoded = decodeSeededTransportFaultAction({ jitter: { minDelayMs: -1, maxDelayMs: -2, seed: 0.5 } });

        expect(decoded.left).toContain('jitter.minDelayMs');
        expect(decoded.left).toContain('jitter.maxDelayMs');
        expect(decoded.left).toContain('jitter.seed');
    });
});
