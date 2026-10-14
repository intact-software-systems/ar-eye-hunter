import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { RallarRtcCaptureConnectionRequiredError } from '@shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts';
import type { RallarScopedOperationOptions } from '@shared-web/browser/rallar-connection-facade.ts';
import type { RallarFacade } from '@shared-web/browser/rallar-facade-contract.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import type { RallarSessionController } from '@shared-web/browser/session/rallar-session-controller.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { configureOverlayRepositories } from '@shared/repository/overlays-repository.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { readAuthSessionContractMocks, resetAuthSessionContractMocks } from '../session/browser-auth-session-contract-fixture.ts';

const mocks = readAuthSessionContractMocks();
const roomRef: GroupRef = { applicationId: 'capture-app', workspaceId: 'capture-workspace', groupId: 'capture-room' };
type ProductOperation = 'bound-room' | 'rooms' | 'people' | 'call' | 'invite' | 'director';
installFakeBroadcastChannelPerTest();

beforeEach(async () => {
    await resetAuthSessionContractMocks();
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    const snapshot = createGroupSnapshotFixture({ ...roomRef, workspaceId: 'capture-workspace', sessionIds: [mocks.ctx.session.sessionId] });
    configureOverlayRepositories({ plannedOverlays: { ttlMs: 60_000 }, acceptedOverlays: { ttlMs: 60_000 } });
    const topology = {
        groupRef: roomRef,
        overlayId: toScopedOverlayId(roomRef),
        snapshot: null,
        acceptedSnapshot: null,
        config: {
            serverDefaults: { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 },
            durable: null,
            temporary: null,
            requestOptions: null,
            effective: { topologyKind: 'auto', degreeLimit: 5, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 }
        },
        pending: null
    };
    vi.stubGlobal('fetch', async (url: RequestInfo | URL) =>
        new Response(JSON.stringify(String(url).endsWith('/topology') ? topology : snapshot), {
            headers: {
                'cache-control': 'no-store',
                'content-type': 'application/json',
                'rallar-state-source': 'durable',
                'rallar-group-revision': '1',
                'rallar-presence-revision': '1'
            }
        }));
    onTestFinished(() => {
        vi.unstubAllGlobals();
    });
    mocks.initialiseMiddleware.mockImplementation(async (_session, _topic, options) => ({
        middleware: mocks.ctx.middleware,
        checkpoints: [],
        rtcCaptureReceipt: createBrowserRtcCapture({
            configuration: options.rtcCaptureConfiguration,
            connectionId: { status: 'observed', value: 'owned-native' },
            record: options.diagnosticsPorts.signalingDiagnostics,
            nowEpochMs: () => 1
        }).receipt
    }));
});

describe('implicit product acquisition of the owned connection', () => {
    it.each(['bound-room', 'rooms', 'people', 'call', 'invite', 'director'] as const)(
        'preserves Native during %s with no new capture selection',
        async (operation) => {
            const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
            const facade = createRallarFacade();
            onTestFinished(() => facade.disconnect());
            facade.setDefaults({ applicationId: 'capture-app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
            await facade.connect({ rtcCaptureMode: 'native' });
            const receipt = facade.rtcCapture();

            await runProductOperation(facade, operation);

            expect(facade.rtcCapture()).toBe(receipt);
            expect(receipt).toMatchObject({
                configuration: { mode: 'native', origin: 'step' },
                application: { status: 'applied', mode: 'native' },
                connectionId: { status: 'observed', value: 'owned-native' }
            });
            expect(facade.isConnected()).toBe(true);
        }
    );

    it('joins a pending Native connection during room refresh', async () => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const construct = mocks.initialiseMiddleware.getMockImplementation()!;
        mocks.initialiseMiddleware.mockImplementation(async (...args) => {
            const connected = await construct(...args);
            entered.resolve();
            await release.promise;
            return connected;
        });
        onTestFinished(async () => {
            release.resolve();
            await facade.disconnect();
        });
        facade.setDefaults({ applicationId: 'capture-app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
        const first = facade.connect({ rtcCaptureMode: 'native' });
        await entered.promise;
        const refreshing = facade.rooms.session(roomRef).refresh().then(() => 'refreshed', (error: Error) => error);
        release.resolve();
        await first;

        expect(await refreshing).toBe('refreshed');
        expect(facade.rtcCapture()).toMatchObject({
            configuration: { mode: 'native', origin: 'step' },
            application: { status: 'applied', mode: 'native' }
        });
    });

    it.each([{ rtcCaptureMode: 'off' }, { rtcCaptureContext: { recipe: 'off' } }] as const)(
        'rejects an incompatible explicit product selection $rtcCaptureMode $rtcCaptureContext',
        async (capture) => {
            const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
            const facade = createRallarFacade();
            onTestFinished(() => facade.disconnect());
            await facade.connect({ rtcCaptureMode: 'native' });
            const receipt = facade.rtcCapture();

            await expect(facade.rooms.session(roomRef).refresh(capture)).rejects.toBeInstanceOf(RallarRtcCaptureConnectionRequiredError);

            expect(facade.rtcCapture()).toBe(receipt);
            expect(facade.isConnected()).toBe(true);
        }
    );

    it('preserves scoped operation options at the acquired connection boundary', async () => {
        const session = await createOwnedSession();
        onTestFinished(() => session.disconnect());
        const controller = new AbortController();
        const options: RallarScopedOperationOptions = {
            scope: { applicationId: 'capture-app', workspaceId: 'capture-workspace' },
            rtcCaptureMode: 'off',
            timeoutMs: 500,
            signal: controller.signal,
            maxPeerConnections: 7
        };

        await session.acquireConnection(options);

        expect(mocks.initialiseMiddleware.mock.calls[0]?.[2]).toMatchObject({
            scope: { applicationId: 'capture-app', workspaceId: 'capture-workspace' },
            timeoutMs: 500,
            signal: controller.signal,
            maxPeerConnections: 7,
            rtcCaptureConfiguration: { mode: 'off', origin: 'step' }
        });
    });

    it('snapshots explicit capture before acquisition yields to authentication', async () => {
        const session = await createOwnedSession();
        onTestFinished(() => session.disconnect());
        const context: { run: 'off' | 'native'; } = { run: 'off' };
        const acquiring = session.acquireConnection({ rtcCaptureContext: context });
        context.run = 'native';

        await acquiring;

        expect(session.connectionOperations.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        expect(context.run).toBe('native');
    });
});

async function createOwnedSession(): Promise<RallarSessionController> {
    const { createBrowserRuntimeFoundation } = await import('@shared-web/browser/composition/browser-runtime-composition.ts');
    const { browserDeliveryComposition } = await import('@shared-web/browser/composition/browser-delivery-composition.ts');
    const { BrowserSessionDeliveries } = await import('@shared-web/browser/messages/browser-session-deliveries.ts');
    const { createRallarSessionController } = await import('@shared-web/browser/session/rallar-session-controller.ts');
    const foundation = createBrowserRuntimeFoundation();
    return createRallarSessionController({
        qosProvider: undefined,
        readVolatileSessionLimits: undefined,
        sessionDeliveries: new BrowserSessionDeliveries(browserDeliveryComposition.deliveries, foundation.transportRuntime, mocks.readSession),
        onResyncRequired: () => {},
        connectionRuntime: foundation.connectionRuntime,
        transportRuntime: foundation.transportRuntime,
        authRuntime: foundation.authRuntime,
        stateRuntime: foundation.runtime,
        lifecycle: foundation.lifecycle,
        emitState: () => {},
        closeDataScopes: async () => {}
    });
}

async function runProductOperation(facade: RallarFacade, operation: ProductOperation): Promise<void> {
    switch (operation) {
        case 'bound-room': {
            const room = facade.rooms.session(roomRef);
            expect((await room.refresh()).roomRef).toEqual(roomRef);
            break;
        }
        case 'rooms':
            expect(await facade.rooms.refresh()).toMatchObject({ rooms: expect.any(Array) });
            break;
        case 'people':
            expect(await facade.people.refresh()).toMatchObject({ people: expect.any(Array) });
            break;
        case 'call': {
            const call = await facade.calls.start({ callId: 'capture-call', peerIds: [] });
            expect(call.status()).toMatchObject({ callId: 'capture-call', state: 'empty' });
            await call.end();
            break;
        }
        case 'invite':
            expect(await facade.calls.invite({ callId: 'capture-invite', peerIds: [] })).toEqual({
                callId: 'capture-invite',
                peerIds: [],
                signals: []
            });
            break;
        case 'director':
            expect(await facade.director.appoint(roomRef)).toMatchObject({ roomRef, state: 'none' });
            break;
    }
}
