import type {
    RallarMessage,
    RallarMessageSelectorInput,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarRtcStatus,
    RallarTypedMessageSendOptions,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions,
    RallarWsSendInput
} from '@shared-web/browser/rallar.ts';
import { RallarGameAuthorityClient, type RallarGameAuthorityClientConfig, type RallarGameAuthorityClientRallarFacade } from '@shared-web/game/mod.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthorityEnvelope,
    type RallarGameAuthorityCommandResult,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';
import { describe, expect, it, vi } from 'vitest';

type Command = Readonly<{ action: string; }>;
type Snapshot = Readonly<{ tick: number; }>;
type Event = Readonly<{ kind: string; }>;
type Presence = Readonly<{ x: number; }>;

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

const authority: RallarGameAuthorityRef = {
    kind: 'server',
    id: 'server-1',
    epoch: 1
};

describe('Rallar Game Authority browser client', () => {
    it('subscribes to expected WS and RTC surfaces on start', async () => {
        const fake = createFakeRallar();
        const client = createClient(fake);

        await client.start();

        expect(fake.roomChangeHandlers).toHaveLength(1);
        expect(fake.rtcStatusHandlers).toHaveLength(1);
        expect(fake.wsMessageHandlers.map((sub) => sub.selector)).toEqual([
            { topicId: 'game.authority', typeId: 'game.authority.command-result.v1' },
            { topicId: 'game.authority', typeId: 'game.authority.snapshot.v1' },
            { topicId: 'game.authority', typeId: 'game.authority.event.v1' }
        ]);
        expect(fake.rtcMessageHandlers.map((sub) => sub.selector)).toEqual([
            { topicId: 'game.authority', typeId: 'game.authority.snapshot.v1' },
            { topicId: 'game.authority', typeId: 'game.authority.presence.v1' }
        ]);
    });

    it('sends commands as room-scoped WS authority envelopes', async () => {
        const fake = createFakeRallar();
        const client = createClient(fake);
        await client.start();

        const result = await client.sendCommand({ action: 'dash' }, {
            key: 'command:peer-a'
        });

        expect(result).toMatchObject({
            status: 'sent',
            transport: 'ws',
            seq: 1
        });
        expect(client.status().pendingCommandCount).toBe(1);
        expect(fake.wsSend).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'game.authority',
                typeId: 'game.authority.command.v1',
                scope: 'room',
                roomRef,
                reliability: 'at-least-once',
                ack: 'receiver',
                resourceId: 'command:peer-a'
            })
        );
        expect(fake.wsSend.mock.calls[0][0].payload).toMatchObject({
            protocol: 'test.authority.v1',
            kind: 'command',
            roomId: 'room-1',
            senderId: 'peer-a',
            authority,
            payload: { action: 'dash' }
        });
    });

    it('accepts server WS snapshots and events after envelope checks', async () => {
        const fake = createFakeRallar();
        const onSnapshot = vi.fn();
        const onEvent = vi.fn();
        const client = createClient(fake, { onSnapshot, onEvent });
        await client.start();

        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            {
                ...envelope('snapshot', 'server-1', { tick: 1 }, 1),
                protocol: 'wrong.protocol'
            }
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            envelope('snapshot', 'server-1', { tick: 2 }, 2)
        );
        await fake.emitWs(
            'game.authority.event.v1',
            'server-1',
            envelope('event', 'server-1', { kind: 'cash-picked' }, 1)
        );

        expect(onSnapshot).toHaveBeenCalledTimes(1);
        expect(onSnapshot.mock.calls[0][0].payload).toEqual({ tick: 2 });
        expect(onEvent).toHaveBeenCalledTimes(1);
        expect(onEvent.mock.calls[0][0].payload).toEqual({ kind: 'cash-picked' });
        expect(client.diagnostics().issues).not.toContain('stale-authority');
    });

    it('rejects wrong authority and duplicate sequences before handlers run', async () => {
        const fake = createFakeRallar();
        const onSnapshot = vi.fn();
        const client = createClient(fake, { onSnapshot });
        await client.start();

        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-2',
            {
                ...envelope('snapshot', 'server-2', { tick: 1 }, 1),
                authority: { ...authority, id: 'server-2' }
            }
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 1 }, 1)
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            envelope('snapshot', 'server-1', { tick: 2 }, 2)
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            envelope('snapshot', 'server-1', { tick: 3 }, 2)
        );

        expect(onSnapshot).toHaveBeenCalledTimes(1);
        expect(onSnapshot.mock.calls[0][0].payload).toEqual({ tick: 2 });
    });

    it('clears pending command diagnostics when command-result arrives', async () => {
        const fake = createFakeRallar();
        const onCommandResult = vi.fn();
        const client = createClient(fake, { onCommandResult });
        await client.start();

        const command = await client.sendCommand({ action: 'jump' });
        expect(client.status().pendingCommandCount).toBe(1);

        await fake.emitWs(
            'game.authority.command-result.v1',
            'server-1',
            envelope<RallarGameAuthorityCommandResult>(
                'command-result',
                'server-1',
                { commandSeq: command.seq ?? 0, status: 'accepted' },
                1
            )
        );

        expect(client.status().pendingCommandCount).toBe(0);
        expect(client.diagnostics().issues).not.toContain('pending-commands');
        expect(onCommandResult).toHaveBeenCalledTimes(1);
    });

    it('ignores RTC snapshot repair by default', async () => {
        const fake = createFakeRallar();
        const onSnapshot = vi.fn();
        const client = createClient(fake, { onSnapshot });
        await client.start();

        await fake.emitRtc(
            'game.authority.snapshot.v1',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 1 }, 1)
        );

        expect(onSnapshot).not.toHaveBeenCalled();
    });

    it('accepts RTC snapshot repair only when enabled and app-approved', async () => {
        const fake = createFakeRallar();
        const onSnapshot = vi.fn();
        const acceptSnapshotRepair = vi.fn(async () => true);
        const client = createClient(fake, {
            onSnapshot,
            peerAssist: {
                snapshotRepair: true,
                acceptSnapshotRepair
            }
        });
        await client.start();

        await fake.emitRtc(
            'game.authority.snapshot.v1',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 5 }, 1)
        );

        expect(acceptSnapshotRepair).toHaveBeenCalledTimes(1);
        expect(onSnapshot).toHaveBeenCalledTimes(1);
        expect(onSnapshot.mock.calls[0][0].payload).toEqual({ tick: 5 });
        expect(client.status().peerAssist.snapshotRepairEnabled).toBe(true);
    });

    it('stops subscriptions and prevents later callbacks', async () => {
        const fake = createFakeRallar();
        const onEvent = vi.fn();
        const client = createClient(fake, { onEvent });
        await client.start();

        client.stop();
        await fake.emitWs(
            'game.authority.event.v1',
            'server-1',
            envelope('event', 'server-1', { kind: 'late' }, 1)
        );

        expect(client.status()).toMatchObject({
            phase: 'stopped',
            stopped: true
        });
        expect(onEvent).not.toHaveBeenCalled();
        expect(fake.wsMessageHandlers).toHaveLength(0);
        expect(fake.rtcMessageHandlers).toHaveLength(0);
    });
});

function createClient(
    fake: ReturnType<typeof createFakeRallar>,
    overrides: Partial<RallarGameAuthorityClientConfig<Command, Snapshot, Event, Presence>> = {}
) {
    return new RallarGameAuthorityClient<Command, Snapshot, Event, Presence>({
        rallar: fake.rallar,
        protocol: 'test.authority.v1',
        topicId: 'game.authority',
        authority,
        ...overrides
    });
}

function envelope<T>(
    kind: RallarGameAuthorityEnvelope<T>['kind'],
    senderId: string,
    payload: T,
    seq: number
): RallarGameAuthorityEnvelope<T> {
    return createRallarGameAuthorityEnvelope({
        protocol: 'test.authority.v1',
        kind,
        roomId: 'room-1',
        senderId,
        seq,
        sentAtEpochMs: 1_000 + seq,
        authority,
        payload
    });
}

function createFakeRallar() {
    const roomChangeHandlers: Array<(state: unknown) => void | Promise<void>> = [];
    const rtcStatusHandlers: Array<(status: RallarRtcStatus) => void | Promise<void>> = [];
    const wsMessageHandlers: Array<MessageSubscription> = [];
    const rtcMessageHandlers: Array<MessageSubscription> = [];
    const session = {
        clientId: 'principal-a',
        sessionId: 'peer-a',
        username: 'alice',
        accessToken: 'token',
        expiresAtEpochMs: Date.now() + 60_000
    };
    const roomState = {
        rooms: [],
        currentRoomId: 'room-1',
        currentRoomRef: roomRef,
        members: []
    };
    const rtcStatus: RallarRtcStatus = {
        sessionId: 'peer-a',
        laneId: 'game-snapshot',
        knownPeerIds: ['peer-b'],
        activePeerIds: ['peer-b'],
        peerIdsWithNoReconnectableLanes: [],
        readyPeerIds: ['peer-b'],
        peers: []
    };
    const wsSend = vi.fn(async (input: RallarWsSendInput<unknown>) => ({
        transport: 'ws' as const,
        status: 'enqueued' as const,
        message: input,
        entries: []
    }));
    const rtcSend = vi.fn(async (input: RallarRtcSendInput<unknown>) => ({
        transport: 'rtc' as const,
        status: 'enqueued' as const,
        message: input,
        entries: []
    }));

    const fake = {
        roomChangeHandlers,
        rtcStatusHandlers,
        wsMessageHandlers,
        rtcMessageHandlers,
        wsSend,
        rtcSend,
        rallar: {
            session: () => session,
            subscriptions: createSubscriptionScope,
            rooms: {
                state: () => roomState,
                onChange: (handler: (state: unknown) => void | Promise<void>) => {
                    roomChangeHandlers.push(handler);
                    return () => remove(roomChangeHandlers, handler);
                }
            },
            rtc: {
                status: () => rtcStatus,
                onStatus: (handler: (status: RallarRtcStatus) => void | Promise<void>) => {
                    rtcStatusHandlers.push(handler);
                    return () => remove(rtcStatusHandlers, handler);
                }
            },
            messages: {
                ws: {
                    send: wsSend,
                    onMessage: (
                        selector: RallarMessageSelectorInput,
                        handler: (message: RallarMessage<unknown>) => void | Promise<void>
                    ) => {
                        const subscription = { selector, handler };
                        wsMessageHandlers.push(subscription);
                        return () => remove(wsMessageHandlers, subscription);
                    }
                },
                rtc: {
                    send: rtcSend,
                    onMessage: (
                        selector: RallarMessageSelectorInput,
                        handler: (message: RallarMessage<unknown>) => void | Promise<void>
                    ) => {
                        const subscription = { selector, handler };
                        rtcMessageHandlers.push(subscription);
                        return () => remove(rtcMessageHandlers, subscription);
                    }
                },
                room: (definition: RallarRoomMessageChannelDefinition) => ({
                    send: async (
                        payload: unknown,
                        options: RallarTypedMessageSendOptions<unknown> = {}
                    ) => {
                        const input = { ...definition, ...options, payload };
                        return await rtcSend(input);
                    },
                    sendRtc: async (
                        payload: unknown,
                        options: RallarTypedRtcSendOptions<unknown> = {}
                    ) => await rtcSend({
                        ...definition,
                        ...options,
                        payload
                    }),
                    sendWs: async (
                        payload: unknown,
                        options: RallarTypedWsSendOptions<unknown> = {}
                    ) => await wsSend({
                        ...definition,
                        ...options,
                        payload,
                        scope: options.scope ?? 'room'
                    }),
                    onRtc: (
                        handler: (payload: unknown, message: RallarMessage<unknown>) => void | Promise<void>
                    ) => {
                        const subscription = {
                            selector: definition,
                            handler: async (message: RallarMessage<unknown>) => await handler(message.payload, message)
                        };
                        rtcMessageHandlers.push(subscription);
                        return () => remove(rtcMessageHandlers, subscription);
                    },
                    onWs: (
                        handler: (payload: unknown, message: RallarMessage<unknown>) => void | Promise<void>
                    ) => {
                        const subscription = {
                            selector: definition,
                            handler: async (message: RallarMessage<unknown>) => await handler(message.payload, message)
                        };
                        wsMessageHandlers.push(subscription);
                        return () => remove(wsMessageHandlers, subscription);
                    }
                })
            }
        } as unknown as RallarGameAuthorityClientRallarFacade,
        async emitWs<T>(
            typeId: string,
            senderId: string,
            payload: RallarGameAuthorityEnvelope<T>
        ) {
            await emit(wsMessageHandlers, message('ws', typeId, senderId, payload));
        },
        async emitRtc<T>(
            typeId: string,
            senderId: string,
            payload: RallarGameAuthorityEnvelope<T>
        ) {
            await emit(rtcMessageHandlers, message('rtc', typeId, senderId, payload));
        }
    };

    return fake;
}

type MessageSubscription = Readonly<{
    selector: RallarMessageSelectorInput;
    handler: (message: RallarMessage<unknown>) => void | Promise<void>;
}>;

async function emit<T>(
    subscriptions: readonly MessageSubscription[],
    message: RallarMessage<T>
): Promise<void> {
    await Promise.all(
        subscriptions
            .filter((subscription) => selectorMatches(subscription.selector, message.typeId))
            .map((subscription) => subscription.handler(message))
    );
}

function selectorMatches(
    selector: RallarMessageSelectorInput,
    typeId: string
): boolean {
    return typeof selector === 'string' ? selector === typeId : selector.typeId === typeId;
}

function message<T>(
    transport: RallarMessage<T>['transport'],
    typeId: string,
    senderId: string,
    payload: T
): RallarMessage<T> {
    return {
        transport,
        typeId,
        topicId: 'game.authority',
        contextId: 'room-1',
        resourceId: 'resource-1',
        roomId: 'room-1',
        senderId,
        payload,
        raw: {} as RallarMessage<T>['raw'],
        receivedAtEpochMs: Date.now()
    };
}

function createSubscriptionScope() {
    const unsubscribes: Array<() => void> = [];
    return {
        add(unsubscribe?: (() => void) | null) {
            if (unsubscribe) {
                unsubscribes.push(unsubscribe);
            }
            return this;
        },
        unsubscribe() {
            while (unsubscribes.length > 0) {
                unsubscribes.pop()?.();
            }
        },
        size() {
            return unsubscribes.length;
        }
    };
}

function remove<T>(values: T[], value: T): void {
    const index = values.indexOf(value);
    if (index >= 0) {
        values.splice(index, 1);
    }
}
