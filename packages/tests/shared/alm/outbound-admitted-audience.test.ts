import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { toALOutboundSentMessageKey } from '@shared/alm/outbound/admission/al-outbound-admission-keys.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { captureALOutboundPolicy } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import {
    captureALOutboundCreationExpiry,
    toALOutboundIdentityEntry,
    toALOutboundMessageReference
} from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

describe('captured outbound audience read', () => {
    it('returns the captured set, including empty, and distinguishes a missing admission', async () => {
        const fixture = await createFixture(['session-a']);
        expect(await fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .toMatchObject({ admittedAudience: ['session-a'], recipientScope: { applicationId: 'app', workspaceId: 'workspace' } });

        const empty = await createFixture([]);
        expect(await empty.store.readCapturedPolicy(empty.message, empty.entry)).toMatchObject({ admittedAudience: [] });

        const absentPolicy = await createFixture(undefined);
        expect((await absentPolicy.store.readCapturedPolicy(absentPolicy.message, absentPolicy.entry)).admittedAudience).toBeUndefined();

        absentPolicy.state.data.clear();
        await expect(absentPolicy.store.readCapturedPolicy(absentPolicy.message, absentPolicy.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });

    it('rejects a matching message id with the wrong canonical key, scope, or expiry', async () => {
        const fixture = await createFixture(['session-a']);
        const reference = fixture.stored.reference;
        await expect(fixture.store.readCapturedPolicy({
            ...fixture.message,
            payload: { ...fixture.message.payload, resource: '{"value":2}' }
        }, fixture.entry)).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        await expect(fixture.store.readCapturedPolicy(fixture.message, {
            ...fixture.entry,
            key: { ...fixture.entry.key, contextId: 'another-context' }
        })).rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        fixture.stored.reference = { ...reference, scope: 'another-scope' };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        fixture.stored.reference = { ...reference, identity: 'forged-identity' };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);

        fixture.stored.reference = { ...reference, expiresAtMs: reference.expiresAtMs + 1 };
        await expect(fixture.store.readCapturedPolicy(fixture.message, fixture.entry))
            .rejects.toBeInstanceOf(ALAdmissionCorruptionError);
    });
});

async function createFixture(admittedAudience: readonly string[] | undefined) {
    const nowMs = Date.now();
    const scope = 'server-scope';
    const namespace = 'server-namespace';
    const message = newALBroadcastMessage(
        'server',
        newALRoute('room.topic', 'room-1', 'event-1'),
        'room',
        'room.topic',
        { value: 1 },
        { ttlMs: 60_000, groupRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' } }
    );
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX);
    const reference = toALOutboundMessageReference(scope, entry, message);
    const stored = {
        msgId: message.id.msgId,
        reference,
        supersedenceKey: undefined,
        unicastPeerId: null,
        orderingTrackKey: null,
        orderingSeq: null,
        policy: captureALOutboundPolicy({
            msg: message,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: [],
            admittedAudience,
            recipientScope: { applicationId: 'app', workspaceId: 'workspace' }
        }),
        creationExpiry: captureALOutboundCreationExpiry(message)
    };
    const state = createInMemoryALAdmissionState();
    await state.workQueue.enqueue(toALOutboundIdentityEntry(reference, entry, stored.creationExpiry));
    const key = toALOutboundSentMessageKey(namespace, message.id.msgId);
    state.data.set(key, { key, value: stored, expireAtTimestamp: nowMs + 120_000 });
    const store = createALOutboundAdmissionStore({
        nowMs: () => nowMs,
        canonicalScope: scope,
        namespace,
        backend: new InMemoryAdmissionBackend(state, () => nowMs),
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention(),
        decodePrepared: () => {
            throw new TypeError('Captured audience fixture has no prepared messages');
        }
    });
    return { store, state, stored, message, entry };
}
