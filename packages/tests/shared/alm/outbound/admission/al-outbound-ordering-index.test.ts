import { describe, expect, it } from 'vitest';

import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { toALOutboundSentMessageKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createALOutboundAdmissionStore, type ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundOrderingMessageKey, toALOutboundOrderingTrackPrefix } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';

const NAMESPACE = 'outbound';
const NOW_MS = 1_700_000_000_000;
const TRACK_KEY = 'game-1:server:1';
const LIVE_UNTIL_MS = NOW_MS + 60_000;

interface IndexFixture {
    readonly backend: InMemoryAdmissionBackend;
    readonly store: ALOutboundAdmissionStore<string>;
}

function createIndexFixture(): IndexFixture {
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
    return { backend, store };
}

async function writeIndexRow(fixture: IndexFixture, trackKey: string, seq: number, msgId: string, expiresAtMs = LIVE_UNTIL_MS): Promise<void> {
    await fixture.backend.write((tx) => tx.set(toALOutboundOrderingMessageKey(NAMESPACE, trackKey, seq), msgId, expiresAtMs));
}

async function writeStoredRow(fixture: IndexFixture, msgId: string): Promise<void> {
    await fixture.backend.write((tx) =>
        tx.set(toALOutboundSentMessageKey(NAMESPACE, msgId), {
            msgId,
            reference: {
                key: { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'scope', contextId: msgId },
                typeId: 'AL_OUTBOUND_MESSAGE',
                scope: 'scope',
                msgId,
                senderId: 'server',
                identity: msgId,
                expiresAtMs: LIVE_UNTIL_MS
            },
            unicastPeerId: null,
            orderingTrackKey: TRACK_KEY,
            orderingSeq: 1,
            sentPositions: { b: 0 },
            policy: { persist: true, ackTracking: null, retryTracking: null, repairTracking: null, supersedenceTracking: null, admittedAudience: ['b'] },
            creationExpiry: 'creation-expiry'
        }, LIVE_UNTIL_MS)
    );
}

describe('the ordering index of one track', () => {
    it('lists one track\'s live sequences ascending, without an expired row or a track sharing its prefix', async () => {
        const fixture = createIndexFixture();
        await writeIndexRow(fixture, TRACK_KEY, 12, 'event-12');
        await writeIndexRow(fixture, TRACK_KEY, 3, 'event-3');
        await writeIndexRow(fixture, TRACK_KEY, 2, 'event-2', NOW_MS);
        await writeIndexRow(fixture, 'game-1:server:10', 1, 'other-track');

        expect(await fixture.store.listOrderingMessages(TRACK_KEY)).toEqual([
            { seq: 3, msgId: 'event-3' },
            { seq: 12, msgId: 'event-12' }
        ]);
    });

    it('fails closed on a key under the track\'s prefix that names no sequence', async () => {
        const fixture = createIndexFixture();
        await fixture.backend.write((tx) => tx.set(`${toALOutboundOrderingTrackPrefix(NAMESPACE, TRACK_KEY)}"x"]`, 'event-x', LIVE_UNTIL_MS));

        await expect(fixture.store.listOrderingMessages(TRACK_KEY)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('reads the stored rows of the listed messages together, leaving out one never stored', async () => {
        const fixture = createIndexFixture();
        await writeStoredRow(fixture, 'event-1');

        const stored = await fixture.store.readStoredMessages(['event-1', 'event-2']);

        expect([...stored.keys()]).toEqual(['event-1']);
        expect(stored.get('event-1')?.sentPositions).toEqual({ b: 0 });
    });

    it('reads the message a sequence names and its stored row, and nothing for a sequence no row names', async () => {
        const fixture = createIndexFixture();
        await writeIndexRow(fixture, TRACK_KEY, 1, 'event-1');
        await writeIndexRow(fixture, TRACK_KEY, 2, 'event-2');
        await writeStoredRow(fixture, 'event-1');

        expect(await fixture.store.readOrderingPredecessor(TRACK_KEY, 1)).toEqual({
            msgId: 'event-1',
            stored: expect.objectContaining({ msgId: 'event-1', sentPositions: { b: 0 } })
        });
        expect(await fixture.store.readOrderingPredecessor(TRACK_KEY, 2)).toEqual({ msgId: 'event-2', stored: undefined });
        expect(await fixture.store.readOrderingPredecessor(TRACK_KEY, 3)).toBeUndefined();
    });

    it('ends a sequence\'s row only while it names the message that ends', async () => {
        const fixture = createIndexFixture();
        await writeIndexRow(fixture, TRACK_KEY, 1, 'event-1');
        await writeIndexRow(fixture, TRACK_KEY, 2, 'event-2');

        expect(await fixture.store.commitOrderingMessageEnd({ trackKey: TRACK_KEY, seq: 2, msgId: 'event-1' })).toBe('other-message');
        expect(await fixture.store.commitOrderingMessageEnd({ trackKey: TRACK_KEY, seq: 1, msgId: 'event-1' })).toBe('deleted');
        expect(await fixture.store.commitOrderingMessageEnd({ trackKey: TRACK_KEY, seq: 1, msgId: 'event-1' })).toBe('absent');
        expect(await fixture.store.listOrderingMessages(TRACK_KEY)).toEqual([{ seq: 2, msgId: 'event-2' }]);
    });
});
