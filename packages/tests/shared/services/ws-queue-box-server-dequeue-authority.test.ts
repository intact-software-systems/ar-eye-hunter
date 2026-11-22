import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALSessionInvalidationAuthority } from '@shared/alm/outbound/admission/al-session-invalidation-authority.ts';
import { createDefaultBackgroundTimers, type Timers } from '@shared/resilience/timers.ts';
import { decodeWsQueueBoxServerPreparedMessage } from '@shared/services/ws-queue-box-server/decode-ws-queue-box-server-prepared-message.ts';
import { WsCapturedAudienceReadDeadlineError } from '@shared/services/ws-queue-box-server/scope/read-ws-queue-box-server-eligible-audience.ts';
import type {
    WsCapturedRecipientEligibilityFilter,
    WsCapturedRecipientEligibilityFilters
} from '@shared/services/ws-queue-box-server/ws-queue-box-server-contracts.ts';
import { WsQueueBoxServerDequeueAuthority } from '@shared/services/ws-queue-box-server/ws-queue-box-server-dequeue-authority.ts';

import { createManualTimers } from '../resilience/manual-timers.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
/** `a` published to `b`, `c` and `d`; `b` and `d` are live somewhere, and only `b`'s socket is open on this instance. */
const ADMITTED = { admittedAudience: ['b', 'c', 'd'], admittedConnectionGenerationIds: undefined, recipientScope: undefined, sessionInvalidation: undefined };
const keepsBAndD: WsCapturedRecipientEligibilityFilter = (captured) => Promise.resolve(captured.candidateSessionIds.filter((sessionId) => sessionId !== 'c'));
const keepsB: WsCapturedRecipientEligibilityFilter = (captured) => Promise.resolve(captured.candidateSessionIds.filter((sessionId) => sessionId === 'b'));
const KEEPS_B_AND_D: WsCapturedRecipientEligibilityFilters = { durable: keepsBAndD, local: keepsB, socket: keepsB };
const SESSION_INVALIDATION: ALSessionInvalidationAuthority = {
    kind: 'auth-session-invalidation',
    sessionId: 'b',
    requestId: 'logout-request-0000001',
    invalidatedAtMs: 1_000,
    issuedAtMs: 1_000,
    expiresAtMs: 61_000
};

function createAuthority(
    frozen: boolean,
    capturedRecipientEligibilityFilters: WsCapturedRecipientEligibilityFilters | undefined,
    timers: Timers = createDefaultBackgroundTimers()
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
        capturedRecipientEligibilityFilters,
        timers
    });
}

function feedEvent(): ALMessage {
    return newALBroadcastMessage({
        createdAtEpochMs: Date.now(),
        senderId: 'a',
        route: newALRoute('room.feed', ROOM.groupId, 'event-1'),
        scope: 'room',
        typeId: 'feed.v1',
        resource: {},
        options: { groupRef: ROOM }
    });
}

describe('the audience one dequeue attempt finds for a row', () => {
    it('names beside the sessions the re-check keeps those it dropped, which the attempt sends nothing', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: ['b', 'd'], dropped: ['c'], judged: true });
    });

    it('sends nobody and declares no exclusion when no re-check is wired: its sessions stay expected', async () => {
        const audience = await createAuthority(true, undefined).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: [], dropped: [], judged: false });
    });

    it('drops a captured session no durable filter finds live, whatever this instance\'s sockets hold', async () => {
        const audience = await createAuthority(false, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: ['b', 'd'], dropped: ['c'], judged: true });
    });

    it('keeps a non-frozen row\'s captured audience when no durable filter is wired', async () => {
        const audience = await createAuthority(false, undefined).readCurrentAudience(feedEvent(), ADMITTED, 'durable');

        expect(audience).toEqual({ eligible: ['b', 'c', 'd'], dropped: [], judged: false });
    });

    it('re-checks a frozen row\'s sessions against this instance\'s sockets at a send, and keeps a non-frozen row\'s as captured', async () => {
        const frozen = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'local');
        const notFrozen = await createAuthority(false, KEEPS_B_AND_D).readCurrentAudience(feedEvent(), ADMITTED, 'local');

        expect(frozen).toEqual({ eligible: ['b'], dropped: ['c', 'd'], judged: true });
        expect(notFrozen).toEqual({ eligible: ['b', 'c', 'd'], dropped: [], judged: false });
    });

    it('admits nobody and drops nobody for a row admitted to no audience', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(
            feedEvent(),
            { ...ADMITTED, admittedAudience: undefined },
            'durable'
        );

        expect(audience).toEqual({ eligible: undefined, dropped: [], judged: false });
    });

    it('passes a session invalidation\'s captured audience through unjudged', async () => {
        const audience = await createAuthority(true, KEEPS_B_AND_D).readCurrentAudience(
            feedEvent(),
            { ...ADMITTED, sessionInvalidation: SESSION_INVALIDATION },
            'durable'
        );

        expect(audience).toEqual({ eligible: ['b', 'c', 'd'], dropped: [], judged: false });
    });

    it('rejects the attempt at the read deadline when the durable re-check never settles, so the row retries', async () => {
        const timers = createManualTimers(1_000);
        const never: WsCapturedRecipientEligibilityFilter = () => new Promise(() => undefined);
        const authority = createAuthority(true, { durable: never, local: keepsB, socket: keepsB }, timers);
        const settlements: string[] = [];

        const read = authority.readCurrentAudience(feedEvent(), ADMITTED, 'durable');
        read.then(() => settlements.push('resolved'), () => settlements.push('rejected'));
        await timers.advance(4_999);
        expect(settlements).toEqual([]);
        await timers.advance(1);

        await expect(read).rejects.toBeInstanceOf(WsCapturedAudienceReadDeadlineError);
        expect(settlements).toEqual(['rejected']);
    });

    it.each(['resolves', 'rejects'] as const)(
        'ignores a re-check that %s after its deadline: the attempt already rejected, and nothing late surfaces',
        async (lateSettlement) => {
            const timers = createManualTimers(1_000);
            let settleLate: () => void = () => undefined;
            const late: WsCapturedRecipientEligibilityFilter = (captured) =>
                new Promise((resolve, reject) => {
                    settleLate = lateSettlement === 'resolves'
                        ? () => resolve(captured.candidateSessionIds)
                        : () => reject(new Error('snapshot probe failed late'));
                });
            const authority = createAuthority(true, { durable: late, local: keepsB, socket: keepsB }, timers);

            const read = authority.readCurrentAudience(feedEvent(), ADMITTED, 'durable');
            await timers.advance(5_000);
            await expect(read).rejects.toBeInstanceOf(WsCapturedAudienceReadDeadlineError);
            settleLate();
            // A late rejection nobody observed would fail the run as unhandled once this macrotask turn ends.
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    );
});
