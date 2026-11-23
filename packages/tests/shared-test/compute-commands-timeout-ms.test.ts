import { describe, expect, it } from 'vitest';

import { computeCommandsTimeoutMs } from '@shared-test/rallar-bb-test/conformance/alm/cell/compute-commands-timeout-ms.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

describe('computeCommandsTimeoutMs', () => {
    it('sums each command\'s own timeout, a connect\'s readiness wait after it, and nothing for an untimed close', () => {
        const commands: readonly RallarBlackBoxTestCommand[] = [
            { kind: 'close', commandId: 'close' },
            {
                kind: 'rtc.connect',
                commandId: 'connect',
                timeoutMs: 45_000,
                readiness: { minReadyPeers: 1, timeoutMs: 30_000 }
            },
            { kind: 'stats', commandId: 'stats', timeoutMs: 75 },
            { kind: 'close', commandId: 'timed-close', timeoutMs: 2_000 }
        ];

        expect(computeCommandsTimeoutMs(commands, 'the test\'s wait')).toBe(77_075);
    });

    it('refuses a command other than a close that names no timeout, naming what could not cover it', () => {
        const untimed: RallarBlackBoxTestCommand = { kind: 'stats', commandId: 'untimed' };

        expect(() => computeCommandsTimeoutMs([untimed], 'the cell\'s barrier over the receiver\'s commands'))
            .toThrow('untimed names no timeout, so the cell\'s barrier over the receiver\'s commands cannot cover it.');
    });

    it('refuses a connect whose readiness names no timeout, whose wait then runs the runtime\'s default', () => {
        const connect: RallarBlackBoxTestCommand = {
            kind: 'rtc.connect',
            commandId: 'connect',
            timeoutMs: 45_000,
            readiness: { minReadyPeers: 1 }
        };

        expect(() => computeCommandsTimeoutMs([connect], 'the test\'s wait'))
            .toThrow('connect\'s readiness names no timeout, so the test\'s wait cannot cover it.');
    });
});
