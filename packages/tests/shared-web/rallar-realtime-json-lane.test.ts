import type { QRtcPeerDto } from '@shared/services/WebRtcConnectionService.ts';
import type { QRtcDataChannel, RtcDataChannelSendResult, RtcRawMessageCallback } from '@shared/webrtc/QRtcDataChannel.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AppContextModule = typeof import('@shared-web/browser/app-context.ts');
type MiddlewareModule = typeof import('@shared-web/browser/middleware.ts');
type StateCacheLifecycleModule = typeof import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
type AuthModule = typeof import('@shared/api/auth.ts');
type ClientStateSnapshotsRepositoryModule = typeof import('@shared/repository/client-state-snapshots-repository.ts');
type GroupStateSnapshotsRepositoryModule = typeof import('@shared/repository/group-state-snapshots-repository.ts');

interface GameplayPosition {
    readonly x: number;
}

const mocks = await vi.hoisted(async () => {
    const { createApiMiddlewareTestDouble } = await import(
        './api-middleware-test-double.ts'
    );
    const ctx = createApiMiddlewareTestDouble();
    const throwClientRepositoryMissing = () => {
        throw new Error(
            'Repository not found: shared.repository.client-state-snapshots'
        );
    };
    const throwGroupRepositoryMissing = () => {
        throw new Error(
            'Repository not found: shared.repository.group-state-snapshots'
        );
    };

    return {
        ctx,
        webRtcConnectionService: ctx.middleware.webRtcConnectionService,
        throwClientRepositoryMissing,
        throwGroupRepositoryMissing,
        hydrateStateCache: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['hydrate']>(() => Promise.resolve()),
        initMiddleware: vi.fn<AppContextModule['initMiddleware']>(() => Promise.resolve(ctx)),
        isMiddlewareReady: vi.fn<AppContextModule['isMiddlewareReady']>(() => false),
        onCacheChange: vi.fn<StateCacheLifecycleModule['browserStateCacheLifecycle']['onChange']>(() => vi.fn()),
        readSession: vi.fn<AuthModule['readSession']>(() => ctx.session),
        clientRepositoryMissing: vi.fn(throwClientRepositoryMissing),
        groupRepositoryMissing: vi.fn(throwGroupRepositoryMissing)
    };
});

vi.mock(
    import('@shared-web/browser/middleware.ts'),
    (): Partial<MiddlewareModule> => ({
        initialiseMiddleware: async (_session, _topic, options) => (await mocks.initMiddleware(options)).middleware
    })
);

vi.mock(
    import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts'),
    (): Partial<StateCacheLifecycleModule> => ({
        browserStateCacheLifecycle: {
            hydrate: mocks.hydrateStateCache,
            onChange: mocks.onCacheChange,
            initialise: vi.fn()
        }
    })
);

vi.mock(import('@shared/api/auth.ts'), (): Partial<AuthModule> => ({
    clearSession: vi.fn(),
    isLoggedIn: vi.fn(() => true),
    readSession: mocks.readSession,
    writeSession: vi.fn()
}));

vi.mock(
    import('@shared/repository/client-state-snapshots-repository.ts'),
    (): Partial<ClientStateSnapshotsRepositoryModule> => ({
        findClientStateSnapshotByPrincipalId: mocks.clientRepositoryMissing,
        getAllClientStateSnapshots: mocks.clientRepositoryMissing
    })
);

vi.mock(
    import('@shared/repository/group-state-snapshots-repository.ts'),
    (): Partial<GroupStateSnapshotsRepositoryModule> => ({
        findFirstGroupStateSnapshotRefSessionIdIsIn: mocks.groupRepositoryMissing,
        findGroupStateSnapshotByRef: mocks.groupRepositoryMissing,
        getAllGroupStateSnapshots: mocks.groupRepositoryMissing
    })
);

describe('Rallar realtime JSON lane', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.clientRepositoryMissing.mockImplementation(
            (principalId?: string): never => (principalId === undefined ? [] : undefined) as never
        );
        mocks.groupRepositoryMissing.mockImplementation(
            (value?: string): never => (value === undefined ? [] : undefined) as never
        );
        mocks.hydrateStateCache.mockResolvedValue(undefined);
        mocks.initMiddleware.mockResolvedValue(mocks.ctx);
        mocks.isMiddlewareReady.mockReturnValue(false);
        mocks.readSession.mockReturnValue(mocks.ctx.session);
        vi.mocked(mocks.webRtcConnectionService.activePeerIds).mockReturnValue([]);
        vi.mocked(mocks.webRtcConnectionService.readPeer).mockReturnValue(undefined);
    });

    it('sends and listens through a typed realtime JSON lane', async () => {
        const { createRallarFacade } = await import(
            '@shared-web/browser/rallar.ts'
        );
        const rawCallbacks = new Map<string, RtcRawMessageCallback>();
        const sendResult: RtcDataChannelSendResult = {
            status: 'sent',
            bufferedAmount: 0
        };
        const sendJson = vi.fn(() => sendResult);
        const gameplayChannel: QRtcDataChannel = toWebRtcTestDouble<QRtcDataChannel>({
            sendJson,
            onRawMessageDo: vi.fn((id: string, callback: RtcRawMessageCallback) => {
                rawCallbacks.set(id, callback);
                return gameplayChannel;
            }),
            removeOnRawMessageCallbackById: vi.fn(() => true)
        });
        const peer = toWebRtcTestDouble<QRtcPeerDto>({
            peerId: 'peer-1',
            channels: new Map([['gameplay', gameplayChannel]])
        });
        vi.mocked(mocks.webRtcConnectionService.activePeerIds).mockReturnValue([
            'peer-1'
        ]);
        vi.mocked(mocks.webRtcConnectionService.readPeer).mockReturnValue(peer);
        vi.mocked(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .mockResolvedValueOnce({
                status: 'open',
                peerId: 'peer-1',
                laneId: 'gameplay',
                channel: gameplayChannel
            });
        const facade = createRallarFacade();
        const gameplay = facade.realtime.json<GameplayPosition>({
            laneId: 'gameplay',
            peerIds: ['peer-1'],
            openTimeoutMs: 750,
            key: 'player-1',
            maxAgeMs: 250
        });
        const onMessage = vi.fn();

        gameplay.on(onMessage);
        await facade.connect();
        const sendResults = await gameplay.send({
            x: 1
        });
        await rawCallbacks.get('rallar:realtime:gameplay')?.onMessage?.(
            JSON.stringify({
                x: 2
            }),
            new MessageEvent('message', {
                data: JSON.stringify({
                    x: 2
                })
            })
        );

        expect(mocks.webRtcConnectionService.ensurePeerLaneOpen)
            .toHaveBeenCalledWith(
                'peer-1',
                'gameplay',
                expect.objectContaining({
                    timeoutMs: 750
                })
            );
        expect(sendJson).toHaveBeenCalledWith(
            {
                x: 1
            },
            expect.objectContaining({
                key: 'player-1',
                maxAgeMs: 250
            })
        );
        expect(sendResults).toEqual([
            {
                peerId: 'peer-1',
                laneId: 'gameplay',
                result: sendResult
            }
        ]);
        expect(onMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                peerId: 'peer-1',
                laneId: 'gameplay',
                data: {
                    x: 2
                }
            })
        );
    });
});

// QRtcDataChannel and the peer DTO it hangs off are concrete WebRTC runtime values that cannot be
// instantiated in a unit test; only the members the facade calls are supplied, and their shapes stay
// checked against the production types.
function toWebRtcTestDouble<TValue>(members: Partial<TValue>): TValue {
    return members as TValue;
}
