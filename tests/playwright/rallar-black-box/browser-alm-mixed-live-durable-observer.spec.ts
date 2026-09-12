import { expect, test } from '@playwright/test';
import path from 'node:path';

import type { MixedLiveDurableObservationSemanticsProbe } from './browser-alm-mixed-live-durable-observer.ts';

const OBSERVER_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-observer.ts'
);

test('uses returned dispatch claims for overlap and effect completion', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate<MixedLiveDurableObservationSemanticsProbe, string>(
        async (moduleUrl) => {
            const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(moduleUrl);
            return await fixture.runMixedLiveDurableObservationSemanticsProbe(crypto.randomUUID());
        },
        `/@fs${OBSERVER_PATH}`
    );

    expect(result.noClaimObservation.overlappingReturnedClaimIdentities).toEqual([]);
    expect(result.overlapObservation.overlappingReturnedClaimIdentities).toEqual(['durable-probe']);
    expect(result.completedAfterParent).toEqual([]);
    expect(result.completedAfterRetry).toEqual([]);
    expect(result.refusedIdentityObserved).toBe(false);
    expect(result.queuePhases.map((phase) => phase.phase)).toEqual(expect.arrayContaining([
        'queue-read',
        'claim-reserved',
        'release-completed'
    ]));
    expect(result.completedDurableIdentities).toEqual(['durable-probe']);
    expect(result.queueHookModuleIdentityObserved).toBe(true);
    expect(result.doubleInstallationRejected).toBe(true);
    expect(result.methodsRestored).toBe(true);
});
