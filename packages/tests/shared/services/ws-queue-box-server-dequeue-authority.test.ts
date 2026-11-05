import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type { WsCapturedRecipientEligibilityFilter } from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerDequeueAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** `a` published to `b`, `c` and `d`; the re-check still finds `b` and `d` subscribed. */
const ADMITTED = { admittedAudience: ['b', 'c', 'd'], admittedConnectionGenerationIds: undefined, recipientScope: undefined, sessionInvalidation: undefined };
const KEEPS_B_AND_D: WsCapturedRecipientEligibilityFilter = (captured) =>
    Promise.resolve(captured.candidateSessionIds.filter((sessionId) => sessionId !== 'c'));

function createAuthority(
    frozen: boolean,
    filterEligibleCapturedSessionIds: WsCapturedRecipientEligibilityFilter | undefined
): WsQueueBoxServerDequeueAuthority {
    const nowMs = () => 1_000;
    return new WsQueueBoxServerDequeueAuthority({
        admissionStore: createALOutboundAdmissionStore({
            nowMs,
            canonicalScope: 'dequeue-authority',
            decodePrepared: decodeWsQueueBoxServerPreparedMessage,
            backend: new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), nowMs),
            namespace: 'dequeue-authority',
            retention: normalizeALRuntimeStoreRetention(),
            supersedenceTrackTtlMs: 60_000
        }),
        readProducerProvenance: undefined,
        targetResolution: { requiresFrozenAudience: () => frozen },
        filterEligibleCapturedSessionIds
    });
}

function feedEvent(): ALMessage {
    return newALBroadcastMessage('a', newALRoute('room.feed', ROOM.groupId, 'event-1'), 'room', 'feed.v1', {}, { groupRef: ROOM });
}

describe('the audience one dequeue attempt finds for a row', () => {
    it('names beside the sessions the re-check keeps those it dropped, which the attempt sends nothing', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED);

        expect(audience).toEqual({ eligible: ['b', 'd'], dropped: ['c'] });
    });

    it('drops every admitted session when no re-check is wired', async () => {
        const audience = await createAuthority(true, undefined).readCurrentAudience(feedEvent(), ADMITTED);

        expect(audience).toEqual({ eligible: [], dropped: ['b', 'c', 'd'] });
    });

    it('keeps the captured audience of a row that is not frozen, dropping nobody', async () => {
        const audience = await createAuthority(false, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED);

        expect(audience).toEqual({ eligible: ['b', 'c', 'd'], dropped: [] });
    });

    it('admits nobody and drops nobody for a row admitted to no audience', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(
            feedEvent(),
            { ...ADMITTED, admittedAudience: undefined }
        );

        expect(audience).toEqual({ eligible: undefined, dropped: [] });
    });
});
