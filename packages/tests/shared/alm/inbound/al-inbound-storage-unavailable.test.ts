import { describe, expect, it, vi } from 'vitest';

import type { ALStorageEvent } from '@shared/alm/storage/al-storage-event.ts';
import { ALStorageHealth } from '@shared/alm/storage/al-storage-health.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createInboundTestBackendStores,
    createInboundTestMessage,
    createInboundTestRuntime,
    INBOUND_TEST_SOURCE
} from '../inbound-runtime-test-fixture.ts';

const QUOTA = new DOMException('The quota has been exceeded.', 'QuotaExceededError');

describe('inbound storage unavailability', () => {
    // Nothing was written, so the message is not admitted and its sender's receipt retries it.
    it('answers a message whose admission hits the quota not admitted, then healthy at the next commit', async () => {
        const events: ALStorageEvent[] = [];
        const { backend, stores } = createInboundTestBackendStores({
            namespace: 'inbound-storage',
            storage: 'memory',
            observer: createPassThroughIndexedDbOperationObserver()
        });
        const fixture = createInboundTestRuntime({
            stores: {
                ...stores,
                storageHealth: new ALStorageHealth({
                    storeId: 'inbound-test',
                    storage: (event) => events.push(event)
                })
            },
            carrier: 'ws',
            effectWorkerId: 'al-inbound:storage'
        });
        vi.spyOn(backend, 'write').mockRejectedValueOnce(QUOTA);

        const refused = await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'inbound-quota' }),
            INBOUND_TEST_SOURCE
        );
        const admitted = await fixture.runtime.admitIncomingMessage(
            createInboundTestMessage({ msgId: 'inbound-recovered' }),
            INBOUND_TEST_SOURCE
        );

        expect(refused.right).toEqual({ kind: 'not-admitted', reason: 'storage-unavailable' });
        expect(admitted.right).toEqual({ kind: 'admitted' });
        await vi.waitFor(() =>
            expect(events.map((event) => event.kind === 'health' ? event.status : event.kind))
                .toEqual(['failing', 'healthy'])
        );
    });
});
