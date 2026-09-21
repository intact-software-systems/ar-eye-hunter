import { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import type { RallarTypedMessageChannel } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALBroadcastMessage, newALMulticastMessage, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { createDefaultOutboundTestRuntime } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../../shared/alm/outbound-test-payload.ts';

import { BrowserMessageInputValidator } from '@shared-web/browser/messages/browser-message-input-validator.ts';
import { BrowserRallarDeliveryRegistry } from '@shared-web/browser/messages/browser-rallar-delivery-registry.ts';
import { BrowserRallarMessageDispatch } from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import { BrowserRallarMessageSender } from '@shared-web/browser/messages/browser-rallar-message-sender.ts';
import { BrowserSessionDeliveries } from '@shared-web/browser/messages/browser-session-deliveries.ts';
import { BrowserTypedMessageChannels } from '@shared-web/browser/messages/browser-typed-message-channels.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundDispatchPlan, ALOutboundEnqueueResult, ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
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
            const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT, firstDurationMs: 50 });
            const result = await fixture.channel.send({ action: 'ready' }, {
                strategy,
                seq: 7,
                orderingKey: 'ready-order',
                minSnapshotVersion: 9,
                ttlHops: 8
            });

            await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
            expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(
                strategy === 'ws-then-rtc' ? ['ws', 'rtc'] : ['rtc', 'ws']
            );
            const original = fixture.attempts[0].message;
            expect(fixture.attempts[1].message).toEqual(original);
            expect(result.msgId).toBe(original.id.msgId);
            expect(original.targets).toMatchObject({ groupRef: fixture.originalRoom, minSnapshotVersion: 9 });
            expect(original.ordering).toMatchObject({ seq: 7, orderingKey: 'ready-order' });
            expect(original.route.contextId).toBe('room-one');
            expect(original.constraints?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:30Z'));
            expect(result.lifecycle().state).toBe('queued');
            expect(result.lifecycle().evidence.attempts).toMatchObject([{ carrier: strategy === 'ws-then-rtc' ? 'ws' : 'rtc', outcome: 'unroutable' }]);
        }
    );

    it('counts a second attempt only when the fallback carrier really starts it', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT });
        const handle = await fixture.channel.send({ action: 'ready' });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(handle.lifecycle().evidence.attempts).toHaveLength(1);
        fixture.settlements.ws({ kind: 'attempt-started', msgId: handle.msgId, carrier: 'ws', atMs: Date.now(), attemptId: 'ws-attempt' });
        expect(handle.lifecycle().evidence.attempts).toMatchObject([
            { carrier: 'rtc', outcome: 'unroutable' },
            { carrier: 'ws', attemptId: 'ws-attempt' }
        ]);
        expect(handle.lifecycle().state).toBe('queued');
    });

    it('fails a direct RTC no-route send without starting fallback', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT });
        const handle = await fixture.channel.send({ action: 'ready' }, { strategy: 'rtc' });
        expect((await handle.wait()).lifecycle).toMatchObject({ state: 'failed', evidence: { reason: 'no route' } });
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(['rtc']);
    });

    it.each(
        [
            ['expired', 'expired', { kind: 'expired', detail: 'expired' }],
            ['superseded', 'superseded', { kind: 'superseded', detail: 'superseded' }],
            ['skipped', 'failed', { kind: 'skipped', reason: 'planner-drop', detail: 'skipped' }],
            ['failed', 'failed', { kind: 'failed', detail: 'failed' }],
            ['rate-limited', 'failed', { kind: 'unroutable', reason: 'rate-limited', detail: 'rate-limited' }],
            ['accepted', 'queued', { kind: 'admitted', durable: false, queuedAttempts: 1 }],
            ['enqueued', 'queued', { kind: 'admitted', durable: true, queuedAttempts: 1 }],
            ['duplicate', 'accepted', { kind: 'duplicate' }]
        ] satisfies ReadonlyArray<readonly [string, string, ALDeliveryAdmissionVerdict]>
    )(
        'does not try another carrier after %s',
        async (_label, state, verdict) => {
            const fixture = createChannel({ firstVerdict: verdict });
            const result = await fixture.channel.send({ action: 'ready' });
            expect((await result.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe(state);
            expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(['rtc']);
        }
    );

    it.each(['payload', 'identity', 'authority', 'unchanged'] as const)('keeps %s planner output behind ALM validation before fallback', async (change) => {
        const fixture = createChannel({
            firstVerdict: NO_ROUTE_VERDICT,
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
                dropReason: 'No route',
                dropReasonCode: 'no-route'
            })
        });
        const result = await fixture.channel.send({ action: 'ready' });
        expect((await result.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe(change === 'unchanged' ? 'queued' : 'failed');
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(change === 'unchanged' ? ['rtc', 'ws'] : ['rtc']);
        expect(result.msgId).toBe(fixture.attempts[0].message.id.msgId);
    });

    it('stops fallback at the original caller deadline', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT, firstDurationMs: 101 });
        const result = await fixture.channel.send({ action: 'ready' }, { ttlMs: 100 });
        expect((await result.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('expired');
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(['rtc']);
        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(result.lifecycle().expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00Z') + 100);
    });

    it.each([50, 100])('preserves a topic-selected 100ms bound when first admission takes %sms', async (duration) => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT, firstDurationMs: duration, selectedLifetimeMs: 100 });
        const result = await fixture.channel.send({ action: 'ready' }, { ttlMs: 60_000 });
        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(result.lifecycle().expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00Z') + 100);
        expect(fixture.attempts.map((attempt) => attempt.carrier)).toEqual(duration === 100 ? ['rtc'] : ['rtc', 'ws']);
        if (duration === 50) {
            expect(fixture.attempts[1].message.constraints?.expiresAtMs).toBe(result.lifecycle().expiresAtMs);
        }
        expect(fixture.attempts[0].message.constraints?.expiresAtMs).toBe(Date.parse('2026-01-01T00:00:00Z') + 60_000);
    });

    it('does not submit a message whose explicit deadline has already elapsed', async () => {
        const fixture = createChannel({ firstVerdict: ADMITTED_VERDICT });
        const result = await fixture.channel.send({ action: 'ready' }, { ttlMs: 0 });
        expect((await result.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('expired');
        expect(fixture.attempts).toEqual([]);
    });

    it('applies canonical envelope collection limits before either carrier owns work', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT });
        const handle = await fixture.channel.send({ action: 'ready' }, {
            nextHopPeerIds: Array.from({ length: 257 }, (_, index) => `peer-${index}`)
        });
        expect((await handle.wait()).lifecycle).toMatchObject({ state: 'rejected', evidence: { reason: expect.stringContaining('collection') } });
        expect(fixture.attempts).toEqual([]);
    });

    it('preserves excluded recipients on both carriers', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT });
        const handle = await fixture.channel.send({ action: 'ready' }, { exceptPeerIds: ['excluded-peer'] });
        await handle.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(fixture.attempts.map((attempt) => attempt.message.targets)).toEqual([
            expect.objectContaining({ scope: 'room', exceptPeerIds: ['excluded-peer'] }),
            expect.objectContaining({ scope: 'room', exceptPeerIds: ['excluded-peer'] })
        ]);
    });

    it('rejects a fallback strategy that would change a global audience into a room audience', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT });
        await expect(fixture.channel.send({ action: 'ready' }, { strategy: 'ws-then-rtc', scope: 'all' }))
            .rejects.toThrow('$.scope');
        expect(fixture.attempts).toEqual([]);
    });

    it('rejects unsupported membership fencing before trying either carrier', async () => {
        const fixture = createChannel({ firstVerdict: NO_ROUTE_VERDICT });
        await expect(fixture.channel.send({ action: 'ready' }, { membershipEpoch: 2 }))
            .rejects.toThrow('$.membershipEpoch');
        expect(fixture.attempts).toEqual([]);
    });
});

interface ChannelInput {
    readonly firstVerdict: ALDeliveryAdmissionVerdict;
    readonly firstDurationMs?: number;
    readonly selectedLifetimeMs?: number;
    readonly firstPlanner?: (message: ALMessage) => ALOutboundDispatchPlan<never>;
}

/** A fresh durable admission: the shape both the default first attempt and every later attempt settle as. */
const ADMITTED_VERDICT: ALDeliveryAdmissionVerdict = { kind: 'admitted', durable: true, queuedAttempts: 1 };
const NO_ROUTE_VERDICT: ALDeliveryAdmissionVerdict = { kind: 'unroutable', reason: 'no-route', detail: 'no route' };

interface ChannelAttempt {
    readonly carrier: 'rtc' | 'ws';
    readonly message: ALMessage;
}

interface ChannelFixture {
    readonly originalRoom: GroupRef;
    readonly attempts: readonly ChannelAttempt[];
    readonly settlements: BrowserDeliverySettlements.Carriers;
    readonly channel: RallarTypedMessageChannel<{ action: string; }>;
}

function createChannel(input: ChannelInput): ChannelFixture {
    const admission = new ChannelAdmission(input);
    const context = createDefaultApiMiddlewareTestDouble({
        middleware: {
            rtcRxStreamer: { enqueueOutboxIfAbsent: (message) => admission.admit('rtc', message) },
            webSocketQueueBox: { enqueueOutboxIfAbsent: (message) => admission.admit('ws', message) }
        }
    });
    const inputValidator = new BrowserMessageInputValidator({ readMaxPayloadBytes: () => 64 * 1024 });
    const deliveries = new BrowserRallarDeliveryRegistry({ nowMs: Date.now, retainTerminalMs: 60_000, maxEntries: 512, cancel: () => {} });
    const feed = new BrowserDeliverySettlements();
    const sessionDeliveries = new BrowserSessionDeliveries(deliveries, { deliverySettlements: feed, readMiddleware: () => context });
    sessionDeliveries.beginSession(context.session);
    const epoch = feed.open({ ws: sessionDeliveries.settle, rtc: sessionDeliveries.settle });
    const sender = new BrowserRallarMessageSender({
        creation: {
            createUnicast: newALUnicastMessage,
            createMulticast: newALMulticastMessage,
            createBroadcast: newALBroadcastMessage,
            newResourceId: crypto.randomUUID.bind(crypto)
        },
        deliveries,
        dispatch: new BrowserRallarMessageDispatch({ deliveries, sessionDeliveries, nowMs: Date.now }),
        inputValidator,
        connect: async () => context,
        requireSession: () => context.session,
        resolveDefaultRoom: () => admission.currentRoom,
        resolveCurrentRoomRef: () => admission.currentRoom,
        toRoomId: (room) => typeof room === 'string' ? room : room?.groupId,
        resolveRoomRef: (room) => typeof room === 'string' ? { ...admission.originalRoom, groupId: room } : room,
        resolveRoomMinSnapshotVersion: (_room, explicit) => explicit
    });
    const channels = new BrowserTypedMessageChannels({
        inputValidator,
        sender,
        rtc: { onMessage: () => () => {} },
        ws: { onMessage: () => () => {} }
    });
    return {
        originalRoom: admission.originalRoom,
        attempts: admission.attempts,
        settlements: epoch.settlements,
        channel: channels.channel<{ action: string; }>({ topicId: 'room.ready', typeId: 'ready' })
    };
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

class ChannelAdmission {
    readonly originalRoom: GroupRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-one' };
    currentRoom = this.originalRoom;
    readonly attempts: ChannelAttempt[] = [];
    private readonly input: ChannelInput;
    private readonly firstRuntime: ALOutboundMessageRuntime<OutboundTestPayload> | undefined;

    constructor(input: ChannelInput) {
        this.input = input;
        this.firstRuntime = input.firstPlanner
            ? createDefaultOutboundTestRuntime({
                planOutgoingMessage: input.firstPlanner,
                sendPreparedMessage: async () => {
                    throw new Error('No-route planner must not transmit');
                }
            })
            : undefined;
    }

    async admit(carrier: 'rtc' | 'ws', message: ALMessage): Promise<ALOutboundEnqueueResult> {
        freezeMessage(message);
        this.attempts.push({ carrier, message });
        this.currentRoom = { ...this.originalRoom, groupId: 'room-two' };
        vi.setSystemTime(Date.now() + (this.input.firstDurationMs ?? 0));
        if (this.attempts.length === 1 && this.firstRuntime) {
            return await this.firstRuntime.enqueueIfAbsent(message);
        }
        const admitted = this.input.selectedLifetimeMs === undefined || this.attempts.length !== 1 ? message : {
            ...message,
            constraints: { ...message.constraints, expiresAtMs: message.id.ts + this.input.selectedLifetimeMs }
        };
        const verdict = this.attempts.length === 1 ? this.input.firstVerdict : ADMITTED_VERDICT;
        return { verdict, message: admitted, entries: [] };
    }
}
