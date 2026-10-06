// dprint-ignore
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { BlackBoxBrowserRallarRuntimeDependency } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { refreshBlackBoxBrowserRoomState } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/refresh-black-box-browser-room-state.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { RallarRtcCaptureConnectionRequiredError } from '@shared-web/browser/connection/rallar-rtc-capture-connection-required-error.ts';
import { createBrowserRtcCapture } from '@shared-web/browser/rtc/create-browser-rtc-capture.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type {
    GroupRef,
    GroupSnapshot
} from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope
} from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findAcceptedOverlayById, findPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createDefaultApiMiddlewareTestDouble } from '../../shared-web/api-middleware-test-double.ts';
import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import { installFakeBroadcastChannelPerTest } from '../../shared-web/data/rallar-data-test-runtime.ts';

installFakeBroadcastChannelPerTest();

const scope: StateScope = {
    applicationId: DEFAULT_STATE_APPLICATION_ID,
    workspaceId: DEFAULT_STATE_WORKSPACE_ID
};

const authSession: AuthSession = {
    clientId: 'session-a',
    accessToken: 'test-token',
    username: 'alice',
    sessionId: 'session-a',
    expiresAtEpochMs: Date.now() + 60_000
};

interface TestTopologyView {
    readonly groupRef: GroupRef;
    readonly overlayId: string;
    readonly snapshot: RallarOverlayTopologySnapshot | null;
    readonly acceptedSnapshot: RallarOverlayTopologySnapshot | null;
    readonly config: null;
    readonly pending: null;
}

describe('black-box browser room-state refresh composition', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('refreshes and hydrates through the owned Native runtime without changing its connection', async () => {
        const group = createGroupSnapshot();
        const planned = createTopologySnapshot(group, 4);
        const accepted = createTopologySnapshot(group, 3);
        const fetch = vi.fn(async (url: RequestInfo | URL) =>
            new Response(JSON.stringify(String(url).endsWith('/topology') ? topologyView(group, planned, accepted) : group), {
                headers: {
                    'cache-control': 'no-store',
                    'content-type': 'application/json',
                    'rallar-state-source': 'durable',
                    'rallar-group-revision': String(group.causalRevision.groupRevision),
                    'rallar-presence-revision': String(group.causalRevision.presenceRevision)
                }
            })
        );
        vi.stubGlobal('fetch', fetch);
        const runtime = await createOwnedRuntime();
        onTestFinished(() => runtime.disconnect());
        await runtime.connect({ rtcCaptureMode: 'native' });
        const receipt = runtime.rtcCapture();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);

        const result = await runtime.refreshRoomState(groupRefOf(group), { scope, timeoutMs: 1_000 })
            .then(() => 'refreshed', (error: Error) => error);

        expect(result).toBe('refreshed');
        expect(runtime.rtcCapture()).toBe(receipt);
        expect(receipt).toMatchObject({
            configuration: { mode: 'native', origin: 'step' },
            application: { status: 'applied', mode: 'native' }
        });
        expect(runtime.isConnected()).toBe(true);
        const overlayId = toScopedOverlayId(group.group);
        expect(findPlannedOverlayById(overlayId)?.overlayVersion).toBe(4);
        expect(findAcceptedOverlayById(overlayId)?.overlayVersion).toBe(3);
        expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/topology'))).toBe(true);
        await expect(runtime.connect()).rejects.toBeInstanceOf(RallarRtcCaptureConnectionRequiredError);
        await expect(runtime.refreshRoomState(groupRefOf(group), { scope, timeoutMs: 1_000, rtcCaptureMode: 'off' }))
            .rejects.toBeInstanceOf(RallarRtcCaptureConnectionRequiredError);
        expect(runtime.rtcCapture()).toBe(receipt);
    });

    it('enforces one caller deadline across a stalled topology hydration', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        let stalledSignal: AbortSignal | null = null;
        vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
            stalledSignal = init?.signal ?? null;
            return new Promise<Response>(() => undefined);
        });

        const refresh = refreshBlackBoxBrowserRoomState({
            ...createRefreshInput(group),
            options: { scope, timeoutMs: 5 }
        });

        await expect(refresh).rejects.toMatchObject({
            name: 'TimeoutError',
            message: 'Room state refresh timed out after 5 ms.'
        });
        expect(stalledSignal).toMatchObject({ aborted: true });
    });

    it('rejects caller cancellation even when topology hydration classifies abort as read-failed', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const requestStarted = Promise.withResolvers<void>();
        vi.stubGlobal('fetch', () => {
            requestStarted.resolve();
            return new Promise<Response>(() => undefined);
        });
        const controller = new AbortController();
        const reason = new Error('caller cancelled room refresh');
        const refresh = refreshBlackBoxBrowserRoomState({
            ...createRefreshInput(group),
            options: { scope, signal: controller.signal, timeoutMs: 1_000 }
        });
        await requestStarted.promise;

        controller.abort(reason);

        await expect(refresh).rejects.toBe(reason);
    });

    it('removes the private abort-race listener after a successful refresh', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => jsonResponse(topologyView(group, null, null)))
        );
        const addEventListener = vi.spyOn(AbortSignal.prototype, 'addEventListener');
        const removeEventListener = vi.spyOn(AbortSignal.prototype, 'removeEventListener');

        await refreshBlackBoxBrowserRoomState({
            ...createRefreshInput(group),
            options: { scope, timeoutMs: 1_000 }
        });

        const abortRegistration = addEventListener.mock.calls.find(([event]) => event === 'abort');
        expect(abortRegistration).toBeDefined();
        expect(removeEventListener).toHaveBeenCalledWith(
            'abort',
            abortRegistration?.[1]
        );
    });

    it('hydrates and clears both topology roles through the production refresh operation', async () => {
        const group = createGroupSnapshot();
        groupStateSnapshotsRepository.setGroupStateSnapshot(group);
        const planned = createTopologySnapshot(group, 4);
        const accepted = createTopologySnapshot(group, 3);
        const responses: TestTopologyView[] = [
            topologyView(group, planned, accepted),
            topologyView(group, null, null)
        ];
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(nextTopologyView(responses))));
        const input = createRefreshInput(group);

        await refreshBlackBoxBrowserRoomState({
            ...input,
            options: { scope, timeoutMs: 1_000 }
        });

        const overlayId = toScopedOverlayId(group.group);
        expect(findPlannedOverlayById(overlayId)?.overlayVersion).toBe(4);
        expect(findAcceptedOverlayById(overlayId)?.overlayVersion).toBe(3);

        await refreshBlackBoxBrowserRoomState({
            ...input,
            options: { scope, timeoutMs: 1_000 }
        });

        expect(findPlannedOverlayById(overlayId)).toBeUndefined();
        expect(findAcceptedOverlayById(overlayId)).toBeUndefined();
    });
});

async function createOwnedRuntime(): Promise<BlackBoxBrowserRallarRuntimeDependency> {
    const auth = await import('@shared/api/auth.ts');
    const cache = await import('@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts');
    const middleware = await import('@shared-web/browser/connection/initialise-browser-middleware.ts');
    const { createBlackBoxBrowserRallarRuntimeDependency } = await import(
        '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts'
    );
    const { BlackBoxRallarVolatileLimits } = await import(
        '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-volatile-limits.ts'
    );
    const context = createDefaultApiMiddlewareTestDouble({
        session: authSession,
        middleware: { webRtcGroupManager: createWebRtcGroupManager() }
    });
    vi.spyOn(auth, 'readSession').mockReturnValue(authSession);
    vi.spyOn(cache.browserStateCacheLifecycle, 'hydrate').mockResolvedValue();
    vi.spyOn(middleware, 'initialiseMiddleware').mockImplementation(async (_session, _topic, options) => ({
        middleware: context.middleware,
        checkpoints: [],
        rtcCaptureReceipt: createBrowserRtcCapture({
            configuration: options.rtcCaptureConfiguration,
            connectionId: { status: 'observed', value: 'owned-native' },
            record: options.diagnosticsPorts.signalingDiagnostics,
            nowEpochMs: () => 1
        }).receipt
    }));
    configureApiClient({ apiBaseUrl: 'https://api.example.test' });
    const limits = new BlackBoxRallarVolatileLimits();
    const runtime = createBlackBoxBrowserRallarRuntimeDependency({ readVolatileSessionLimits: limits.get });
    runtime.setDefaults({ ...scope, diagnosticsPorts: { signalingDiagnostics: () => {} } });
    return runtime;
}

function createRefreshInput(group: GroupSnapshot): Omit<Parameters<typeof refreshBlackBoxBrowserRoomState>[0], 'options'> {
    const manager = createWebRtcGroupManager();
    return {
        roomRef: group.group,
        rooms: {
            session: vi.fn(() => ({
                refresh: vi.fn(async () => ({ snapshot: () => group }))
            }))
        },
        session: {
            acquireConnection: vi.fn(async () => ({
                session: authSession,
                middleware: { webRtcGroupManager: manager }
            }))
        }
    } as const;
}

function createWebRtcGroupManager(): Pick<WebRtcGroupManager, 'notifyOverlayTopologyChanged'> {
    return {
        notifyOverlayTopologyChanged: vi.fn(async () => undefined)
    };
}

function jsonResponse(body: TestTopologyView): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function nextTopologyView(responses: TestTopologyView[]): TestTopologyView {
    const response = responses.shift();
    if (!response) {
        throw new Error('Topology response fixture was exhausted.');
    }
    return response;
}

function topologyView(
    group: GroupSnapshot,
    snapshot: RallarOverlayTopologySnapshot | null,
    acceptedSnapshot: RallarOverlayTopologySnapshot | null
): TestTopologyView {
    return {
        groupRef: groupRefOf(group),
        overlayId: toScopedOverlayId(group.group),
        snapshot,
        acceptedSnapshot,
        config: null,
        pending: null
    };
}

function createGroupSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...scope, groupId: 'room-a', sessionIds: ['session-a', 'session-b'] });
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: Date.now() + 120_000 }))
    };
}

function createTopologySnapshot(
    group: GroupSnapshot,
    version: number
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: groupRefOf(group),
        name: group.group.displayName,
        topology: 'mesh',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a']
        },
        degreeLimit: 1,
        version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version
    };
}

function groupRefOf(group: GroupSnapshot): GroupRef {
    return {
        applicationId: group.group.applicationId,
        workspaceId: group.group.workspaceId,
        groupId: group.group.groupId
    };
}
