import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import type {
    WsCapturedRecipientEligibilityFilter,
    WsCapturedRecipientEligibilityFilters
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerDequeueAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** `a` published to `b`, `c` and `d`; `b` and `d` are live somewhere, and only `b`'s socket is open on this instance. */
const ADMITTED = { admittedAudience: ['b', 'c', 'd'], admittedConnectionGenerationIds: undefined, recipientScope: undefined, sessionInvalidation: undefined };
const keepsBAndD: WsCapturedRecipientEligibilityFilter = (captured) => Promise.resolve(captured.candidateSessionIds.filter((sessionId) => sessionId !== 'c'));
const keepsB: WsCapturedRecipientEligibilityFilter = (captured) => Promise.resolve(captured.candidateSessionIds.filter((sessionId) => sessionId === 'b'));
const KEEPS_B_AND_D: WsCapturedRecipientEligibilityFilters = { durable: keepsBAndD, local: keepsB };

function createAuthority(
    frozen: boolean,
    capturedRecipientEligibilityFilters: WsCapturedRecipientEligibilityFilters | undefined
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
        capturedRecipientEligibilityFilters
    });
}

function feedEvent(): ALMessage {
    return newALBroadcastMessage('a', newALRoute('room.feed', ROOM.groupId, 'event-1'), 'room', 'feed.v1', {}, { groupRef: ROOM });
}

describe('the audience one dequeue attempt finds for a row', () => {
    it('names beside the sessions the re-check keeps those it dropped, which the attempt sends nothing', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: ['b', 'd'], dropped: ['c'] });
    });

    it('sends nobody and declares no exclusion when no re-check is wired: its sessions stay expected', async () => {
        const audience = await createAuthority(true, undefined).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: [], dropped: [] });
    });

    it('drops a captured session no durable filter finds live, whatever this instance\'s sockets hold', async () => {
        const audience = await createAuthority(false, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: ['b', 'd'], dropped: ['c'] });
    });

    it('keeps a non-frozen row\'s captured audience when no durable filter is wired', async () => {
        const audience = await createAuthority(false, undefined).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: ['b', 'c', 'd'], dropped: [] });
    });

    it('re-checks a frozen row\'s sessions against this instance\'s sockets at a send, and keeps a non-frozen row\'s as captured', async () => {
        const frozen = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'local');
        const notFrozen = await createAuthority(false, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'local');

        expect(frozen).toEqual({ eligible: ['b'], dropped: ['c', 'd'] });
        expect(notFrozen).toEqual({ eligible: ['b', 'c', 'd'], dropped: [] });
    });

    it('admits nobody and drops nobody for a row admitted to no audience', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(
            feedEvent(),
            { ...ADMITTED, admittedAudience: undefined },
            'durable'
        );

        expect(audience).toEqual({ eligible: undefined, dropped: [] });
    });
});
