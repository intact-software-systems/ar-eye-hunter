import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';

import { createVolatileALOutboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { AL_ADMISSION_SCHEMA_ID } from '@shared/alm/open-indexed-db-admission-database.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    decodeALOutboundTransportMessage,
    type ALOutboundTransportMessage
} from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createCountingIndexedDbOperationObserver,
    type IndexedDbOperationCounts,
    type IndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    toOriginFrozenTargets
} from '../multicast/rtc-origin-overlay-fixture.ts';

const NAMESPACE = 'rtc-origin-alone';

describe('an RTC origin alone in its room, sending volatile (D75)', () => {
    it('acknowledges a receiver send in 0 al-admission and 0 non-probe al-work IndexedDB operations', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const durableStores = createIndexedDbOriginStores(observer);
        const volatileStores = createVolatileALOutboundRuntimeStores({
            decodePrepared: decodeALOutboundTransportMessage
        });
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a'], 4),
            nextHopPeerIds: [],
            stores: durableStores,
            volatileStores
        });
        const message = createOriginReceiverMulticast('alone-counted');

        const admitted = await fixture.manager.enqueueIfAbsent(message);

        // The origin's durable pair is the counted IndexedDB pair, so the zeros below measure it.
        expect(fixture.resources.admissionStore).toBe(durableStores.admissionStore);
        expect(admitted.verdict).toMatchObject({ kind: 'admitted', durable: false });
        expect(admitted.message.targets).toEqual(toOriginFrozenTargets([], 4));
        expect(await volatileStores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(
            true
        );
        await vi.waitFor(() =>
            expect(
                fixture.settlements.filter((settlement) => settlement.kind === 'acknowledgement')
            ).toEqual([
                expect.objectContaining({
                    msgId: message.id.msgId,
                    mode: 'receiver',
                    complete: true
                })
            ])
        );
        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission'], 'an origin alone commits nothing to IndexedDB').toBe(
            0
        );
        expect(computeNonProbeWorkOperations(counts), 'the idle durable owner only probes').toBe(0);
    });
});

function createIndexedDbOriginStores(
    observer: IndexedDbOperationObserver
): ALOutboundRuntimeStores<ALOutboundTransportMessage> {
    const backend = new IndexedDbAdmissionBackend({
        schemaId: AL_ADMISSION_SCHEMA_ID,
        onStorageReset: () => {},
        dbName: `${NAMESPACE}-${crypto.randomUUID()}`,
        storeName: 'entries',
        nowMs: Date.now,
        newWriteToken: crypto.randomUUID.bind(crypto),
        observer
    });
    return {
        admissionStore: createALOutboundAdmissionStore({
            nowMs: Date.now,
            canonicalScope: NAMESPACE,
            decodePrepared: decodeALOutboundTransportMessage,
            namespace: NAMESPACE,
            backend,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        }),
        workQueue: backend.workQueue
    };
}

/** Probes (`work-page`, `work-probe`) are the idle durable owner reading an empty queue, never work (R-S3a-11). */
function computeNonProbeWorkOperations(counts: IndexedDbOperationCounts): number {
    return counts.byOwner['al-work'] - (counts.byKind['work-page'] ?? 0) -
        (counts.byKind['work-probe'] ?? 0);
}
