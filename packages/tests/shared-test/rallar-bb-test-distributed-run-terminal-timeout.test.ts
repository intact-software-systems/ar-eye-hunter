import { describe, expect, it } from 'vitest';

import { computeDistributedRunTerminalTimeoutSeconds } from '../../shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import type { RallarBlackBoxTestRecipe } from '../../shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

const STATS = { kind: 'stats' } as const;

function toRecipe(recipeId: string, commands: RallarBlackBoxTestRecipe['commands']): RallarBlackBoxTestRecipe {
    return { schemaVersion: 1, recipeId, commands };
}

describe('distributed run terminal timeout', () => {
    it('adds the ack, the barrier and the slowest recipe whose every command uses its whole budget', () => {
        const slow = toRecipe('slow', [
            { kind: 'http.request', timeoutMs: 30_000, request: { path: '/api/config' } },
            { kind: 'rtc.connect', timeoutMs: 95_000 },
            // Six iterations, five 1 s pauses between them; stats carries no budget of its own.
            { kind: 'loop', count: 6, intervalMs: 1_000, commands: [STATS] },
            // The last of 150 frames goes out 149 intervals in, then the stream drains.
            { kind: 'rtc.stream', count: 150, intervalMs: 200, drainTimeoutMs: 5_000, send: {} },
            {
                kind: 'parallel',
                groups: [
                    { commands: [{ kind: 'loop', count: 3, intervalMs: 2_000, commands: [STATS] }] },
                    { commands: [{ kind: 'http.request', timeoutMs: 1_000, request: { path: '/api/config' } }] }
                ]
            },
            { kind: 'loop', count: 2, intervalMs: 500, commands: [{ kind: 'rtc.connect', timeoutMs: 100 }] },
            STATS
        ]);
        const fast = toRecipe('fast', [{ kind: 'http.request', timeoutMs: 1_000, request: { path: '/api/config' } }]);

        expect(computeDistributedRunTerminalTimeoutSeconds({
            recipes: [fast, slow],
            ackTimeoutMs: 30_000,
            barrier: { enabled: true, timeoutMs: 15_000 }
        })).toBe(Math.ceil((30_000 + 15_000 + 30_000 + 95_000 + 5_000 + 29_800 + 5_000 + 4_000 + 500 + 200) / 1_000));
        expect(computeDistributedRunTerminalTimeoutSeconds({
            recipes: [fast],
            ackTimeoutMs: 30_000,
            barrier: { enabled: false }
        })).toBe(31);
    });

    it('rounds a part second up so the terminal wait never ends inside a budget', () => {
        expect(computeDistributedRunTerminalTimeoutSeconds({
            recipes: [toRecipe('part-second', [{ kind: 'rtc.connect', timeoutMs: 1 }])],
            ackTimeoutMs: 1_000,
            barrier: { enabled: false }
        })).toBe(2);
    });
});
