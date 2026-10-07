import type { RallarMessagePayload } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import { newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { resolveALDeliveryReceiptAlgo } from '@shared/alm/delivery/resolve-al-delivery-receipt-algo.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { toResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { Either } from '@shared/resilience/Either.ts';
import { DEFAULT_RTC_DATA_CHANNEL_LANE_ID, type WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createDirectorGroupSnapshot } from '../director-group-snapshot-fixture.ts';

type StateEventHttpApiModule = typeof import('@shared-web/browser/state-read/state-event-http-api.ts');
type AuthApiModule = typeof import('@shared-web/browser/auth/session-http-api.ts');
type AppointRoomDirectorModule = typeof import('@shared-web/browser/director/appoint-room-director.ts');
type RoomMutationWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts');
type RefreshStateSnapshotsModule = typeof import('@shared-web/browser/state-read/refresh-state-snapshots.ts');
type MiddlewareModule = typeof import('@shared-web/browser/connection/initialise-browser-middleware.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');
type RoomGroupStateWorkflowsModule = typeof import('@shared-web/browser/rooms/room-group-state-workflows.ts');

interface DirectorMove {
    readonly move: string;
}

interface DirectorAcknowledgement {
    readonly ok: true;
}

interface DirectorSnapshot {
    readonly revision: number;
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
        initialiseMiddleware: async (_session, _topic, options) => ({ middleware: (await mocks.initialiseApiMiddleware(options)).middleware, checkpoints: [] })
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

vi.mock(import('@shared-web/browser/director/appoint-room-director.ts'), (): Partial<AppointRoomDirectorModule> => ({
    appointStateGroupDirector: mocks.appointStateGroupDirector
}));
vi.mock(import('@shared-web/browser/state-read/refresh-state-snapshots.ts'), (): Partial<RefreshStateSnapshotsModule> => ({
    refreshStateSnapshots: mocks.refreshStateSnapshots
}));
vi.mock(import('@shared-web/browser/rooms/room-group-state-mutation-workflows.ts'), (): Partial<RoomMutationWorkflowsModule> => ({
    updateStateGroupMetadata: mocks.updateStateGroupMetadata
}));

vi.mock(
    import('@shared-web/browser/rooms/room-group-state-workflows.ts'),
    (): Partial<RoomGroupStateWorkflowsModule> => ({
        createAndJoinStateGroup: mocks.createAndJoinStateGroup,
        joinStateGroup: mocks.joinStateGroup,
        leaveStateGroup: mocks.leaveStateGroup
    })
);

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

installFakeBroadcastChannelPerTest();

describe('Rallar director relay', () => {
    beforeEach(async () => {
        (await import('@shared-web/browser/connection/browser-transport-runtime.ts'))
            .browserTransportRuntime.shutdown('test-reset');
        resetDirectorTestDoubles();
    });

    it('appoints the current SPA session as room director', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const snapshot = createDirectorGroupSnapshot();
        mockGroupSnapshot(snapshot);
        mocks.appointStateGroupDirector.mockImplementation(
            async (input) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'session-1',
                    principalId: 'principal-1',
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: input.request.heartbeatTtlMs ?? 5_000
                };
                const updated = {
                    ...snapshot,
                    group: {
                        ...snapshot.group,
                        metadata: {
                            ...snapshot.group.metadata,
                            rallarDirector: appointment
                        }
                    }
                };
                mockGroupSnapshot(updated);
                return updated;
            }
        );

        const status = await createRallarFacade().director.appoint('room-1', {
            heartbeatTtlMs: 1_000
        });

        expect(mocks.appointStateGroupDirector).toHaveBeenCalledWith(
            expect.objectContaining({
                groupId: 'room-1',
                request: expect.objectContaining({ heartbeatTtlMs: 1_000 }),
                principalId: 'principal-1',
                sessionId: 'session-1',
                scope: expect.objectContaining({
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1'
                }),
                policies: expect.any(Object)
            })
        );
        expect(status).toMatchObject({
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            active: true
        });
    });

    it('lets the room owner appoint their new session after logout and rejoin', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const created = createDirectorGroupSnapshot();
        const rejoinSession = {
            ...mocks.ctx.session,
            sessionId: 'session-2',
            accessToken: 'token-2'
        };
        const rejoined: GroupSnapshot = {
            ...created,
            activeSessions: [
                {
                    ...created.activeSessions[0],
                    sessionId: rejoinSession.sessionId,
                    principalId: rejoinSession.clientId,
                    generationId: 'generation-session-2',
                    generationVersion: 2,
                    connectedAtEpochMs: 2,
                    lastHeartbeatAtEpochMs: 2,
                    expiresAtEpochMs: 61_000
                }
            ],
            onlineMemberCount: 1
        };
        mockGroupSnapshot(created);
        mocks.createAndJoinStateGroup.mockResolvedValueOnce(created);
        mocks.joinStateGroup.mockImplementationOnce(async () => {
            mockGroupSnapshot(rejoined);
            return rejoined;
        });
        mocks.appointStateGroupDirector.mockImplementationOnce(
            async (input) => {
                const appointment = {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: input.sessionId,
                    principalId: input.principalId,
                    epoch: 1,
                    appointedAtEpochMs: Date.now(),
                    heartbeatTtlMs: input.request.heartbeatTtlMs ?? 5_000
                };
                const updated = {
                    ...rejoined,
                    group: {
                        ...rejoined.group,
                        metadata: {
                            ...rejoined.group.metadata,
                            rallarDirector: appointment
                        }
                    }
                };
                mockGroupSnapshot(updated);
                expect(input.principalId).toBe(rejoinSession.clientId);
                expect(input.sessionId).toBe(rejoinSession.sessionId);
                return updated;
            }
        );

        const facade = createRallarFacade();
        await facade.rooms.createAndSwitch('Owner arena');
        await facade.auth.logout();
        mocks.readSession.mockReturnValue(rejoinSession);
        mocks.initialiseApiMiddleware.mockResolvedValue({
            ...mocks.ctx,
            session: rejoinSession
        });
        await facade.rooms.enter('room-1');

        const status = await facade.director.appoint('room-1', {
            heartbeatTtlMs: 1_000
        });

        expect(status).toMatchObject({
            role: 'director',
            state: 'fresh',
            isDirector: true,
            isFresh: true,
            appointment: {
                sessionId: 'session-2',
                principalId: 'principal-1',
                epoch: 1,
                heartbeatTtlMs: 1_000
            }
        });
    });

    it.each(
        [
            { command: 'intent', typeId: 'game.intent' },
            { command: 'sync request', typeId: 'game.sync-request' }
        ] as const
    )(
        'sends a director $command as one command to the room\'s leader whose WS fallback keeps its msgId (D60)',
        async ({ command, typeId }) => {
            vi.useFakeTimers();
            vi.setSystemTime(Date.now());
            const { createRallarFacade } = await import(
                '@shared-web/browser/rallar.ts'
            );
            mockGroupSnapshot(createDirectorGroupSnapshot({
                sessionId: 'director-session',
                principalId: 'director-principal',
                epoch: 2,
                appointedAtEpochMs: Date.now(),
                heartbeatTtlMs: 60_000
            }));
            mockRtcNoRoute();
            const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement>({
                roomId: 'room-1',
                topicId: 'app.game.director',
                intentTypeId: 'game.intent',
                outputTypeId: 'game.output',
                syncRequestTypeId: 'game.sync-request',
                heartbeatIntervalMs: 60_000
            });

            const sending = command === 'intent'
                ? relay.sendIntent({ move: 'left' })
                : relay.requestSync({ reason: 'late-join' });
            await vi.advanceTimersByTimeAsync(30_000);
            const result = await sending;
            relay.stop();

            const isCommand = (message: ALMessage) => message.payload.typeId === typeId;
            const rtcCommands = mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message).filter(isCommand);
            const wsCommands = mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls.map(([message]) => message).filter(isCommand);
            expect(rtcCommands).toHaveLength(1);
            expect(wsCommands.map((message) => message.id.msgId)).toEqual(
                rtcCommands.map((message) => message.id.msgId)
            );
            expect(wsCommands[0]).toMatchObject({
                id: { msgId: result.receipt?.msgId },
                route: { topicId: 'app.game.director', contextId: 'room-1' },
                targets: {
                    mode: 'multicast',
                    groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' }
                },
                delivery: { reliability: 'at-least-once', ack: 'group-leader' }
            });
            // The mocked carriers deliver no receipt, so the command must not read as sent (correction 11).
            expect(result).toMatchObject({
                status: 'failed',
                receipt: expect.objectContaining({ typeId }),
                reason: 'The director did not confirm the command before its deadline.'
            });
            expect(result.rtc).toBeUndefined();
            expect(result.ws).toBeUndefined();
        }
    );

    it('delivers RTC director commands to the director\'s handlers (correction 13)', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const rtcInbox = new Map<string, Parameters<typeof mocks.rtcRxStreamer.onInboxMessageDo>[1]>();
        mocks.rtcRxStreamer.onInboxMessageDo.mockImplementation((typeId, callback) => {
            rtcInbox.set(typeId, callback);
            return mocks.ctx.middleware.rtcRxStreamer;
        });
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const intents: DirectorMove[] = [];
        const syncRequests: RallarMessagePayload[] = [];
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            syncRequestTypeId: 'game.sync-request',
            heartbeatIntervalMs: 60_000,
            onIntent: (message) => {
                intents.push(message.data);
            },
            onSyncRequest: (message) => {
                syncRequests.push(message.data);
            }
        });
        await facade.connect();

        await rtcInbox.get('game.intent')?.onMessage(
            toDirectorCommand('game.intent', { move: 'left' }),
            toResourceEntry('game.intent', {})
        );
        await rtcInbox.get('game.sync-request')?.onMessage(
            toDirectorCommand('game.sync-request', { reason: 'late-join' }),
            toResourceEntry('game.sync-request', {})
        );
        relay.stop();

        expect(intents).toEqual([{ move: 'left' }]);
        expect(syncRequests).toEqual([{ reason: 'late-join' }]);
    });

    it('routes a command stamped with an earlier appointment epoch to the successor director, since its carrier addressed the director at admission', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const rtcInbox = captureRtcInbox();
        const wsInbox = captureWsInbox();
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const received: string[] = [];
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            syncRequestTypeId: 'game.sync-request',
            heartbeatIntervalMs: 60_000,
            onIntent: (message) => {
                received.push(`${message.transport}:intent:${message.envelope.epoch}`);
            },
            onSyncRequest: (message) => {
                received.push(`${message.transport}:sync-request:${message.envelope.epoch}`);
            }
        });
        await facade.connect();

        await rtcInbox.get('game.intent')?.onMessage(
            toDirectorCommandAtEpoch('game.intent', { move: 'left' }, 2),
            toResourceEntry('game.intent', {})
        );
        await wsInbox.deliver(toDirectorCommandAtEpoch('game.sync-request', { reason: 'late-join' }, 1));
        relay.stop();

        expect(received).toEqual(['rtc:intent:2', 'ws:sync-request:1']);
    });

    it.each(
        [
            { case: 'a later appointment epoch than the local one', directorSessionId: 'session-1', commandEpoch: 4 },
            { case: 'an earlier epoch to a session that is not the director', directorSessionId: 'director-session', commandEpoch: 2 }
        ] as const
    )('drops a director command stamped with $case', async ({ directorSessionId, commandEpoch }) => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const wsInbox = captureWsInbox();
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: directorSessionId,
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const intents: DirectorMove[] = [];
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            onIntent: (message) => {
                intents.push(message.data);
            }
        });
        await facade.connect();

        await wsInbox.deliver(toDirectorCommandAtEpoch('game.intent', { move: 'left' }, commandEpoch));
        relay.stop();

        expect(intents).toEqual([]);
    });

    it('delivers a director command that arrives over the WS fallback leg to onIntent once (D60)', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const wsInbox = captureWsInbox();
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const intents: DirectorMove[] = [];
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            onIntent: (message) => {
                intents.push(message.data);
            }
        });
        await facade.connect();

        await wsInbox.deliver(toDirectorCommand('game.intent', { move: 'left' }));
        relay.stop();

        expect(intents).toEqual([{ move: 'left' }]);
    });

    it('hands a command that arrives on both lanes to the relay twice, leaving the duplicate to the application (at-least-once)', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const wsInbox = captureWsInbox();
        const rtcInbox = new Map<string, Parameters<typeof mocks.rtcRxStreamer.onInboxMessageDo>[1]>();
        mocks.rtcRxStreamer.onInboxMessageDo.mockImplementation((typeId, callback) => {
            rtcInbox.set(typeId, callback);
            return mocks.ctx.middleware.rtcRxStreamer;
        });
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const received: string[] = [];
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            onIntent: (message) => {
                received.push(`${message.transport}:${message.data.move}`);
            }
        });
        await facade.connect();
        const command = toDirectorCommand('game.intent', { move: 'left' });

        await rtcInbox.get('game.intent')?.onMessage(command, toResourceEntry('game.intent', {}));
        await wsInbox.deliver(command);
        relay.stop();

        expect(received).toEqual(['rtc:left', 'ws:left']);
    });

    it('refuses a director intent to a stale appointment without putting it on either carrier', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'director-session',
            principalId: 'director-principal',
            epoch: 2,
            appointedAtEpochMs: 1,
            heartbeatTtlMs: 5
        }));
        const carried: string[] = [];
        const refuseCarrier = async (message: ALMessage): Promise<never> => {
            carried.push(message.payload.typeId);
            throw new Error('A stale director intent must not reach a carrier.');
        };
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(refuseCarrier);
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(refuseCarrier);
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000
        });

        const result = await relay.sendIntent({ move: 'left' });
        relay.stop();

        expect(result).toEqual({
            status: 'stale-director',
            reason: 'The appointed director is stale or inactive.'
        });
        expect(carried).not.toContain('game.intent');
    });

    it('can disable periodic director snapshots while keeping explicit sync snapshots', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now());
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        mockRtcNoRoute();
        const enqueuedWsTypeIds: string[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                enqueuedWsTypeIds.push(message.payload.typeId);
                return {
                    status: 'enqueued',
                    verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                    message,
                    entries: [],
                    trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
                };
            }
        );
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement, DirectorSnapshot>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000,
            snapshotTypeId: 'game.snapshot',
            snapshotIntervalMs: false,
            readSnapshot: () => ({ revision: 1 })
        });

        await vi.advanceTimersByTimeAsync(5_000);
        expect(enqueuedWsTypeIds).not.toContain('game.snapshot');

        await relay.sendSnapshot();
        relay.stop();

        expect(enqueuedWsTypeIds).toContain('game.snapshot');
    });

    it('falls back to WS when director room RTC output has no remote route', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        mockRtcNoRoute();
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output'
        });

        const result = await relay.sendOutput({ ok: true });
        relay.stop();

        expect(result.status).toBe('sent');
        expect(result.rtc?.lifecycle().state).toBe('failed');
        expect(result.ws?.lifecycle().state).toBe('queued');
    });

    it('sends a receipt output as one room multicast that falls back to WS without a second message', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        mockRtcNoRoute();
        const wsMessages: ALMessage[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(async (message) => {
            wsMessages.push(message);
            return {
                status: 'enqueued',
                verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                message,
                entries: [],
                trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
            };
        });
        const relay = createRallarFacade().director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 60_000
        });

        const result = await relay.sendOutput({ ok: true }, { ack: 'all-logical-recipients' });
        relay.stop();

        expect(result).toEqual({ status: 'sent', receipt: expect.objectContaining({ typeId: 'game.output' }) });
        expect(result.receipt?.lifecycle()).toMatchObject({ state: 'queued', ackMode: 'all-logical-recipients' });
        const outputs = wsMessages.filter((message) => message.payload.typeId === 'game.output');
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({
            id: { msgId: result.receipt?.msgId },
            targets: { mode: 'multicast' },
            delivery: { reliability: 'at-least-once', ack: 'all-logical-recipients' }
        });
    });

    it('stops director relay heartbeats when auth logs out', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.now());
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        facade.director.createRelay<DirectorMove, DirectorAcknowledgement>({
            roomId: 'room-1',
            topicId: 'app.game.director',
            intentTypeId: 'game.intent',
            outputTypeId: 'game.output',
            heartbeatIntervalMs: 1_000
        });

        await facade.auth.logout();
        const postLogoutEffects: string[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`ws:${message.payload.typeId}`);
                return {
                    status: 'enqueued',
                    verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                    message,
                    entries: [],
                    trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
                };
            }
        );
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`rtc:${message.payload.typeId}`);
                return {
                    status: 'enqueued',
                    verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                    message,
                    entries: [],
                    trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
                };
            }
        );
        mocks.initialiseApiMiddleware.mockImplementation(async () => {
            postLogoutEffects.push('middleware:init');
            return mocks.ctx;
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(postLogoutEffects).toEqual([]);
    });

    it('rejects stale director relay handle sends after logout without reconnecting', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        mockGroupSnapshot(createDirectorGroupSnapshot({
            sessionId: 'session-1',
            principalId: 'principal-1',
            epoch: 3,
            appointedAtEpochMs: Date.now(),
            heartbeatTtlMs: 60_000
        }));
        const facade = createRallarFacade();
        const relay = facade.director.createRelay<DirectorMove, DirectorAcknowledgement, DirectorSnapshot>(
            {
                roomId: 'room-1',
                topicId: 'app.game.director',
                intentTypeId: 'game.intent',
                outputTypeId: 'game.output',
                heartbeatIntervalMs: 60_000,
                snapshotTypeId: 'game.snapshot',
                snapshotIntervalMs: false,
                readSnapshot: () => ({ revision: 1 })
            }
        );

        await facade.auth.logout();
        const postLogoutEffects: string[] = [];
        mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`ws:${message.payload.typeId}`);
                return {
                    status: 'enqueued',
                    verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                    message,
                    entries: [],
                    trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
                };
            }
        );
        mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
            async (message) => {
                postLogoutEffects.push(`rtc:${message.payload.typeId}`);
                return {
                    status: 'enqueued',
                    verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                    message,
                    entries: [],
                    trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
                };
            }
        );
        mocks.initialiseApiMiddleware.mockImplementation(async () => {
            postLogoutEffects.push('middleware:init');
            return mocks.ctx;
        });

        const results = await Promise.all([
            relay.sendHeartbeat(),
            relay.sendOutput({ ok: true }),
            relay.sendSnapshot({ revision: 2 }),
            relay.sendIntent({ move: 'dash' }),
            relay.requestSync({ reason: 'late-join' })
        ]);

        expect(results.every((result) => result.status === 'no-director')).toBe(true);
        expect(results.every((result) => result.reason === 'Auth session ended.')).toBe(true);
        expect(postLogoutEffects).toEqual([]);
    });
});

function resetDirectorTestDoubles(): void {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetDirectorRepositoryAndSessionDoubles();
    resetDirectorRtcDoubles();
    resetDirectorWsDoubles();
    resetDirectorApiDoubles();
}

function resetDirectorRepositoryAndSessionDoubles(): void {
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
    mocks.appointStateGroupDirector.mockRejectedValue(
        new Error('director appointment not mocked')
    );
}

function resetDirectorRtcDoubles(): void {
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
        async (message) => ({
            status: 'enqueued',
            verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
            message,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
        })
    );
    mocks.rtcRxStreamer.onInboxMessageDo.mockReturnValue(
        mocks.ctx.middleware.rtcRxStreamer
    );
    mocks.rtcRxStreamer.removeInboxMessageCallback.mockReturnValue(true);
}

interface WsInboxDouble {
    deliver(message: ALMessage): Promise<void>;
}

function captureRtcInbox(): Map<string, Parameters<typeof mocks.rtcRxStreamer.onInboxMessageDo>[1]> {
    const rtcInbox = new Map<string, Parameters<typeof mocks.rtcRxStreamer.onInboxMessageDo>[1]>();
    mocks.rtcRxStreamer.onInboxMessageDo.mockImplementation((typeId, callback) => {
        rtcInbox.set(typeId, callback);
        return mocks.ctx.middleware.rtcRxStreamer;
    });
    return rtcInbox;
}

function captureWsInbox(): WsInboxDouble {
    const callbacks: Array<Parameters<typeof mocks.webSocketQueueBox.onAnyInboxMessageDo>[1]> = [];
    mocks.webSocketQueueBox.onAnyInboxMessageDo.mockImplementation((_id, callback) => {
        callbacks.push(callback);
        return mocks.ctx.middleware.webSocketQueueBox;
    });
    return {
        deliver: async (message) => {
            for (const callback of callbacks) {
                await callback.onMessage(message, toResourceEntry(message.payload.typeId, {}));
            }
        }
    };
}

function toDirectorCommand(typeId: string, payload: object): ALMessage {
    return toDirectorCommandAtEpoch(typeId, payload, 3);
}

function toDirectorCommandAtEpoch(typeId: string, payload: object, epoch: number): ALMessage {
    return newALUnicastMessage(
        'session-2',
        newALRoute('app.game.director', 'room-1', `${typeId}-1`),
        'session-1',
        typeId,
        {
            protocol: 'rallar.director.relay.v1',
            topicId: 'app.game.director',
            typeId,
            roomId: 'room-1',
            epoch,
            sentAtEpochMs: Date.now(),
            payload
        },
        { groupRef: { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'room-1' } }
    );
}

function mockRtcNoRoute(): void {
    mocks.rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementation(
        async (message) => ({
            status: 'no-route',
            verdict: { kind: 'unroutable' as const, reason: 'no-route' as const, detail: `No outbound transport route for message ${message.id.msgId}` },
            message,
            entries: [],
            reason: `No outbound transport route for message ${message.id.msgId}`,
            trackedReceiptAlgo: 'none'
        })
    );
}

function resetDirectorWsDoubles(): void {
    mocks.webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementation(
        async (message) => ({
            status: 'enqueued',
            verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
            message,
            entries: [],
            trackedReceiptAlgo: resolveALDeliveryReceiptAlgo(message)
        })
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

function resetDirectorApiDoubles(): void {
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

function mockGroupSnapshot(snapshot: GroupSnapshot): void {
    mockGroupSnapshots([snapshot]);
}

function mockGroupSnapshots(snapshots: readonly GroupSnapshot[]): void {
    mocks.getAllGroupStateSnapshots.mockImplementation(() => [...snapshots]);
    mocks.findGroupStateSnapshotByRef.mockImplementation((ref) =>
        snapshots.find((snapshot) =>
            snapshot.group.groupId === ref.groupId &&
            snapshot.group.applicationId === ref.applicationId &&
            snapshot.group.workspaceId === ref.workspaceId
        )
    );
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockImplementation((sessionId) =>
        snapshots.find((snapshot) => snapshot.activeSessions.some((session) => session.sessionId === sessionId))?.group
    );
}

function mockGroupRepositoryMissing(): void {
    mocks.getAllGroupStateSnapshots.mockReturnValue([]);
    mocks.findGroupStateSnapshotByRef.mockReturnValue(undefined);
    mocks.findFirstGroupStateSnapshotRefSessionIdIsIn.mockReturnValue(undefined);
}
