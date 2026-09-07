import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createDefaultOutboundTestRuntime } from '../../shared/alm/outbound-runtime-test-fixture.ts';

import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundDispatchPlan, ALOutboundEnqueueStatus } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => vi.useRealTimers());

describe('typed message fallback identity', () => {
    it.each(['rtc-with-ws-fallback', 'ws-then-rtc'] as const)(
        'preserves the complete envelope across %s after the current room changes',
        async (strategy) => {
            const fixture = createChannel({ firstStatus: 'no-route', firstDurationMs: 50 });
            const result = await fixture.channel.send({ action: 'ready' }, {
                strategy,
                seq: 7,
                orderingKey: 'ready-order',
                minSnapshotVersion: 9,
                ttlHops: 8
            });

            expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(
                strategy === 'ws-then-rtc' ? ['ws', 'rtc'] : ['rtc', 'ws']
            );
            const original = fixture.attempts[0].message;
            expect(fixture.attempts[1].message).toEqual(original);
            expect(result.message).toEqual(original);
            expect(original.targets).toMatchObject({ groupRef: fixture.originalRoom, minSnapshotVersion: 9 });
            expect(original.ordering).toMatchObject({ seq: 7, orderingKey: 'ready-order' });
            expect(original.route.contextId).toBe('room-one');
            expect(original.constraints?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:30Z'));
            expect(result.status).toBe('enqueued');
        }
    );

    it.each(['expired', 'superseded', 'skipped', 'failed', 'rate-limited', 'accepted', 'enqueued', 'duplicate'] as const)(
        'does not try another carrier after %s',
        async (status) => {
            const fixture = createChannel({ firstStatus: status });
            const result = await fixture.channel.send({ action: 'ready' });
            expect(result.status).toBe(status);
            expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(['rtc']);
        }
    );

    it.each(['payload', 'identity', 'authority', 'unchanged'] as const)('keeps %s planner output behind ALM validation before fallback', async (change) => {
        const fixture = createChannel({
            firstStatus: 'no-route',
            firstDurationMs: 0,
            selectedLifetimeMs: undefined,
            firstPlanner: (msg) => ({
                msg: change === 'payload'
                    ? { ...msg, payload: { ...msg.payload, resource: '{"changed":true}' } }
                    : change === 'identity'
                    ? { ...msg, id: { ...msg.id, msgId: 'changed' } }
                    : change === 'authority'
                    ? { ...msg, targets: { mode: 'unicast', toPeerId: 'changed' } }
                    : msg,
                persist: false,
                preparedMessages: [],
                dropReason: 'No route'
            })
        });
        const result = await fixture.channel.send({ action: 'ready' });
        expect(result.status).toBe(change === 'unchanged' ? 'enqueued' : 'failed');
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(change === 'unchanged' ? ['rtc', 'ws'] : ['rtc']);
        expect(result.message).toEqual(fixture.attempts[0].message);
    });

    it('stops fallback at the original caller deadline', async () => {
        const fixture = createChannel({ firstStatus: 'no-route', firstDurationMs: 101 });
        const result = await fixture.channel.send({ action: 'ready' }, { ttlMs: 100 });
        expect(result.status).toBe('expired');
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(['rtc']);
        expect(result.message.constraints?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00Z') + 100);
    });

    it.each([50, 100])('preserves a topic-selected 100ms bound when first admission takes %sms', async (duration) => {
        const fixture = createChannel({ firstStatus: 'no-route', firstDurationMs: duration, selectedLifetimeMs: 100 });
        const result = await fixture.channel.send({ action: 'ready' }, { ttlMs: 60_000 });
        expect(result.message.constraints?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00Z') + 100);
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(duration === 100 ? ['rtc'] : ['rtc', 'ws']);
        if (duration === 50) {
            expect(fixture.attempts[1].message.constraints?.expiresAtMs).toBe(result.message.constraints?.expiresAtMs);
        }
        expect(fixture.attempts[0].message.constraints?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00Z') + 60_000);
    });

    it('does not submit a message whose explicit deadline has already elapsed', async () => {
        const fixture = createChannel({ firstStatus: 'enqueued' });
        const result = await fixture.channel.send({ action: 'ready' }, { ttlMs: 0 });
        expect(result.status).toBe('expired');
        expect(fixture.attempts).toEqual([]);
    });

    it('applies canonical envelope collection limits before either carrier owns work', async () => {
        const fixture = createChannel({ firstStatus: 'no-route' });
        await expect(fixture.channel.send({ action: 'ready' }, {
            nextHopPeerIds: Array.from({ length: 257 }, (_, index) => `peer-${index}`)
        })).rejects.toThrow('collection');
        expect(fixture.attempts).toEqual([]);
    });

    it('preserves excluded recipients on both carriers', async () => {
        const fixture = createChannel({ firstStatus: 'no-route' });
        await fixture.channel.send({ action: 'ready' }, { exceptPeerIds: ['excluded-peer'] });
        expect(fixture.attempts.map((attempt) => attempt.message.targets)).toEqual([
            expect.objectContaining({ scope: 'room', exceptPeerIds: ['excluded-peer'] }),
            expect.objectContaining({ scope: 'room', exceptPeerIds: ['excluded-peer'] })
        ]);
    });

    it('rejects a fallback strategy that would change a global audience into a room audience', async () => {
        const fixture = createChannel({ firstStatus: 'no-route' });
        await expect(fixture.channel.send({ action: 'ready' }, { strategy: 'ws-then-rtc', scope: 'all' }))
            .rejects.toThrow('$.scope');
        expect(fixture.attempts).toEqual([]);
    });

    it('rejects unsupported membership fencing before trying either carrier', async () => {
        const fixture = createChannel({ firstStatus: 'no-route' });
        await expect(fixture.channel.send({ action: 'ready' }, { membershipEpoch: 2 }))
            .rejects.toThrow('$.membershipEpoch');
        expect(fixture.attempts).toEqual([]);
    });
});

interface ChannelInput {
    readonly firstStatus: ALOutboundEnqueueStatus;
    readonly firstDurationMs?: number;
    readonly selectedLifetimeMs?: number;
    readonly firstPlanner?: (message: ALMessage) => ALOutboundDispatchPlan<never>;
}

function createChannel(input: ChannelInput) {
    const { firstStatus, firstDurationMs = 0, selectedLifetimeMs, firstPlanner } = input;
    const firstRuntime = firstPlanner
        ? createDefaultOutboundTestRuntime({
            planOutgoingMessage: firstPlanner,
            sendPreparedMessage: async () => {
                throw new Error('No-route planner must not transmit');
            }
        })
        : undefined;
    const originalRoom: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-one' };
    let currentRoom = originalRoom;
    const attempts: { readonly carrier: string; readonly message: ALMessage; }[] = [];
    const admit = async (carrier: string, message: ALMessage) => {
        freezeMessage(message);
        attempts.push({ carrier, message });
        currentRoom = { ...originalRoom, groupId: 'room-two' };
        vi.setSystemTime(Date.now() + firstDurationMs);
        if (attempts.length === 1 && firstRuntime) {
            return await firstRuntime.enqueueIfAbsent(message);
        }
        const admitted = selectedLifetimeMs === undefined || attempts.length !== 1 ? message : {
            ...message,
            constraints: { ...message.constraints, expiresAtMs: message.id.ts + selectedLifetimeMs }
        };
        return { status: attempts.length === 1 ? firstStatus : 'enqueued' as const, message: admitted, entries: [] };
    };
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: {
            rtcRxStreamer: { enqueueOutboxIfAbsent: (message) => admit('rtc', message) },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => admit('ws', message) }
        }
    });
    const inputValidator = new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 });
    const sender = new BrowserRallarMessageSender({
        inputValidator,
        connect: async () => context,
        requireSession: () => context.session,
        resolveDefaultRoom: () => currentRoom,
        resolveCurrentRoomRef: () => currentRoom,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: (room) => typeof room === 'string' ? { ...originalRoom, groupId: room } : room,
        resolveRoomMinSnapshotVersion: (_room, explicit) => explicit
    });
    const channels = new BrowserTypedMessageChannels({
        inputValidator,
        sender,
        rtc: { onMessage: () => () => {} },
        ws: { onMessage: () => () => {} }
    });
    return { originalRoom, attempts, channel: channels.channel<{ action: string; }>({ topicId: 'room.ready', typeId: 'ready' }) };
}

function freezeMessage(message: ALMessage): void {
    Object.freeze(message.id);
    Object.freeze(message.route);
    Object.freeze(message.payload);
    Object.freeze(message.constraints);
    Object.freeze(message.ordering);
    Object.freeze(message.delivery);
    Object.freeze(message.forwarding);
    if (message.targets?.mode === 'multicast' || message.targets?.mode === 'broadcast') {
        Object.freeze(message.targets.groupRef);
    }
    Object.freeze(message.targets);
    Object.freeze(message);
}
