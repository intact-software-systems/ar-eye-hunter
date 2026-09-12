import type * as MiddlewareModule from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { createRallarFacade } from '@shared-web/browser/rallar.ts';
import { AL_DELIVERY_ADMITTED_STATES } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type * as AuthModule from '@shared/api/auth.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isRallarValidationError } from '@shared/api/rallar-validation.ts';
import type * as GroupStateSnapshotsRepositoryModule from '@shared/repository/group-state-snapshots-repository.ts';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

interface GroupSnapshotFixtureScope {
    readonly applicationId?: string;
    readonly workspaceId?: string;
}

const mocks = await vi.hoisted(async () => {
    const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
    return {
        ctx: createDefaultApiMiddlewareTestDouble(),
        findFirstGroupStateSnapshotRefSessionIdIsIn: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findFirstGroupStateSnapshotRefSessionIdIsIn>(),
        findGroupStateSnapshotByRef: vi.fn<typeof GroupStateSnapshotsRepositoryModule.findGroupStateSnapshotByRef>(),
        getAllGroupStateSnapshots: vi.fn<typeof GroupStateSnapshotsRepositoryModule.getAllGroupStateSnapshots>()
    };
});
vi.mock(import('@shared-web/browser/connection/initialise-browser-middleware.ts'), async (original): Promise<typeof MiddlewareModule> => ({
    ...await original(),
    initialiseMiddleware: async () => mocks.ctx.middleware
}));
vi.mock(import('@shared/api/auth.ts'), async (original): Promise<typeof AuthModule> => ({
    ...await original(),
    readSession: () => mocks.ctx.session,
    isLoggedIn: () => true
}));
vi.mock(import('@shared/repository/group-state-snapshots-repository.ts'), async (original): Promise<typeof GroupStateSnapshotsRepositoryModule> => ({
    ...await original(),
    findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.findFirstGroupStateSnapshotRefSessionIdIsIn,
    findGroupStateSnapshotByRef: mocks.findGroupStateSnapshotByRef,
    getAllGroupStateSnapshots: mocks.getAllGroupStateSnapshots
}));
let qboxEngine = vi.mocked(mocks.ctx.middleware.qboxEngine);
let rtcRxStreamer = vi.mocked(mocks.ctx.middleware.rtcRxStreamer);
let webSocketQueueBox = vi.mocked(mocks.ctx.middleware.webSocketQueueBox);

describe('Rallar message send', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        configureTestCacheRepositories();
        const { createDefaultApiMiddlewareTestDouble } = await import('../api-middleware-test-double.ts');
        mocks.ctx = createDefaultApiMiddlewareTestDouble();
        qboxEngine = vi.mocked(mocks.ctx.middleware.qboxEngine);
        rtcRxStreamer = vi.mocked(mocks.ctx.middleware.rtcRxStreamer);
        webSocketQueueBox = vi.mocked(mocks.ctx.middleware.webSocketQueueBox);
        mockGroupSnapshots([]);
    });

    it('rejects invalid WS user topics before queueing', async () => {
        await expect(
            createFacade().messages.ws.send({
                scope: 'all',
                topicId: 'manual.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'invalid topic' }
            })
        ).rejects.toSatisfy(isRallarValidationError);
    });

    it('rejects room-scoped WS sends without a room target before queueing', async () => {
        await expect(
            createFacade().messages.ws.send({
                scope: 'room',
                topicId: 'room.chat',
                typeId: 'chat.message.v1',
                payload: { text: 'missing room' }
            })
        ).rejects.toSatisfy(isRallarValidationError);
    });

    it('rejects invalid RTC room ids before connecting or queueing', async () => {
        await expect(
            createFacade().messages.rtc.send({
                roomId: 'bad room',
                typeId: 'chat.message.v1',
                payload: { text: 'invalid room' }
            })
        ).rejects.toSatisfy(isRallarValidationError);
    });

    it('rejects corrupt and oversized message payloads before queueing', async () => {
        const facade = createFacade();
        facade.setDefaults({
            applicationId: 'app-1',
            messages: {
                maxPayloadBytes: 8
            }
        });

        await expect(facade.messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            payload: 1n
        })).rejects.toSatisfy(isRallarValidationError);
        const oversized = await facade.messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            payload: { text: 'too large' }
        });
        expect((await oversized.wait()).lifecycle.state).toBe('rejected');
    });

    it('records an unroutable RTC failure with the original scoped envelope', async () => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'no-route',
                verdict: {
                    kind: 'unroutable' as const,
                    reason: 'no-route' as const,
                    detail: 'Skipping RTC outbound dispatch without planned transport messages'
                },
                message,
                entries: [],
                reason: 'Skipping RTC outbound dispatch without planned transport messages'
            })
        );
        const room = createGroupSnapshot('room-1', ['session-1', 'peer-1']);
        mockGroupSnapshot(room);

        const result = await createFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-quiet',
            payload: {
                text: 'quiet outcome'
            }
        });

        expect((await result.wait()).lifecycle).toMatchObject({
            state: 'failed',
            evidence: { reason: 'Skipping RTC outbound dispatch without planned transport messages' }
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0]).toMatchObject({
            id: {
                senderId: 'session-1'
            },
            route: {
                topicId: 'chat.message.v1',
                resourceId: 'msg-quiet',
                contextId: 'room-1'
            },
            targets: {
                mode: 'multicast',
                groupRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                }
            },
            forwarding: {
                overlayId: toScopedOverlayId(room.group)
            }
        });
    });

    it('delegates RTC routing when the room cache is temporarily absent', async () => {
        const result = await createFacade().messages.rtc.send({
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            nextHopPeerIds: ['peer-1'],
            typeId: 'chat.message.v1',
            resourceId: 'msg-cache-lag',
            payload: {
                text: 'route through the transport runtime'
            }
        });

        expect((await result.wait({ until: AL_DELIVERY_ADMITTED_STATES })).lifecycle.state).toBe('queued');
    });

    it('wakes the queue-box engine when RTC send queues durable outbox work', async () => {
        rtcRxStreamer.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'enqueued',
                verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                message,
                entries: []
            })
        );
        const engineEvents: string[] = [];
        qboxEngine.wake.mockImplementation(() => {
            engineEvents.push('wake');
        });
        mockGroupSnapshot(createGroupSnapshot('room-1', ['session-1', 'peer-1']));

        const sent = await createFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-rtc',
            payload: {
                text: 'queued rtc'
            }
        });

        await sent.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(engineEvents).toEqual(['wake']);
    });

    it('adds cached room snapshotVersion as minSnapshotVersion on RTC room sends', async () => {
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            7
        ));

        const result = await createFacade().messages.rtc.send({
            roomId: 'room-1',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc',
            payload: {
                text: 'versioned rtc'
            }
        });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            minSnapshotVersion: 7
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).not.toHaveProperty('groupId');
    });

    it('uses roomRef scope for cached snapshotVersion on RTC room sends', async () => {
        const workspaceA = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-a'],
                {
                    workspaceId: 'workspace-a'
                }
            ),
            7
        );
        const workspaceB = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-b'],
                {
                    workspaceId: 'workspace-b'
                }
            ),
            11
        );
        mockGroupSnapshots([workspaceA, workspaceB]);

        const result = await createFacade().messages.rtc.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-rtc-scoped',
            payload: {
                text: 'versioned scoped rtc'
            }
        });

        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'multicast',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room'
            },
            minSnapshotVersion: 11
        });
        expect(rtcRxStreamer.enqueueOutboxIfAbsent.mock.calls[0][0].targets).not.toHaveProperty('groupId');
    });

    it('records WS admission and keeps the original broadcast envelope', async () => {
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'accepted',
                verdict: { kind: 'admitted' as const, durable: false, queuedAttempts: 1 },
                message,
                entries: []
            })
        );
        const engineEvents: string[] = [];
        qboxEngine.wake.mockImplementation(() => {
            engineEvents.push('wake');
        });

        const result = await createFacade().messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-ws',
            payload: {
                text: 'ws outcome'
            }
        });

        await result.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(engineEvents).toEqual(['wake']);
        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0]).toMatchObject({
            id: {
                senderId: 'session-1'
            },
            route: {
                topicId: 'app.chat',
                resourceId: 'msg-ws',
                contextId: 'all'
            },
            targets: {
                mode: 'broadcast',
                scope: 'all'
            }
        });
    });

    it('wakes the queue-box engine when WS send queues durable outbox work', async () => {
        webSocketQueueBox.enqueueOutboxIfAbsent.mockImplementationOnce(
            async (message) => ({
                status: 'enqueued',
                verdict: { kind: 'admitted' as const, durable: true, queuedAttempts: 1 },
                message,
                entries: []
            })
        );
        const engineEvents: string[] = [];
        qboxEngine.wake.mockImplementation(() => {
            engineEvents.push('wake');
        });

        const sent = await createFacade().messages.ws.send({
            scope: 'all',
            topicId: 'app.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-queued-ws',
            payload: {
                text: 'queued ws'
            }
        });

        await sent.wait({ until: AL_DELIVERY_ADMITTED_STATES });
        expect(engineEvents).toEqual(['wake']);
    });

    it('adds cached room snapshotVersion as minSnapshotVersion on WS room sends', async () => {
        mockGroupSnapshot(withSnapshotVersion(
            createGroupSnapshot('room-1', ['session-1', 'peer-1']),
            11
        ));

        const result = await createFacade().messages.ws.send({
            roomId: 'room-1',
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws',
            payload: {
                text: 'versioned ws'
            }
        });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            minSnapshotVersion: 11
        });
    });

    it('uses roomRef scope for cached snapshotVersion and target groupRef on WS room sends', async () => {
        const workspaceA = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-a'],
                {
                    workspaceId: 'workspace-a'
                }
            ),
            5
        );
        const workspaceB = withSnapshotVersion(
            createGroupSnapshot(
                'shared-room',
                ['session-1', 'peer-b'],
                {
                    workspaceId: 'workspace-b'
                }
            ),
            13
        );
        mockGroupSnapshots([workspaceA, workspaceB]);

        const result = await createFacade().messages.ws.send({
            roomId: 'shared-room',
            roomRef: workspaceB.group,
            topicId: 'room.chat',
            typeId: 'chat.message.v1',
            resourceId: 'msg-versioned-ws-scoped',
            payload: {
                text: 'versioned scoped ws'
            }
        });

        expect(webSocketQueueBox.enqueueOutboxIfAbsent.mock.calls[0][0].targets).toMatchObject({
            mode: 'broadcast',
            scope: 'room',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-b',
                groupId: 'shared-room'
            },
            minSnapshotVersion: 13
        });
    });
});

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

function withSnapshotVersion(
    snapshot: GroupSnapshot,
    snapshotVersion: number
): GroupSnapshot {
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            snapshotVersion
        }
    };
}

function createGroupSnapshot(
    groupId: string,
    sessionIds: readonly string[],
    scope: GroupSnapshotFixtureScope = {}
): GroupSnapshot {
    const applicationId = scope.applicationId ?? 'app-1';
    const workspaceId = scope.workspaceId ?? 'workspace-1';
    return createGroupSnapshotFixture({
        applicationId,
        workspaceId,
        groupId,
        sessionIds
    });
}

function createFacade() {
    const facade = createRallarFacade();
    onTestFinished(() => facade.disconnect());
    return facade;
}
