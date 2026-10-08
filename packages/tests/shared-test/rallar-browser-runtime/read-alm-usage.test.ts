import { beforeEach, expect, it } from 'vitest';

import {
    AL_VOLATILE_SESSION_LIMITS,
    type ALVolatileSessionReport
} from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { facade, loadRuntime, resetFacade } from './browser-rallar-runtime-test-harness.ts';

const REPORT: ALVolatileSessionReport = {
    usage: { admissions: 2, bytes: 640, oldestAgeMs: 800, tracks: 1 },
    own: { admissions: 1, bytes: 320 },
    inbound: { admissions: 1, bytes: 320 },
    limits: AL_VOLATILE_SESSION_LIMITS,
    overloaded: false
};

beforeEach(() => {
    resetFacade();
});

it('answers the facade ledger report once the facade is connected', async () => {
    const runtime = await loadRuntime();
    facade.behavior.readUsage.mockReturnValue(REPORT);

    await expect(runtime.readAlmUsage()).resolves.toEqual(REPORT);
});

it('answers undefined before the facade is connected, where the facade read would throw', async () => {
    const runtime = await loadRuntime();
    facade.behavior.isConnected.mockReturnValue(false);
    facade.behavior.readUsage.mockImplementation(() => {
        throw new Error('Rallar is not connected. Call rallar.connect() first.');
    });

    await expect(runtime.readAlmUsage()).resolves.toBeUndefined();
});
