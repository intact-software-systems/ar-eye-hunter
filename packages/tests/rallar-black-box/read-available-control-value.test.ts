import { Either } from '@shared/resilience/Either.ts';
import { describe, expect, it } from 'vitest';
import type { ControlRequestFailure } from '../../../apps/rallar-black-box/src/control-run-manager/control-request-failure.ts';
import { readAvailableControlValue } from '../../../apps/rallar-black-box/src/legacy/runner/runs/read-available-control-value.ts';

const httpFailure: ControlRequestFailure = {
    kind: 'http',
    status: 404,
    statusText: 'Not Found',
    message: 'Control run not found.'
};

describe('an optional control read inside the distributed refresh', () => {
    it('answers with the value the control server returned', async () => {
        await expect(
            readAvailableControlValue(
                Promise.resolve(Either.ofRight<ControlRequestFailure, string>('run-1'))
            )
        ).resolves.toBe('run-1');
    });

    it('leaves the fact absent when the control server reports an expected failure', async () => {
        await expect(
            readAvailableControlValue(
                Promise.resolve(Either.ofLeft<ControlRequestFailure, string>(httpFailure))
            )
        ).resolves.toBeUndefined();
    });

    it('leaves the fact absent when the transport rejects, so the refresh still publishes its list', async () => {
        await expect(
            readAvailableControlValue<string>(
                Promise.reject(new TypeError('Failed to fetch'))
            )
        ).resolves.toBeUndefined();
    });
});
