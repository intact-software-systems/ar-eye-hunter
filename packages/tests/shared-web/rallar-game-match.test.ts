import { describe, expect, it, vi } from 'vitest';
import {
    createRallarGameEnvelope,
    createRallarGameMatch,
} from '@shared-web/game/mod.ts';
import type {
    RallarGameEnvelope,
    RallarGameMatchConfig,
    RallarGameRallarFacade,
} from '@shared-web/game/mod.ts';
import type {
    RallarDirectorRelayConfig,
    RallarDirectorRelayHandle,
    RallarDirectorStatus,
} from '@shared-web/browser/rallar.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

type Input = Readonly<{ x: number }>;
type Intent = Readonly<{ action: string }>;
type Snapshot = Readonly<{ tick: number }>;
type Event = Readonly<{ kind: string }>;

const roomRef: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1',
};

describe('Rallar Game match', () => {
    it('subscribes to expected Rallar surfaces on start', async () => {
        const fake = createFakeRallar();
        const match = createMatch(fake);

        await match.start();

        expect(fake.roomChangeHandlers).toHaveLength(1);
        expect(fake.peopleChangeHandlers).toHaveLength(1);
        expect(fake.directorStatusHandlers).toHaveLength(1);
        expect(fake.rtcStatusHandlers).toHaveLength(1);
        expect(fake.wsMessageHandlers).toHaveLength(1);
        expect(fake.realtimeJsonHandlers.get('game-input')).toHaveLength(1);
        expect(fake.realtimeJsonHandlers.get('game-snapshot')).toHaveLength(1);
        expect(fake.relayConfig).toMatchObject({
            laneId: 'game-intent',
            topicId: 'game.topic',
            intentTypeId: 'game.topic.intent.v1',
            outputTypeId: 'game.topic.event.v1',
            snapshotTypeId: 'game.topic.snapshot.v1',
            syncRequestTypeId: 'game.topic.sync-request.v1',
            heartbeatTypeId: 'game.topic.heartbeat.v1',
        });
    });

    it('sends capability reports as room-scoped WS messages', async () => {
        const fake = createFakeRallar();
        const match = createMatch(fake, {
            readCapability: () => ({
                fps: 60,
                hardwareConcurrency: 8,
            }),
        });
        await match.start();

        const result = await match.reportCapability({ scoreBias: 5 });

        expect(result).toMatchObject({ status: 'sent', transport: 'ws' });
        expect(fake.wsSend).toHaveBeenCalledWith(
            expect.objectContaining({
                topicId: 'game.topic',
                typeId: 'game.topic.capability.v1',
                scope: 'room',
                roomRef,
            }),
        );
        expect(fake.wsSend.mock.calls[0][0].payload).toMatchObject({
            protocol: 'test.game.v1',
            kind: 'capability',
            roomId: 'room-1',
            senderId: 'peer-a',
            payload: {
                peerId: 'peer-a',
                fps: 60,
                hardwareConcurrency: 8,
                scoreBias: 5,
            },
        });
    });

    it('appoints the elected local peer as director', async () => {
        const fake = createFakeRallar({ localRole: 'owner' });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('appointed');
        expect(fake.appoint).toHaveBeenCalledWith(roomRef, {
            heartbeatTtlMs: 10_000,
        });
        expect(match.status()).toMatchObject({
            phase: 'active',
            directorPeerId: 'peer-a',
            directorIsFresh: true,
        });
    });

    it('does not appoint a non-admin local peer for metadata-backed directors', async () => {
        const fake = createFakeRallar({ localRole: 'member' });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-authorized');
        expect(result.reason).toBe('Only active room owners/admins can appoint the browser director.');
        expect(fake.appoint).not.toHaveBeenCalled();
        expect(match.canAppointDirector()).toMatchObject({
            allowed: false,
            status: 'not-authorized',
        });
        expect(match.diagnostics()).toMatchObject({
            appointment: expect.objectContaining({
                status: 'not-authorized',
                localRole: 'member',
            }),
        });
        expect(match.diagnostics().issues).toContain('director-not-authorized');
    });

    it('waits for local membership before metadata-backed director appointment', async () => {
        const fake = createFakeRallar({ localMemberKnown: false });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 100 }),
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });
        await match.start();
        await match.reportCapability();

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-ready');
        expect(result.reason).toBe('Cannot confirm local room membership yet.');
        expect(fake.appoint).not.toHaveBeenCalled();
        expect(match.diagnostics().issues).toContain('director-eligibility-not-ready');
    });

    it('does not appoint a non-elected local peer', async () => {
        const fake = createFakeRallar({ localRole: 'owner' });
        const match = createMatch(fake, {
            readCapability: () => ({ scoreBias: 1 }),
            scoreHost: (capability) => capability.scoreBias ?? 0,
        });
        await match.start();
        await match.reportCapability();
        await fake.emitCapability({
            peerId: 'peer-b',
            reportedAtEpochMs: Date.now(),
            scoreBias: 50,
        });

        const result = await match.appointIfElected();

        expect(result.status).toBe('not-elected');
        expect(fake.appoint).not.toHaveBeenCalled();
    });

    it('publishes presence over realtime room scope with replace-by-key defaults', async () => {
        const fake = createFakeRallar();
        const match = createMatch(fake);
        await match.start();

        const result = await match.sendPresence({ x: 7 });

        expect(result).toMatchObject({ status: 'sent', transport: 'realtime' });
        expect(fake.realtimeSendJson).toHaveBeenCalledWith(expect.objectContaining({
            laneId: 'game-input',
            roomRef,
            data: expect.objectContaining({
                kind: 'presence',
                payload: { x: 7 },
                senderId: 'peer-a',
            }),
            key: 'presence:peer-a',
            maxAgeMs: 250,
            openTimeoutMs: 500,
        }));
    });

    it('delivers peer presence envelopes to subscribers', async () => {
        const fake = createFakeRallar();
        const onPresence = vi.fn();
        const match = createMatch(fake, { onPresence });
        await match.start();

        await fake.emitRealtime(
            'game-input',
            'peer-b',
            envelope('presence', 'peer-b', { x: 4 }, 51),
        );

        expect(onPresence).toHaveBeenCalledOnce();
        expect(onPresence.mock.calls[0][0]).toMatchObject({
            senderId: 'peer-b',
            payload: { x: 4 },
        });
    });

    it('sends input only to a fresh director', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true,
        });
        const match = createMatch(fake);
        await match.start();

        expect(await match.sendInput({ x: 1 })).toMatchObject({
            status: 'sent',
            transport: 'realtime',
        });
        expect(fake.realtimeSendJson).toHaveBeenCalledWith(
            expect.objectContaining({
                laneId: 'game-input',
                peerIds: ['peer-b'],
                key: 'input:peer-a',
            }),
        );

        fake.setDirector('peer-b', false);
        expect(await match.sendInput({ x: 2 })).toMatchObject({
            status: 'no-director',
        });
        expect(fake.realtimeSendJson).toHaveBeenCalledTimes(1);
    });

    it('rejects snapshots that do not come from the fresh director', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true,
        });
        const onSnapshot = vi.fn();
        const match = createMatch(fake, { onSnapshot });
        await match.start();

        await fake.emitRealtime(
            'game-snapshot',
            'peer-c',
            envelope('snapshot', 'peer-c', { tick: 1 }, 1),
        );
        await fake.emitRealtime(
            'game-snapshot',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 2 }, 2),
        );

        expect(onSnapshot).toHaveBeenCalledTimes(1);
        expect(onSnapshot.mock.calls[0][0].payload).toEqual({ tick: 2 });
    });

    it('delegates sync request to Director Relay and exposes readSnapshot for relay sync responses', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true,
        });
        const match = createMatch(fake, {
            readSnapshot: () => ({ tick: 99 }),
        });
        await match.start();

        await match.requestSync({ reason: 'join-late' });

        expect(fake.relay.requestSync).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'sync-request',
                payload: { reason: 'join-late' },
            }),
        );

        fake.setDirector('peer-a', true);
        const snapshot = await fake.relayConfig?.readSnapshot?.();
        expect(snapshot).toMatchObject({
            kind: 'snapshot',
            senderId: 'peer-a',
            payload: { tick: 99 },
        });
    });

    it('sets recovery status when the director is stale', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: false,
        });
        const match = createMatch(fake);

        await match.start();

        expect(match.status()).toMatchObject({
            phase: 'recovering',
            directorPeerId: 'peer-b',
            directorIsFresh: false,
            recovery: {
                status: 'recovering',
                reason: 'No fresh director is available.',
            },
        });

        fake.setDirector('peer-b', true);
        await fake.emitDirectorStatus();
        expect(match.status()).toMatchObject({
            phase: 'active',
            directorIsFresh: true,
            recovery: { status: 'idle' },
        });
    });

    it('stops subscriptions and prevents later handler calls', async () => {
        const fake = createFakeRallar({
            directorPeerId: 'peer-b',
            directorIsFresh: true,
        });
        const onSnapshot = vi.fn();
        const match = createMatch(fake, { onSnapshot });
        await match.start();

        match.stop();
        await fake.emitRealtime(
            'game-snapshot',
            'peer-b',
            envelope('snapshot', 'peer-b', { tick: 1 }, 1),
        );

        expect(match.status()).toMatchObject({
            phase: 'stopped',
            stopped: true,
        });
        expect(onSnapshot).not.toHaveBeenCalled();
        expect(fake.relay.stop).toHaveBeenCalled();
    });
});

function createMatch(
    fake: ReturnType<typeof createFakeRallar>,
    overrides: Partial<RallarGameMatchConfig<Input, Intent, Snapshot, Event>> = {},
) {
    return createRallarGameMatch<Input, Intent, Snapshot, Event>({
        rallar: fake.rallar,
        protocol: 'test.game.v1',
        topicId: 'game.topic',
        ...overrides,
    });
}

function envelope<T>(
    kind: RallarGameEnvelope<T>['kind'],
    senderId: string,
    payload: T,
    seq: number,
): RallarGameEnvelope<T> {
    return createRallarGameEnvelope({
        protocol: 'test.game.v1',
        kind,
        roomId: 'room-1',
        senderId,
        seq,
        directorEpoch: 1,
        sentAtEpochMs: 1_000 + seq,
        payload,
    });
}

function createFakeRallar(
    options: Readonly<{
        directorPeerId?: string;
        directorIsFresh?: boolean;
        localRole?: 'owner' | 'admin' | 'member';
        localStatus?: 'active' | 'left' | 'removed' | 'banned' | 'invited';
        localMemberKnown?: boolean;
    }> = {},
) {
    const roomChangeHandlers: Array<(state: unknown) => void | Promise<void>> = [];
    const peopleChangeHandlers: Array<(state: unknown) => void | Promise<void>> = [];
    const directorStatusHandlers: Array<
        (status: RallarDirectorStatus) => void | Promise<void>
    > = [];
    const rtcStatusHandlers: Array<(status: unknown) => void | Promise<void>> = [];
    const wsMessageHandlers: Array<(message: unknown) => void | Promise<void>> = [];
    const realtimeJsonHandlers = new Map<
        string,
        Array<(message: { peerId: string; data: unknown }) => void | Promise<void>>
    >();
    const session = {
        clientId: 'principal-a',
        sessionId: 'peer-a',
        username: 'alice',
        accessToken: 'token',
        expiresAtEpochMs: Date.now() + 60_000,
    };
    const localMember = {
        principalId: 'principal-a',
        username: 'alice',
        role: options.localRole ?? 'owner',
        status: options.localStatus ?? 'active',
        isOwner: (options.localRole ?? 'owner') === 'owner',
        isOnline: true,
        sessionIds: ['peer-a'],
    };
    const roomState = {
        rooms: [],
        currentRoomId: 'room-1',
        currentRoomRef: roomRef,
        members: [
            ...(options.localMemberKnown === false ? [] : [localMember]),
            {
                principalId: 'principal-b',
                username: 'bob',
                role: 'member',
                status: 'active',
                isOwner: false,
                isOnline: true,
                sessionIds: ['peer-b'],
            },
        ],
    };
    let directorStatus = createDirectorStatus(
        options.directorPeerId,
        options.directorIsFresh ?? false,
    );
    let relayConfig:
        | RallarDirectorRelayConfig<
            RallarGameEnvelope<Intent>,
            RallarGameEnvelope<Event>,
            RallarGameEnvelope<Snapshot>
        >
        | undefined;
    const relay: RallarDirectorRelayHandle<
        RallarGameEnvelope<Intent>,
        RallarGameEnvelope<Event>,
        RallarGameEnvelope<Snapshot>
    > = {
        status: () => directorStatus,
        sendIntent: vi.fn(async () => ({ status: 'sent' as const })),
        sendOutput: vi.fn(async () => ({ status: 'sent' as const })),
        sendHeartbeat: vi.fn(async () => ({ status: 'sent' as const })),
        sendSnapshot: vi.fn(async () => ({ status: 'sent' as const })),
        requestSync: vi.fn(async () => ({ status: 'sent' as const })),
        stop: vi.fn(),
    };
    const wsSend = vi.fn(async (input: unknown) => ({
        transport: 'ws' as const,
        status: 'enqueued' as const,
        message: input,
        entries: [],
    }));
    const realtimeSendJson = vi.fn(async (input: { laneId: string; peerIds?: readonly string[] }) =>
        (input.peerIds ?? ['peer-b']).map((peerId) => ({
            peerId,
            laneId: input.laneId,
            result: {
                status: 'sent' as const,
                bufferedAmount: 0,
            },
        }))
    );
    const appoint = vi.fn(async () => {
        directorStatus = createDirectorStatus('peer-a', true);
        return directorStatus;
    });

    const fake = {
        roomChangeHandlers,
        peopleChangeHandlers,
        directorStatusHandlers,
        rtcStatusHandlers,
        wsMessageHandlers,
        realtimeJsonHandlers,
        wsSend,
        realtimeSendJson,
        appoint,
        relay,
        get relayConfig() {
            return relayConfig;
        },
        rallar: {
            session: () => session,
            subscriptions: createSubscriptionScope,
            rooms: {
                state: () => roomState,
                onChange: (handler: (state: unknown) => void | Promise<void>) => {
                    roomChangeHandlers.push(handler);
                    return () => remove(roomChangeHandlers, handler);
                },
            },
            people: {
                state: () => ({ people: [], clients: [] }),
                onChange: (handler: (state: unknown) => void | Promise<void>) => {
                    peopleChangeHandlers.push(handler);
                    return () => remove(peopleChangeHandlers, handler);
                },
            },
            director: {
                status: () => directorStatus,
                onStatus: (
                    handler: (status: RallarDirectorStatus) => void | Promise<void>,
                ) => {
                    directorStatusHandlers.push(handler);
                    return () => remove(directorStatusHandlers, handler);
                },
                appoint,
                createRelay: (config: typeof relayConfig) => {
                    relayConfig = config;
                    return relay;
                },
            },
            rtc: {
                status: () => ({
                    sessionId: session.sessionId,
                    laneId: 'game-input',
                    knownPeerIds: ['peer-b'],
                    activePeerIds: ['peer-b'],
                    peerIdsWithNoReconnectableLanes: [],
                    readyPeerIds: ['peer-b'],
                    peers: [],
                }),
                onStatus: (handler: (status: unknown) => void | Promise<void>) => {
                    rtcStatusHandlers.push(handler);
                    return () => remove(rtcStatusHandlers, handler);
                },
                waitForRoomLane: vi.fn(async (_room: unknown, laneId: string) => ({
                    transport: 'rtc' as const,
                    roomId: 'room-1',
                    laneId,
                    status: 'open' as const,
                    rtcStatus: {
                        sessionId: session.sessionId,
                        laneId,
                        knownPeerIds: ['peer-b'],
                        activePeerIds: ['peer-b'],
                        peerIdsWithNoReconnectableLanes: [],
                        readyPeerIds: ['peer-b'],
                        peers: [],
                    },
                    ready: [],
                    notReady: [],
                })),
            },
            realtime: {
                sendJson: realtimeSendJson,
                onJson: (
                    laneId: string,
                    handler: (message: { peerId: string; data: unknown }) =>
                        void | Promise<void>,
                ) => {
                    const handlers = realtimeJsonHandlers.get(laneId) ?? [];
                    handlers.push(handler);
                    realtimeJsonHandlers.set(laneId, handlers);
                    return () => remove(handlers, handler);
                },
                health: () => [],
            },
            messages: {
                ws: {
                    send: wsSend,
                    onMessage: (_selector: unknown, handler: (message: unknown) => void | Promise<void>) => {
                        wsMessageHandlers.push(handler);
                        return () => remove(wsMessageHandlers, handler);
                    },
                },
            },
        } as unknown as RallarGameRallarFacade,
        setDirector(peerId: string | undefined, isFresh: boolean) {
            directorStatus = createDirectorStatus(peerId, isFresh);
        },
        async emitDirectorStatus() {
            await Promise.all(
                directorStatusHandlers.map((handler) => handler(directorStatus)),
            );
        },
        async emitCapability(capability: Readonly<{ peerId: string; reportedAtEpochMs: number; scoreBias?: number }>) {
            const message = {
                senderId: capability.peerId,
                payload: envelope('capability', capability.peerId, capability, 100),
            };
            await Promise.all(wsMessageHandlers.map((handler) => handler(message)));
        },
        async emitRealtime(laneId: string, peerId: string, data: unknown) {
            await Promise.all(
                (realtimeJsonHandlers.get(laneId) ?? []).map((handler) =>
                    handler({ peerId, data })
                ),
            );
        },
    };

    return fake;
}

function createDirectorStatus(
    directorPeerId: string | undefined,
    isFresh: boolean,
): RallarDirectorStatus {
    const appointment = directorPeerId
        ? {
            version: 1 as const,
            mode: 'appointed-spa' as const,
            sessionId: directorPeerId,
            principalId: directorPeerId === 'peer-a'
                ? 'principal-a'
                : 'principal-b',
            epoch: 1,
            appointedAtEpochMs: 1_000,
            heartbeatTtlMs: 10_000,
        }
        : undefined;

    return {
        roomId: 'room-1',
        roomRef,
        role: !appointment
            ? 'none'
            : directorPeerId === 'peer-a'
            ? 'director'
            : 'client',
        state: !appointment ? 'none' : isFresh ? 'fresh' : 'stale',
        appointment,
        isDirector: directorPeerId === 'peer-a',
        isFresh,
        active: Boolean(appointment),
        freshness: !appointment ? 'none' : isFresh ? 'fresh' : 'stale',
        nowEpochMs: Date.now(),
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
        },
    };
}

function remove<T>(values: T[], value: T): void {
    const index = values.indexOf(value);
    if (index >= 0) {
        values.splice(index, 1);
    }
}
