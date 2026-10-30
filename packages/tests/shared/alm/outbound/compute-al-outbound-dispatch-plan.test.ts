import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { newALBroadcastMessage, newALEventRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPlanningAuthority } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import type { ALStoredOutboundMessage } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { computeALOutboundDispatchPlan } from '@shared/alm/outbound/admission/compute-al-outbound-dispatch-plan.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const CANONICAL_KEY: Key = { topicId: 'AL_OUTBOUND_MESSAGE', resourceId: 'canonical', contextId: 'room' };

describe('the dispatch plan of a dequeued row whose authority re-checked its audience (D498)', () => {
    it('hands the planner the captured audience narrowed by the re-check and keeps the captured audience and receipt on the plan', () => {
        const message = roomMessage();
        const planned: (ALOutboundPlanningAuthority | undefined)[] = [];

        const plan = computeALOutboundDispatchPlan(
            {
                msg: message,
                intent: 'dequeue',
                observedCanonicalEntry: {
                    ...QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant()),
                    key: CANONICAL_KEY
                },
                dequeueAuthority: { admittedAudience: ['carol', 'bob'], recipientScope: undefined },
                planner: (msg, authority) => {
                    planned.push(authority);
                    return { msg, lane: 'durable', dropReasonCode: undefined, preparedMessages: [], admittedConnectionGenerationIds: undefined };
                }
            },
            undefined,
            storedMessage(message, CANONICAL_KEY)
        );

        expect(planned.map((authority) => authority?.admittedAudience)).toEqual([['bob', 'carol']]);
        expect(plan.admittedAudience).toEqual(['alice', 'bob', 'carol']);
        expect(plan.ackTracking?.expectedPeerIds).toEqual(['alice', 'bob', 'carol']);
    });

    it('leaves the captured audience whole when the authority was read for another row', () => {
        const message = roomMessage();
        const planned: (ALOutboundPlanningAuthority | undefined)[] = [];
        const otherKey: Key = { ...CANONICAL_KEY, resourceId: 'direct-row' };

        computeALOutboundDispatchPlan(
            {
                msg: message,
                intent: 'dequeue',
                observedCanonicalEntry: { ...QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.WS_OUTBOX, Temporal.Now.instant()), key: otherKey },
                dequeueAuthority: { admittedAudience: ['bob'], recipientScope: undefined },
                planner: (msg, authority) => {
                    planned.push(authority);
                    return { msg, lane: 'durable', dropReasonCode: undefined, preparedMessages: [], admittedConnectionGenerationIds: undefined };
                }
            },
            undefined,
            storedMessage(message, CANONICAL_KEY)
        );

        expect(planned.map((authority) => authority?.admittedAudience)).toEqual([['alice', 'bob', 'carol']]);
    });
});

function roomMessage(): ALMessage {
    return newALBroadcastMessage('server', newALEventRoute('room.feed', ROOM.groupId, 'planned'), 'room', 'feed.v1', {}, {
        groupRef: ROOM,
        ttlMs: 30_000
    });
}

/** A sent admission whose captured policy admitted Alice, Bob and Carol and expects each one's receipt. */
function storedMessage(message: ALMessage, key: Key): ALStoredOutboundMessage {
    return {
        msgId: message.id.msgId,
        reference: {
            key,
            typeId: message.payload.typeId,
            scope: 'room-scope',
            msgId: message.id.msgId,
            senderId: message.id.senderId,
            identity: 'identity',
            expiresAtMs: Date.now() + 30_000
        },
        supersedenceKey: undefined,
        unicastPeerId: null,
        orderingTrackKey: null,
        orderingSeq: null,
        policy: {
            persist: true,
            ackTracking: {
                enabled: true,
                timeoutMs: 2_000,
                maxAttempts: 3,
                expectedPeerIds: ['alice', 'bob', 'carol'],
                nextHopPeerIds: ['alice', 'bob', 'carol'],
                mode: 'receiver'
            },
            retryTracking: null,
            repairTracking: null,
            supersedenceTracking: null,
            admittedAudience: ['alice', 'bob', 'carol']
        },
        creationExpiry: new Date(Date.now() + 30_000).toISOString()
    };
}
