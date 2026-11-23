import { describe, expect, it } from 'vitest';

import { computeDistributedRunTerminalTimeoutSeconds } from '@shared-test/rallar-bb-test/distributed-recipe-targeting/compute-distributed-run-terminal-timeout-seconds.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

function toRecipe(recipeId: string, commands: readonly RallarBlackBoxTestCommand[]): RallarBlackBoxTestRecipe {
    return { schemaVersion: 1, recipeId, commands };
}

const NO_BARRIER = { enabled: false } as const;

describe('computeDistributedRunTerminalTimeoutSeconds', () => {
    it('counts a connect\'s readiness wait after the connect\'s own timeout, as the runtime runs them', () => {
        const recipe = toRecipe('connects', [{
            kind: 'rtc.connect',
            commandId: 'connect',
            timeoutMs: 45_000,
            readiness: { minReadyPeers: 1, timeoutMs: 30_000 }
        }]);

        expect(computeDistributedRunTerminalTimeoutSeconds({ recipes: [recipe], ackTimeoutMs: 10_000, barrier: NO_BARRIER }))
            .toBe(85);
    });

    it('counts the runtime\'s default readiness wait for a readiness that names no timeout', () => {
        const recipe = toRecipe('connects', [{
            kind: 'rtc.connect',
            commandId: 'connect',
            timeoutMs: 45_000,
            readiness: { minReadyPeers: 1 }
        }]);

        expect(computeDistributedRunTerminalTimeoutSeconds({ recipes: [recipe], ackTimeoutMs: 10_000, barrier: NO_BARRIER }))
            .toBe(60);
    });

    it('counts a connect\'s readiness inside a parallel group, and nothing for a connect without readiness', () => {
        const recipe = toRecipe('connects', [
            {
                kind: 'parallel',
                commandId: 'side-by-side',
                groups: [
                    {
                        groupId: 'ready',
                        commands: [{
                            kind: 'rtc.connect',
                            commandId: 'ready-connect',
                            timeoutMs: 20_000,
                            readiness: { minReadyPeers: 1, timeoutMs: 15_000 }
                        }]
                    },
                    { groupId: 'plain', commands: [{ kind: 'rtc.connect', commandId: 'plain-connect', timeoutMs: 30_000 }] }
                ]
            }
        ]);

        expect(
            computeDistributedRunTerminalTimeoutSeconds({
                recipes: [recipe],
                ackTimeoutMs: 1_000,
                barrier: { enabled: true, timeoutMs: 4_000 }
            })
        ).toBe(40);
    });
});
