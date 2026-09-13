import { expect, test } from '@playwright/test';
import path from 'node:path';

import type { MixedLiveDurableObservationSemanticsProbe } from './browser-alm-mixed-live-durable-observer.ts';

const OBSERVER_PATH = path.resolve(
    'tests/playwright/rallar-black-box/browser-alm-mixed-live-durable-observer.ts'
);
const QUEUE_BOX_PATH = path.resolve('packages/shared/queuebox/indexed-db-queue-box.ts');

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
    expect(result.expiredClaimObservation.overlappingReturnedClaimIdentities).toEqual([]);
    expect(result.overlapObservation.sequence).toBe(3);
    expect(result.overlapObservation.overlappingReturnedClaimIdentities).toEqual(['durable-probe']);
    expect(result.afterCallbackStartedObservation.overlappingReturnedClaimIdentities).toEqual([]);
    expect(result.completedAfterParent).toEqual([]);
    expect(result.completedAfterRetry).toEqual([]);
    expect(result.afterRetryObservation.overlappingReturnedClaimIdentities).toEqual([]);
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

test('restores observation hooks and permits reinstallation after a rejected queue operation', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async (input) => {
        const fixture: typeof import('./browser-alm-mixed-live-durable-observer.ts') = await import(input.observerUrl);
        const queueModule: typeof import('../../../packages/shared/queuebox/indexed-db-queue-box.ts') = await import(
            input.queueBoxUrl
        );
        const queuePrototype = queueModule.IndexedDbQueueBox.prototype;
        const originalMethods = {
            readWorkPage: queuePrototype.readWorkPage,
            readWorkPages: queuePrototype.readWorkPages,
            reserveEntries: queuePrototype.reserveEntries,
            reserveTimeoutEntries: queuePrototype.reserveTimeoutEntries,
            releaseEntries: queuePrototype.releaseEntries
        };
        const queueMethodsMatchOriginals = () =>
            queuePrototype.readWorkPage === originalMethods.readWorkPage &&
            queuePrototype.readWorkPages === originalMethods.readWorkPages &&
            queuePrototype.reserveEntries === originalMethods.reserveEntries &&
            queuePrototype.reserveTimeoutEntries === originalMethods.reserveTimeoutEntries &&
            queuePrototype.releaseEntries === originalMethods.releaseEntries;
        const originalEnqueueIfAbsent = queuePrototype.enqueueIfAbsent;
        let probeRejected = false;
        queuePrototype.enqueueIfAbsent = async function injectedEnqueueFailure () {
            throw new Error('injected queue failure');
        };
        try {
            await fixture.runMixedLiveDurableObservationSemanticsProbe(crypto.randomUUID());
        }
        catch {
            probeRejected = true;
        }
        finally {
            queuePrototype.enqueueIfAbsent = originalEnqueueIfAbsent;
        }
        const methodsRestoredAfterRejection = queueMethodsMatchOriginals();
        let reinstallationSucceeded = false;
        let methodsRestored = false;
        try {
            const reinstalled = fixture.installMixedLiveDurableObservation({
                databaseName: `playwright-mixed-live-durable-reinstall-${crypto.randomUUID()}`,
                storeName: 'entries',
                durableTypeId: 'room.mixed-durable.v1',
                markedDurableIdentities: [],
                inboundNamespace: 'reinstall:inbound:admission'
            });
            reinstallationSucceeded = true;
            methodsRestored = reinstalled.dispose().methodsRestored;
        }
        finally {
            try {
                fixture.readMixedLiveDurableObservation().dispose();
            }
            catch {
                // Absence proves the owner cleared its global installation marker.
            }
        }
        const methodsRestoredAfterReinstallation = queueMethodsMatchOriginals();
        return {
            probeRejected,
            reinstallationSucceeded,
            methodsRestored,
            methodsRestoredAfterRejection,
            methodsRestoredAfterReinstallation
        };
    }, {
        observerUrl: `/@fs${OBSERVER_PATH}`,
        queueBoxUrl: `/@fs${QUEUE_BOX_PATH}`
    });

    expect(result).toEqual({
        probeRejected: true,
        reinstallationSucceeded: true,
        methodsRestored: true,
        methodsRestoredAfterRejection: true,
        methodsRestoredAfterReinstallation: true
    });
});
