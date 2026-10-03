import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import {
    AL_WS_CLIENT_CAPABILITIES,
    toALCarrierQosInputProvider
} from '@shared/al-contracts/al-carrier-capabilities.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy, type ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import { computeALOutboundOrderingRefusal } from '@shared/alm/outbound/admission/compute-al-outbound-ordering-refusal.ts';
import { toWsQueueBoxClientDispatchPlan } from '@shared/services/ws-queue-box-client/to-ws-queue-box-client-dispatch-plan.ts';

import {
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain,
    ORIGIN_ROOM
} from '../../multicast/rtc-origin-overlay-fixture.ts';

const WS_CONTEXT = {
    sessionId: 'a',
    serverPeerId: 'server',
    socketOpen: true,
    qosProvider: toALCarrierQosInputProvider(AL_WS_CLIENT_CAPABILITIES, undefined)
};

interface RoomSendInput {
    readonly durability: ALDurabilityAlgo;
    readonly seq?: number;
    readonly orderingKey?: string;
    readonly latestWins?: boolean;
}

function roomSend(resourceId: string, input: RoomSendInput): ALMessage {
    return newALMulticastMessage(
        'a',
        { topicId: 'room.state', resourceId, contextId: 'room' },
        ORIGIN_ROOM,
        'room.state.v1',
        { resourceId },
        {
            ttlMs: 30_000,
            seq: input.seq,
            orderingKey: input.orderingKey,
            qos: {
                durability: { algo: input.durability },
                ...(input.latestWins ? { supersedence: { algo: 'latest-wins' as const } } : {})
            }
        }
    );
}

describe('the checkpointed tier refuses a client sequence', () => {
    it('refuses a local-checkpoint send that carries a seq as unsupported, kept in memory', () => {
        const msg = roomSend('sequenced', { durability: 'local-checkpoint', seq: 4 });

        const refusal = computeALOutboundOrderingRefusal({ msg, policy: normalizeALQosPolicy(msg) });

        expect(refusal.left).toMatchObject({
            msg,
            dropReasonCode: 'unsupported',
            lane: 'volatile',
            preparedMessages: []
        });
        expect(refusal.left?.dropReason).toContain('local-checkpoint');
    });

    it.each([
        { name: 'an ordering key alone', input: { durability: 'local-checkpoint' as const, orderingKey: 'track' } },
        { name: 'latest-wins supersedence', input: { durability: 'local-checkpoint' as const, latestWins: true } },
        { name: 'a seq on local-outbox', input: { durability: 'local-outbox' as const, seq: 4 } },
        { name: 'a seq on volatile', input: { durability: 'volatile' as const, seq: 4 } }
    ])('passes $name', ({ input }) => {
        const msg = roomSend('passes', input);

        const refusal = computeALOutboundOrderingRefusal({ msg, policy: normalizeALQosPolicy(msg) });

        expect(refusal.right).toBe(msg);
    });
});

describe('the WS client plan of a checkpointed send', () => {
    it('names the checkpoint lane for a room send with only its default ordering key', () => {
        const plan = toWsQueueBoxClientDispatchPlan(roomSend('room-send', { durability: 'local-checkpoint' }), WS_CONTEXT);

        expect(plan.dropReasonCode).toBeUndefined();
        expect(plan.lane).toBe('checkpoint');
        expect(plan.preparedMessages).toHaveLength(1);
    });

    it('refuses a sequenced send before it plans a copy', () => {
        const plan = toWsQueueBoxClientDispatchPlan(
            roomSend('sequenced', { durability: 'local-checkpoint', seq: 1 }),
            WS_CONTEXT
        );

        expect(plan).toMatchObject({ dropReasonCode: 'unsupported', lane: 'volatile', preparedMessages: [] });
    });
});

describe('the RTC origin plan of a checkpointed send', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('admits a room send that carries only the default ordering key', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b']
        });
        const message = roomSend('room-send', { durability: 'local-checkpoint' });

        const admitted = await enqueueAndDrain(fixture.manager, message);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(fixture.channels.b!.sent.map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
    });

    it('refuses a sequenced room send as unsupported and sends nothing', async () => {
        const fixture = createRtcOriginOverlayFixture({
            snapshot: createOriginSnapshot(['a', 'b'], 1),
            nextHopPeerIds: ['b']
        });

        const refused = await enqueueAndDrain(
            fixture.manager,
            roomSend('sequenced', { durability: 'local-checkpoint', seq: 1 })
        );

        expect(refused.verdict).toEqual({
            kind: 'refused',
            reason: 'unsupported',
            detail: 'A local-checkpoint send cannot carry sequence 1'
        });
        expect(fixture.channels.b!.sent).toEqual([]);
    });
});
