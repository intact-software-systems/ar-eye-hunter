import type { RallarCallSignalEvent, RallarIncomingCallInvite } from '@shared-web/browser/rallar-calls-facade.ts';
import { newALRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { Either } from '@shared/resilience/Either.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimulatedNativeRtcPeerConnection } from '../../shared/native-rtc-connection-fixture.ts';
import { createBrowserRtcChannelHealth, createBrowserRtcPeerTestDouble } from '../rtc/browser-rtc-peer-test-double.ts';

type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

interface CallTextMessage {
    readonly text: string;
}

const mocks = await vi.hoisted(async () => {
    const { createLightweightBrowserFacadeTestMocks } = await import(
        '../lightweight-browser-facade-test-mocks.ts'
    );
    return createLightweightBrowserFacadeTestMocks();
});

vi.mock(
    import('@shared-web/browser/connection/initialise-browser-middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initialiseApiMiddleware(options)).middleware
    })
);

vi.mock(
    import('@shared-web/browser/state-read/state-event-http-api.ts'),
    (): Partial<StateEventHttpApiModule> => ({
        listStateClientEventPage: mocks.listStateClientEventPage,
        listStateClientEvents: mocks.listStateClientEvents,
        listStateGroupEventPage: mocks.listStateGroupEventPage,
        listStateGroupEvents: mocks.listStateGroupEvents
    })
);

vi.mock(import('@shared-web/browser/auth/session-http-api.ts'), (): Partial<AuthApiModule> => ({
    loginToApi: mocks.loginToApi,
    logoutFromApi: mocks.logoutFromApi,
    registerWithApi: mocks.registerWithApi
}));

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup
    })
);
vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<RefreshStateSnapshotsModule> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<RoomMutationWorkflowsModule> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn(),
            cancelSnapshotAssemblies: vi.fn(() => undefined)
        }
    })
);

vi.mock(
    import('@shared/api/auth.ts'),
    (): Partial<AuthModule> => ({
        clearSession: mocks.clearSession,
        isLoggedIn: vi.fn(() => true),
        readSession: mocks.readSession,
        writeSession: mocks.writeSession
    })
);

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.findClientStateSnapshotByPrincipalId,
        getAllClientStateSnapshots: mocks.getAllClientStateSnapshots
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
        findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
        getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
    })
);

describe('Rallar calls', () => {
    beforeEach(() => {
        resetCallTestDoubles();
    });

    it('starts a targeted data call and reports per-participant readiness', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const reliableHealth = createBrowserRtcChannelHealth({
            peerId: 'peer-1',
            label: 'rtc-data-channel',
            state: 'Open',
            readyState: 'open'
        });
        const native = new SimulatedNativeRtcPeerConnection();
        native.connectionState = 'connected';
        const peer = createBrowserRtcPeerTestDouble({
            peerId: 'peer-1',
            status: { state: 'Open', pc: native },
            channels: [['reliable', {
                readHealth: vi.fn(() => reliableHealth),
                sendJson: vi.fn(() => ({ status: 'sent' as const, bufferedAmount: 0 }))
            }]]
        });
        const reliableChannel = peer.channel;
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-1',
            laneId: 'reliable',
            peer,
            channel: reliableChannel
        });
        mocks.webRtcConnectionService.knownPeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.activePeerIds.mockReturnValue(['peer-1']);
        mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([
            'peer-1'
        ]);
        mocks.webRtcConnectionService.readPeer.mockReturnValue(peer);

        const call = await createRallarFacade().calls.start({
            peerId: 'peer-1',
            data: {
                lanes: ['reliable'],
                openTimeoutMs: 250
            }
        });
        const status = call.status();
        const callChannel = call.channel<CallTextMessage>();
        const sendResult = await callChannel.send({
            text: 'hello'
        });

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'reliable',
                expect.objectContaining({
                    timeoutMs: 250
                })
            );
        expect(status).toMatchObject({
            state: 'open',
            peerIds: ['peer-1'],
            laneIds: ['reliable'],
            participants: [
                {
                    peerId: 'peer-1',
                    state: 'open',
                    readyLaneIds: ['reliable']
                }
            ]
        });
        expect(sendResult).toMatchObject({
            status: 'sent',
            peerIds: ['peer-1'],
            laneId: 'reliable'
        });
    });

    it('sends call invitations as WS unicast signals to target peers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const facade = createRallarFacade();

        const result = await facade.calls.invite({
            peerIds: ['session-1', 'peer-a', 'peer-b', 'peer-a'],
            data: {
                lanes: ['reliable', 'control']
            },
            media: {
                audio: true,
                video: false
            },
            message: 'join?'
        });

        expect(result.peerIds).toEqual(['peer-a', 'peer-b']);
        expect(result.signals.map((signal) => signal.peerId)).toEqual([
            'peer-a',
            'peer-b'
        ]);
        const firstMessage = mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0];
        expect(firstMessage).toMatchObject({
            route: {
                topicId: 'app.rallar.calls',
                contextId: result.callId
            },
            targets: {
                mode: 'unicast',
                toPeerId: 'peer-a'
            },
            payload: {
                typeId: 'app.rallar.calls.invite.v1'
            }
        });
        expect(JSON.parse(firstMessage.payload.resource)).toMatchObject({
            kind: 'invite',
            callId: result.callId,
            fromPeerId: 'session-1',
            toPeerIds: ['peer-a', 'peer-b'],
            data: {
                laneIds: ['reliable', 'control']
            },
            media: {
                audio: true,
                video: false
            },
            message: 'join?'
        });
    });

    it('accepts and declines incoming call invites through call signal helpers', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mocks.webRtcConnectionService.ensurePeerLaneOpen.mockResolvedValue({
            status: 'open',
            peerId: 'peer-caller',
            laneId: 'reliable'
        });
        const facade = createRallarFacade();
        const invites: RallarIncomingCallInvite[] = [];
        const signals: RallarCallSignalEvent[] = [];

        facade.calls.onInvite((invite) => {
            invites.push(invite);
        });
        facade.calls.onSignal((signal) => {
            signals.push(signal);
        });
        await facade.connect();

        const incoming = newALUnicastMessage(
            'peer-caller',
            newALRoute('app.rallar.calls', 'call-1', 'invite-1'),
            'session-1',
            'app.rallar.calls.invite.v1',
            {
                kind: 'invite',
                callId: 'call-1',
                fromPeerId: 'peer-caller',
                toPeerIds: ['session-1'],
                data: {
                    laneIds: ['reliable']
                },
                media: {
                    audio: true
                },
                message: 'voice?',
                occurredAtEpochMs: 1
            }
        );

        await findLatestWsAnyMessageCallback()?.onMessage(
            incoming,
            QueueBoxUtilities.toResourceEntryFromMsg(incoming, incoming.payload.typeId)
        );

        expect(invites).toHaveLength(1);
        expect(signals).toHaveLength(1);
        expect(invites[0]).toMatchObject({
            kind: 'invite',
            callId: 'call-1',
            fromPeerId: 'peer-caller',
            dataLaneIds: ['reliable'],
            media: {
                audio: true
            },
            message: 'voice?'
        });

        const invite = invites[0];
        if (!invite) {
            throw new Error('Expected the incoming call invite listener to run.');
        }
        const call = await invite.accept();
        const declined = await invite.decline('busy');

        expect(call.id).toBe('call-1');
        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-caller',
                'reliable',
                expect.objectContaining({})
            );
        expect(declined).toHaveLength(1);

        const sentSignals = mocks.webSocketQueueBox
            .enqueueOutboxIfAbsent.mock.calls
            .map((callArgs) => callArgs[0]);
        expect(sentSignals.map((message) => message.payload.typeId)).toEqual([
            'app.rallar.calls.accept.v1',
            'app.rallar.calls.decline.v1'
        ]);
        expect(sentSignals.map((message) => message.targets)).toEqual([
            {
                mode: 'unicast',
                toPeerId: 'peer-caller'
            },
            {
                mode: 'unicast',
                toPeerId: 'peer-caller'
            }
        ]);
        expect(JSON.parse(sentSignals[1].payload.resource)).toMatchObject({
            kind: 'declined',
            reason: 'busy',
            callId: 'call-1',
            fromPeerId: 'session-1',
            toPeerIds: ['peer-caller']
        });
    });
});

function resetCallTestDoubles(): void {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetCallRepositoryAndSessionDoubles();
    resetCallRtcDoubles();
    resetCallWsDoubles();
    resetCallApiDoubles();
}

function resetCallRepositoryAndSessionDoubles(): void {
    mocks.findClientStateSnapshotByPrincipalId.mockReturnValue(undefined);
    mocks.getAllClientStateSnapshots.mockReturnValue([]);
    mockGroupRepositoryMissing();
    mocks.refreshStateSnapshots.mockResolvedValue({ clients: [], groups: [] });
    mocks.initialiseApiMiddleware.mockResolvedValue(mocks.ctx);
    mocks.clearSession.mockImplementation(() => undefined);
    mocks.readSession.mockReturnValue(mocks.ctx.session);
    mocks.logoutFromApi.mockResolvedValue({ loggedOut: true });
    mocks.createAndJoinStateGroup.mockRejectedValue(new Error('create not mocked'));
    mocks.joinStateGroup.mockRejectedValue(new Error('join not mocked'));
    mocks.leaveStateGroup.mockRejectedValue(new Error('leave not mocked'));
    mocks.updateStateGroupMetadata.mockRejectedValue(
        new Error('metadata update not mocked')
    );
}

function resetCallRtcDoubles(): void {
    mocks.webRtcConnectionService.peerIdsWithNoReconnectableLanes
        .mockReturnValue([]);
    mocks.webRtcConnectionService.knownPeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.activePeerIds.mockReturnValue([]);
    mocks.webRtcConnectionService.readyPeerIdsForLane.mockReturnValue([]);
    mocks.webRtcConnectionService.ensurePeerConnectionStarted.mockImplementation(
        (peerId: string): WebRtcConnectionService.PeerConnectionResult =>
            Either.ofLeft({
                kind: 'connect-failed',
                peerId,
                error: new Error('connect not mocked'),
                startedSetup: false
            })
    );
    mocks.webRtcConnectionService.ensurePeerLaneOpen.mockImplementation(
        async (peerId, laneId = DEFAULT_RTC_DATA_CHANNEL_LANE_ID) => ({
            status: 'connect-failed',
            peerId,
            laneId,
            error: new Error('connect not mocked')
        })
    );
    mocks.webRtcConnectionService.onRtcPeerLifecycleDo.mockImplementation(
        () => mocks.ctx.middleware.webRtcConnectionService
    );
    mocks.webRtcConnectionService.readPeer.mockReturnValue(undefined);
    mocks.webRtcConnectionService.removeRtcPeerLifecycleById.mockReturnValue(true);
    mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
        async (message) => ({ status: 'enqueued', message, entries: [] })
    );
    mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
        mocks.ctx.middleware.rtcRxStreamer
    );
    mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
}

function resetCallWsDoubles(): void {
    mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
        async (message) => ({ status: 'enqueued', message, entries: [] })
    );
    mocks.webSocketQueueBox.onAnyInboxMessageDo.mockReturnValue(
        mocks.ctx.middleware.webSocketQueueBox
    );
    mocks.webSocketQueueBox.removeAnyInboxMessageCallback.mockReturnValue(true);
    mocks.webSocketQueueBox.readHealth.mockReturnValue({
        sessionId: mocks.ctx.session.sessionId,
        url: 'ws://localhost/ws',
        readyState: 'missing',
        isOpen: false,
        reconnecting: false,
        reconnectEnabled: false,
        reconnectAttempts: 0,
        maxReconnectAttempts: 12,
        reconnectExhausted: false
    });
    mocks.webSocketQueueBox.close.mockImplementation((code, reason) => {
        mocks.webSocket.close(code, reason);
    });
    mocks.webSocket.onWebsocketCallbacksDo.mockReturnValue(
        mocks.ctx.middleware.webSocketQueueBox.socket
    );
    mocks.webSocket.removeWebsocketCallbackById.mockReturnValue(true);
}

function resetCallApiDoubles(): void {
    mocks.registerWithApi.mockResolvedValue({
        clientId: 'client-new',
        username: 'new-user',
        displayName: null,
        registeredAtEpochMs: 1_000
    });
    mocks.listStateClientEvents.mockRejectedValue(
        new Error('client events not mocked')
    );
    mocks.listStateClientEventPage.mockRejectedValue(
        new Error('client event page not mocked')
    );
    mocks.listStateGroupEvents.mockRejectedValue(
        new Error('group events not mocked')
    );
    mocks.listStateGroupEventPage.mockRejectedValue(
        new Error('group event page not mocked')
    );
}

function findLatestWsAnyMessageCallback(): OnMessageCallback | undefined {
    return mocks.webSocketQueueBox
        .onAnyInboxMessageDo.mock.calls
        .filter(([callbackId]) => callbackId === 'rallar:ws:any-message')
        .at(-1)?.[1];
}

function mockGroupRepositoryMissing(): void {
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
}
