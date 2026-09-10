import {
    describe,
    expect,
    it
} from 'vitest';

import { raceWithRtcConnectReadinessAbort } from '../../../packages/shared-test/rallar-bb-test/browser/rtc-connect-readiness-abort.ts';

describe('RTC connect readiness abort handling', () => {
    it('observes the started operation when the readiness signal is already aborted', async () => {
        const operationError = new Error('operation cancelled after it started');
        const abortError = new Error('readiness already cancelled');
        const controller = new AbortController();
        controller.abort(abortError);

        await expect(
            raceWithRtcConnectReadinessAbort(Promise.reject(operationError), controller.signal)
        ).rejects.toBe(abortError);
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
});
