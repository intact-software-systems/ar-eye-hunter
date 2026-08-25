import type { RallarMessagePayload } from '@shared-web/browser/rallar-message-contracts.ts';
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
import {
    createRallarAuthorityBrowserMatch,
    RallarGameAuthorityClient,
    type RallarGameAuthorityClientConfig,
    type RallarGameAuthorityClientRallarFacade
} from '@shared-web/game/mod.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import {
    createRallarGameAuthorityEnvelope,
    type RallarGameAuthorityCommandResult,
    type RallarGameAuthorityEnvelope,
    type RallarGameAuthorityRef
} from '@shared/rallar-game/mod.ts';
import { describe, expect, it } from 'vitest';

interface Command {
    readonly action: string;
}

interface Snapshot {
    readonly tick: number;
}

interface Event {
    readonly kind: string;
}

interface Presence {
    readonly x: number;
}

interface AuthorityEnvelopeFixtureInput<T> {
    readonly kind: RallarGameAuthorityEnvelope<T>['kind'];
    readonly senderId: string;
    readonly payload: T;
    readonly seq: number;
}

interface AuthorityMessageFixtureInput<T> {
    readonly transport: RallarMessage<T>['transport'];
    readonly typeId: string;
    readonly senderId: string;
    readonly payload: T;
}

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
        expect(fake.wsSends).toEqual([
            expect.objectContaining({
                topicId: 'game.authority',
                typeId: 'game.authority.command.v1',
                scope: 'room',
                roomRef,
                reliability: 'at-least-once',
                ack: 'receiver',
                resourceId: 'command:peer-a',
                payload: expect.objectContaining({
                    protocol: 'test.authority.v1',
                    kind: 'command',
                    roomId: 'room-1',
                    senderId: 'peer-a',
                    authority,
                    payload: { action: 'dash' }
                })
            })
        ]);
    });

    it('accepts server WS snapshots and events after envelope checks', async () => {
        const fake = createFakeRallar();
        const snapshots: RallarGameAuthorityEnvelope<Snapshot>[] = [];
        const events: RallarGameAuthorityEnvelope<Event>[] = [];
        const client = createClient(fake, {
            onSnapshot: (snapshot) => {
                snapshots.push(snapshot);
            },
            onEvent: (event) => {
                events.push(event);
            }
        });
        await client.start();

        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            {
                ...envelope({ kind: 'snapshot', senderId: 'server-1', payload: { tick: 1 }, seq: 1 }),
                protocol: 'wrong.protocol'
            }
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            envelope({ kind: 'snapshot', senderId: 'server-1', payload: { tick: 2 }, seq: 2 })
        );
        await fake.emitWs(
            'game.authority.event.v1',
            'server-1',
            envelope({ kind: 'event', senderId: 'server-1', payload: { kind: 'cash-picked' }, seq: 1 })
        );

        expect(snapshots.map((snapshot) => snapshot.payload)).toEqual([{ tick: 2 }]);
        expect(events.map((event) => event.payload)).toEqual([{ kind: 'cash-picked' }]);
        expect(client.diagnostics().issues).not.toContain('stale-authority');
    });

    it('rejects wrong authority and duplicate sequences before handlers run', async () => {
        const fake = createFakeRallar();
        const snapshots: RallarGameAuthorityEnvelope<Snapshot>[] = [];
        const client = createClient(fake, {
            onSnapshot: (snapshot) => {
                snapshots.push(snapshot);
            }
        });
        await client.start();

        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-2',
            {
                ...envelope({ kind: 'snapshot', senderId: 'server-2', payload: { tick: 1 }, seq: 1 }),
                authority: { ...authority, id: 'server-2' }
            }
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'peer-b',
            envelope({ kind: 'snapshot', senderId: 'peer-b', payload: { tick: 1 }, seq: 1 })
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            envelope({ kind: 'snapshot', senderId: 'server-1', payload: { tick: 2 }, seq: 2 })
        );
        await fake.emitWs(
            'game.authority.snapshot.v1',
            'server-1',
            envelope({ kind: 'snapshot', senderId: 'server-1', payload: { tick: 3 }, seq: 2 })
        );

        expect(snapshots.map((snapshot) => snapshot.payload)).toEqual([{ tick: 2 }]);
    });

    it('clears pending command diagnostics when command-result arrives', async () => {
        const fake = createFakeRallar();
        const commandResults: RallarGameAuthorityEnvelope<RallarGameAuthorityCommandResult>[] = [];
        const client = createClient(fake, {
            onCommandResult: (commandResult) => {
                commandResults.push(commandResult);
            }
        });
        await client.start();

        const command = await client.sendCommand({ action: 'jump' });
        expect(client.status().pendingCommandCount).toBe(1);

        await fake.emitWs(
            'game.authority.command-result.v1',
            'server-1',
            envelope<RallarGameAuthorityCommandResult>({
                kind: 'command-result',
                senderId: 'server-1',
                payload: { commandSeq: command.seq ?? 0, status: 'accepted' },
                seq: 1
            })
        );

        expect(client.status().pendingCommandCount).toBe(0);
        expect(client.diagnostics().issues).not.toContain('pending-commands');
        expect(commandResults.map((commandResult) => commandResult.payload)).toEqual([
            { commandSeq: command.seq, status: 'accepted' }
        ]);
    });

    it('ignores RTC snapshot repair by default', async () => {
        const fake = createFakeRallar();
        const client = createClient(fake, {
            onSnapshot: () => {
                throw new Error('RTC snapshot repair must remain disabled by default.');
            }
        });
        await client.start();

        await fake.emitRtc(
            'game.authority.snapshot.v1',
            'peer-b',
            envelope({ kind: 'snapshot', senderId: 'peer-b', payload: { tick: 1 }, seq: 1 })
        );

        expect(client.status().peerAssist.snapshotRepairEnabled).toBe(false);
    });

    it('accepts RTC snapshot repair only when enabled and app-approved', async () => {
        const fake = createFakeRallar();
        const repairRequests: RallarGameAuthorityEnvelope<Snapshot>[] = [];
        const snapshots: RallarGameAuthorityEnvelope<Snapshot>[] = [];
        const client = createClient(fake, {
            onSnapshot: (snapshot) => {
                snapshots.push(snapshot);
            },
            peerAssist: {
                snapshotRepair: true,
                acceptSnapshotRepair: async (snapshot) => {
                    repairRequests.push(snapshot);
                    return true;
                }
            }
        });
        await client.start();

        await fake.emitRtc(
            'game.authority.snapshot.v1',
            'peer-b',
            envelope({ kind: 'snapshot', senderId: 'peer-b', payload: { tick: 5 }, seq: 1 })
        );

        expect(repairRequests.map((snapshot) => snapshot.payload)).toEqual([{ tick: 5 }]);
        expect(snapshots.map((snapshot) => snapshot.payload)).toEqual([{ tick: 5 }]);
        expect(client.status().peerAssist.snapshotRepairEnabled).toBe(true);
    });

    it('stops subscriptions and prevents later callbacks', async () => {
        const fake = createFakeRallar();
        const client = createClient(fake, {
            onEvent: () => {
                throw new Error('Stopped authority clients must not deliver events.');
            }
        });
        await client.start();

        client.stop();
        await fake.emitWs(
            'game.authority.event.v1',
            'server-1',
            envelope({ kind: 'event', senderId: 'server-1', payload: { kind: 'late' }, seq: 1 })
        );

        expect(client.status()).toMatchObject({
            phase: 'stopped',
            stopped: true
        });
        expect(fake.wsMessageHandlers).toHaveLength(0);
        expect(fake.rtcMessageHandlers).toHaveLength(0);
    });

    it('keeps the default authority client bound to match lifecycle calls', async () => {
        const fake = createFakeRallar();
        const match = createRallarAuthorityBrowserMatch<Command, Snapshot, Event, Presence>({
            rallar: fake.rallar,
            protocol: 'test.authority.v1',
            topicId: 'game.authority',
            authority: { ...authority, kind: 'server' }
        });

        await expect(match.start()).resolves.toMatchObject({ phase: 'ready' });
        expect(match.status()).toMatchObject({ phase: 'ready' });
        match.stop();
        expect(match.status()).toMatchObject({ phase: 'stopped' });
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

function envelope<T>(input: AuthorityEnvelopeFixtureInput<T>): RallarGameAuthorityEnvelope<T> {
    return createRallarGameAuthorityEnvelope({
        protocol: 'test.authority.v1',
        kind: input.kind,
        roomId: 'room-1',
        senderId: input.senderId,
        seq: input.seq,
        sentAtEpochMs: 1_000 + input.seq,
        authority,
        payload: input.payload
    });
}

function createFakeRallar() {
    const lifecycle = createFakeAuthorityLifecycle();
    const messages = createFakeAuthorityMessages();
    const rallar = toAuthorityFacadeTestDouble({
        session: () => lifecycle.session,
        subscriptions: createSubscriptionScope,
        rooms: lifecycle.rooms,
        rtc: lifecycle.rtc,
        messages: messages.operations
    });

    return {
        ...lifecycle.handlers,
        ...messages.handlers,
        rallar,
        async emitWs<T>(
            typeId: string,
            senderId: string,
            payload: RallarGameAuthorityEnvelope<T>
        ) {
            await emit(messages.handlers.wsMessageHandlers, message({ transport: 'ws', typeId, senderId, payload }));
        },
        async emitRtc<T>(
            typeId: string,
            senderId: string,
            payload: RallarGameAuthorityEnvelope<T>
        ) {
            await emit(messages.handlers.rtcMessageHandlers, message({ transport: 'rtc', typeId, senderId, payload }));
        }
    };
}

function createFakeAuthorityLifecycle() {
    const roomChangeHandlers: Array<(state: RallarMessagePayload) => void | Promise<void>> = [];
    const rtcStatusHandlers: Array<(status: RallarRtcStatus) => void | Promise<void>> = [];
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

    return {
        session,
        handlers: { roomChangeHandlers, rtcStatusHandlers },
        rooms: {
            state: () => roomState,
            onChange: (handler: (state: RallarMessagePayload) => void | Promise<void>) => {
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
        }
    };
}

function createFakeAuthorityMessages() {
    const wsMessageHandlers: Array<MessageSubscription> = [];
    const rtcMessageHandlers: Array<MessageSubscription> = [];
    const wsSends: RallarWsSendInput<RallarMessagePayload>[] = [];
    const wsSend: FakeWsSend = async (input) => {
        wsSends.push(input);
        return {
            transport: 'ws',
            status: 'enqueued',
            message: input,
            entries: []
        };
    };
    const rtcSend: FakeRtcSend = async (input) => {
        return {
            transport: 'rtc',
            status: 'enqueued',
            message: input,
            entries: []
        };
    };

    return {
        handlers: { wsMessageHandlers, rtcMessageHandlers, wsSends },
        wsSend,
        rtcSend,
        operations: createFakeMessageOperations({
            wsMessageHandlers,
            rtcMessageHandlers,
            wsSend,
            rtcSend
        })
    };
}

interface FakeMessageOperationsInput {
    readonly wsMessageHandlers: MessageSubscription[];
    readonly rtcMessageHandlers: MessageSubscription[];
    readonly wsSend: FakeWsSend;
    readonly rtcSend: FakeRtcSend;
}

interface FakeWsSend {
    (input: RallarWsSendInput<RallarMessagePayload>): Promise<FakeWsSendResult>;
}

interface FakeRtcSend {
    (input: RallarRtcSendInput<RallarMessagePayload>): Promise<FakeRtcSendResult>;
}

interface FakeWsSendResult {
    readonly transport: 'ws';
    readonly status: 'enqueued';
    readonly message: RallarWsSendInput<RallarMessagePayload>;
    readonly entries: readonly never[];
}

interface FakeRtcSendResult {
    readonly transport: 'rtc';
    readonly status: 'enqueued';
    readonly message: RallarRtcSendInput<RallarMessagePayload>;
    readonly entries: readonly never[];
}

function createFakeMessageOperations(input: FakeMessageOperationsInput) {
    return {
        ws: createFakeMessageTransport(input.wsMessageHandlers, input.wsSend),
        rtc: createFakeMessageTransport(input.rtcMessageHandlers, input.rtcSend),
        room: (definition: RallarRoomMessageChannelDefinition) =>
            createFakeRoomMessageChannel({
                ...input,
                definition
            })
    };
}

function createFakeMessageTransport<TSend extends FakeWsSend | FakeRtcSend>(
    subscriptions: MessageSubscription[],
    send: TSend
) {
    return {
        send,
        onMessage: (
            selector: RallarMessageSelectorInput,
            handler: (message: RallarMessage<RallarMessagePayload>) => void | Promise<void>
        ) => {
            const subscription = { selector, handler };
            subscriptions.push(subscription);
            return () => remove(subscriptions, subscription);
        }
    };
}

interface FakeRoomMessageChannelInput extends FakeMessageOperationsInput {
    readonly definition: RallarRoomMessageChannelDefinition;
}

function createFakeRoomMessageChannel(input: FakeRoomMessageChannelInput) {
    const subscribe = (
        subscriptions: MessageSubscription[],
        handler: (
            payload: RallarMessagePayload,
            message: RallarMessage<RallarMessagePayload>
        ) => void | Promise<void>
    ) => {
        const subscription = {
            selector: input.definition,
            handler: async (message: RallarMessage<RallarMessagePayload>) => await handler(message.payload, message)
        };
        subscriptions.push(subscription);
        return () => remove(subscriptions, subscription);
    };
    return {
        send: async (payload: RallarMessagePayload, options: RallarTypedMessageSendOptions<RallarMessagePayload> = {}) =>
            await input.rtcSend({ ...input.definition, ...options, payload }),
        sendRtc: async (payload: RallarMessagePayload, options: RallarTypedRtcSendOptions<RallarMessagePayload> = {}) =>
            await input.rtcSend({ ...input.definition, ...options, payload }),
        sendWs: async (payload: RallarMessagePayload, options: RallarTypedWsSendOptions<RallarMessagePayload> = {}) =>
            await input.wsSend({
                ...input.definition,
                ...options,
                payload,
                scope: options.scope ?? 'room'
            }),
        onRtc: (
            handler: (
                payload: RallarMessagePayload,
                message: RallarMessage<RallarMessagePayload>
            ) => void | Promise<void>
        ) => subscribe(input.rtcMessageHandlers, handler),
        onWs: (
            handler: (
                payload: RallarMessagePayload,
                message: RallarMessage<RallarMessagePayload>
            ) => void | Promise<void>
        ) => subscribe(input.wsMessageHandlers, handler)
    };
}

interface MessageSubscription {
    readonly selector: RallarMessageSelectorInput;
    readonly handler: (message: RallarMessage<RallarMessagePayload>) => void | Promise<void>;
}

async function emit<T>(
    subscriptions: readonly MessageSubscription[],
    message: RallarMessage<T>
): Promise<void> {
    await Promise.all(
        subscriptions
            .filter((subscription) => selectorMatches(subscription.selector, message.typeId))
            .map((subscription) => subscription.handler(toAuthorityMessageTestDouble(message)))
    );
}

function selectorMatches(
    selector: RallarMessageSelectorInput,
    typeId: string
): boolean {
    return typeof selector === 'string' ? selector === typeId : selector.typeId === typeId;
}

function message<T>(input: AuthorityMessageFixtureInput<T>): RallarMessage<T> {
    return {
        transport: input.transport,
        typeId: input.typeId,
        topicId: 'game.authority',
        contextId: 'room-1',
        resourceId: 'resource-1',
        roomId: 'room-1',
        senderId: input.senderId,
        payload: input.payload,
        raw: {} as RallarMessage<T>['raw'],
        receivedAtEpochMs: Date.now()
    };
}

function toAuthorityFacadeTestDouble(
    members: object
): RallarGameAuthorityClientRallarFacade {
    return members as RallarGameAuthorityClientRallarFacade;
}

function toAuthorityMessageTestDouble<T>(
    message: RallarMessage<T>
): RallarMessage<RallarMessagePayload> {
    return message as object as RallarMessage<RallarMessagePayload>;
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
