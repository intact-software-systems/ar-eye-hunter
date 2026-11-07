import { describe, expect, it, vi } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { toALOutboundSentMessageKey, toALOutboundVersionKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundReceiptClasses } from '@shared/alm/outbound/control/to-al-outbound-receipt-classes.ts';

const NAMESPACE = 'outbound';
const NOW_MS = 1_700_000_000_000;
const LIVE_UNTIL_MS = NOW_MS + 60_000;
const ORIGIN = 'server';
const MSG_ID = 's-event-1';
const RECEIPT = { originPeerId: ORIGIN, msgId: MSG_ID };

interface OutsideFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly store: ALOutboundAdmissionStore<string>;
}

async function createOutsideFixture(): Promise<OutsideFixture> {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), () => NOW_MS);
    const store = createALOutboundAdmissionStore<string>({
        nowMs: () => NOW_MS,
        canonicalScope: 'scope',
        namespace: NAMESPACE,
        backend,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: (value) => String(value)
    });
    await writeStoredRow(backend);
    expect(
        await store.commitBundle({
            senderId: ORIGIN,
            mutations: [{ kind: 'set-pending-ack', originPeerId: ORIGIN, snapshot: toPending(MSG_ID), expireAtTimestamp: LIVE_UNTIL_MS }],
            durableEffects: []
        })
    ).toBe('committed');
    return { backend, store };
}

function toPending(msgId: string): ALOutboundPendingAckSnapshot {
    return {
        msgId,
        mode: 'receiver',
        expectedPeerIds: ['b', 'c'],
        ackedPeerIds: [],
        outsideAudiencePeerIds: [],
        timeoutMs: 2_000,
        maxAttempts: 3,
        attempts: 1,
        deadlineAtMs: NOW_MS + 2_000
    };
}

async function writeStoredRow(backend: InMemoryAdmissionBackend): Promise<void> {
    await backend.write((tx) =>
        tx.set(toALOutboundSentMessageKey(NAMESPACE, MSG_ID), {
            msgId: MSG_ID,
            reference: {
                key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: MSG_ID },
                typeId: 'AL_OUTBOUND_MESSAGE',
                scope: 'scope',
                msgId: MSG_ID,
                senderId: ORIGIN,
                identity: MSG_ID,
                expiresAtMs: LIVE_UNTIL_MS
            },
            unicastPeerId: null,
            orderingTrackKey: null,
            orderingSeq: null,
            sentPositions: null,
            policy: { persist: true, ackTracking: null, retryTracking: null, repairTracking: null, supersedenceTracking: null, admittedAudience: ['b', 'c'] },
            creationExpiry: 'creation-expiry'
        }, LIVE_UNTIL_MS)
    );
}

/** Every row the backend holds, so a call that writes nothing leaves the same snapshot. */
async function readRows(fixture: OutsideFixture): Promise<string> {
    return JSON.stringify(await fixture.store.readReceiptState(RECEIPT)) +
        JSON.stringify(await fixture.backend.readWithin((session) => session.read(toALOutboundVersionKey(NAMESPACE, ORIGIN), (value) => value)));
}

describe('the server records its own skipped recipients outside its receipt', () => {
    it('records a peer outside the receipt\'s audience under the origin\'s sender version', async () => {
        const fixture = await createOutsideFixture();

        expect(await fixture.store.commitOutsideAudience(RECEIPT, ['c'])).toBe('committed');

        const receipt = await fixture.store.readReceiptState(RECEIPT);
        expect(receipt?.outsideAudiencePeerIds).toEqual(['c']);
        expect(toALOutboundReceiptClasses(receipt!).unconfirmedPeerIds).toEqual(['b']);
    });

    it('is idempotent and writes nothing for a peer already outside', async () => {
        const fixture = await createOutsideFixture();
        expect(await fixture.store.commitOutsideAudience(RECEIPT, ['c'])).toBe('committed');
        const before = await readRows(fixture);
        const write = vi.spyOn(fixture.backend, 'write');

        expect(await fixture.store.commitOutsideAudience(RECEIPT, ['c'])).toBe('committed');

        expect(write).not.toHaveBeenCalled();
        expect(await readRows(fixture)).toBe(before);
    });

    it('answers absent for a receipt that does not exist and writes nothing', async () => {
        const fixture = await createOutsideFixture();
        const write = vi.spyOn(fixture.backend, 'write');

        expect(await fixture.store.commitOutsideAudience({ originPeerId: ORIGIN, msgId: 'never-sent' }, ['c'])).toBe('absent');

        expect(write).not.toHaveBeenCalled();
    });

    it('answers conflict when the origin\'s version moved between the read and the write', async () => {
        const fixture = await createOutsideFixture();
        const readWithin = fixture.backend.readWithin.bind(fixture.backend);
        vi.spyOn(fixture.backend, 'readWithin').mockImplementationOnce(async (read) => {
            const surface = await readWithin(read);
            expect(
                await fixture.store.commitBundle({
                    senderId: ORIGIN,
                    expectedVersion: 1,
                    mutations: [{ kind: 'set-pending-ack', originPeerId: ORIGIN, snapshot: toPending('s-event-2'), expireAtTimestamp: LIVE_UNTIL_MS }],
                    durableEffects: []
                })
            ).toBe('committed');
            return surface;
        });

        expect(await fixture.store.commitOutsideAudience(RECEIPT, ['c'])).toBe('conflict');

        expect((await fixture.store.readReceiptState(RECEIPT))?.outsideAudiencePeerIds).toEqual([]);
    });

    it('keeps a receipt whose every peer is outside open', async () => {
        const fixture = await createOutsideFixture();

        expect(await fixture.store.commitOutsideAudience(RECEIPT, ['b', 'c'])).toBe('committed');

        const receipt = await fixture.store.readReceiptState(RECEIPT);
        expect(receipt).toMatchObject({ ackedPeerIds: [], outsideAudiencePeerIds: ['b', 'c'] });
        expect(toALOutboundReceiptClasses(receipt!).unconfirmedPeerIds).toEqual([]);
    });
});
