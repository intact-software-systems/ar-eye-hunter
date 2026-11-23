import { describe, expect, it } from 'vitest';

import { computeCommandsTimeoutMs } from '@shared-test/rallar-bb-test/conformance/alm/alm-recipe-run-extension.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

describe('computeCommandsTimeoutMs', () => {
    it('sums each command\'s own timeout, a connect\'s readiness wait after it, and nothing for a close', () => {
        const commands: readonly RallarBlackBoxTestCommand[] = [
            { kind: 'close', commandId: 'close' },
            {
                kind: 'rtc.connect',
                commandId: 'connect',
                timeoutMs: 45_000,
                readiness: { minReadyPeers: 1, timeoutMs: 30_000 }
            },
            { kind: 'stats', commandId: 'stats', timeoutMs: 75 }
        ];

        expect(computeCommandsTimeoutMs(commands)).toBe(75_075);
    });

    it('refuses a command other than a close that names no timeout, since its time cannot be counted', () => {
        const untimed: RallarBlackBoxTestCommand = { kind: 'stats', commandId: 'untimed' };

        expect(() => computeCommandsTimeoutMs([untimed])).toThrow(/untimed/);
    });
});
