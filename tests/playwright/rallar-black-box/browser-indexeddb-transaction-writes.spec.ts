import { expect, test } from '@playwright/test';
import path from 'node:path';

import type { IndexedDbTransactionWriteBrowserProbe } from './browser-indexeddb-transaction-writes-fixture.ts';

test('persists current rows and resolves concurrent writes in real IndexedDB', async ({ page }) => {
    await page.goto('/');
    const fixturePath = path.resolve(
        'tests/playwright/rallar-black-box/browser-indexeddb-transaction-writes-fixture.ts'
    );
    const result = await page.evaluate<IndexedDbTransactionWriteBrowserProbe, string>(
        async (moduleUrl) => {
            const fixture = await import(moduleUrl);
            return await fixture.runIndexedDbTransactionWriteBrowserProbe();
        },
        `/@fs${fixturePath}`
    );

    expect(result).toMatchObject({
        databaseVersion: 1,
        fairnessIndexPresent: true,
        storedResource: 'stored-value',
        storedRevision: 0,
        admissionTokenPresent: true,
        guardedAdmissionBatchRolledBack: true,
        queuedWorkReplayed: true,
        queueConflictRolledBackAdmission: true,
        admissionConflictRolledBackQueue: true
    });
    expect(result.durableWinner).toBeDefined();
    expect(result.concurrentResults).toEqual([
        result.durableWinner,
        result.durableWinner
    ]);
});
