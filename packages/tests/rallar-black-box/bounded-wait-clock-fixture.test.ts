import {
    describe,
    expect,
    it
} from 'vitest';

import { settleUnderFakeTimers, spendBoundedWait, useBoundedWaitClock } from './bounded-wait-clock-fixture.ts';

useBoundedWaitClock();

/** Runs `run`, then lets one real macrotask pass, and returns how many rejections Node reported unhandled meanwhile. */
async function countUnhandledRejections(run: () => Promise<void>): Promise<number> {
    let unhandled = 0;
    const record = (): void => {
        unhandled += 1;
    };
    process.on('unhandledRejection', record);
    try {
        await run();
        await new Promise((resolve) => setImmediate(resolve));
    }
    finally {
        process.off('unhandledRejection', record);
    }
    return unhandled;
}

describe('settleUnderFakeTimers', () => {
    it('rejects with the failure of a run that rejects after a wait, and leaves no rejection unhandled', async () => {
        const unhandled = await countUnhandledRejections(async () => {
            const outcome = settleUnderFakeTimers(async () => {
                await spendBoundedWait(1_000);
                throw new Error('the run failed');
            });
            await expect(outcome).rejects.toThrow('the run failed');
        });

        expect(unhandled).toBe(0);
    });

    it('resolves with the value of a run that resolves after a wait', async () => {
        const outcome = settleUnderFakeTimers(async () => {
            await spendBoundedWait(1_000);
            return 'settled';
        });

        await expect(outcome).resolves.toBe('settled');
    });
});
