import 'fake-indexeddb/auto';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import {
    BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON,
    configureBrowserRtcPeerCreationPolicies
} from '@shared-web/browser/connection/initialise-browser-middleware.ts';
import { newALEventRoute, newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import {
    createDefaultInMemoryALInboundRuntimeStores,
    createDefaultInMemoryALOutboundRuntimeStores,
    createVolatileALInboundRuntimeStores
} from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { createPassThroughIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { createDefaultWsQueueBoxClientService } from '@shared/services/ws-queue-box-client-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { WsRtcSignalingTransportUsingWsQBox } from '@shared/webrtc/ws-rtc-signaling-transport-using-ws-q-box.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';

import { createInboundTestStores } from '../../shared/alm/inbound-runtime-test-fixture.ts';
import { installNativeRtcRuntime, type NativeRtcRuntime } from '../../shared/native-rtc-connection-fixture.ts';
import { DeterministicRtcOfferIds } from '../../shared/webrtc/deterministic-rtc-offer-ids.ts';
import { TestWebSocket } from '../../shared/websocket/test-web-socket.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

/** The browser's own pair for a volatile signal, or an IndexedDB pair that takes every message. */
type HeldOfferPair = 'volatile-memory' | 'durable-indexeddb';

interface HeldOfferRuntime {
    readonly nativeRuntime: NativeRtcRuntime;
    readonly socket: TestWebSocket;
    readonly manager: WebRtcGroupManager;
    readonly acceptedOverlays: LatestRepository<string, OverlayInfo>;
    readonly group: GroupSnapshot;
    readonly diagnostics: readonly ALInboundRuntimeDiagnosticsEvent[];
}

const SELF = 'a-self';
const SENDER = 'z-sender';
const SIGNALING_TYPE = 'rtc';
const RETRY_ATTEMPT_WITH_ONE_SECOND_DUE = 6;
/**
 * One engine pass after work (100 ms, stretched by up to 20 %) with room for the IndexedDB requests.
 * Without the adoption the held row stays waiting for 800 ms or more.
 */
const ONE_ENGINE_ROUND_MS = 150;

afterEach(() => {
    TestWebSocket.instances.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it.each(['volatile-memory', 'durable-indexeddb'] satisfies HeldOfferPair[])(
    'applies an offer held at its 1 s retry within one engine round of adopting the layout (%s)',
    async (pair) => {
        const runtime = await createHeldOfferRuntime(pair);
        runtime.socket.receive(toOfferEnvelope('held-offer'));
        await advanceUntilRetried(runtime, 'held-offer', RETRY_ATTEMPT_WITH_ONE_SECOND_DUE);
        await advanceTime(ONE_ENGINE_ROUND_MS);
        expect(readRemoteOfferTypes(runtime)).toEqual([]);

        runtime.acceptedOverlays.set(toScopedOverlayId(runtime.group.group), acceptedOverlay(runtime.group));
        await runtime.manager.notifyOverlayTopologyChanged();
        await advanceTime(ONE_ENGINE_ROUND_MS);

        expect(readRemoteOfferTypes(runtime)).toEqual(['offer']);
        expect(readRetriedCount(runtime, 'held-offer')).toBe(RETRY_ATTEMPT_WITH_ONE_SECOND_DUE);
    }
);

it('leaves an offer held while the adopted layout still refuses its peer on its own retry schedule', async () => {
    const runtime = await createHeldOfferRuntime('volatile-memory');
    runtime.socket.receive(toOfferEnvelope('held-offer'));
    await advanceUntilRetried(runtime, 'held-offer', RETRY_ATTEMPT_WITH_ONE_SECOND_DUE);

    runtime.acceptedOverlays.set(toScopedOverlayId(runtime.group.group), {
        ...acceptedOverlay(runtime.group),
        nextHopSessionIds: []
    });
    await runtime.manager.notifyOverlayTopologyChanged();
    await advanceTime(ONE_ENGINE_ROUND_MS);

    expect(readRetriedCount(runtime, 'held-offer')).toBe(RETRY_ATTEMPT_WITH_ONE_SECOND_DUE);
    expect(readRemoteOfferTypes(runtime)).toEqual([]);
});

async function createHeldOfferRuntime(pair: HeldOfferPair): Promise<HeldOfferRuntime> {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const nativeRuntime = installNativeRtcRuntime();
    vi.stubGlobal('WebSocket', TestWebSocket);
    const queueEngine = new InboxOutboxEngine();
    const diagnostics: ALInboundRuntimeDiagnosticsEvent[] = [];
    const queueBoxClient = createDefaultWsQueueBoxClientService({
        queueEngine,
        socket: new JsonWebSocketClient('ws://signaling-test', createPassThroughTransportFaultPort()),
        outbox: new InMemoryQueueBox(),
        sessionId: SELF,
        serverPeerId: undefined,
        inboundStores: pair === 'durable-indexeddb'
            ? createInboundTestStores({ namespace: 'held-offer', storage: 'indexeddb', observer: createPassThroughIndexedDbOperationObserver() })
            : createDefaultInMemoryALInboundRuntimeStores({ namespace: 'held-offer' }),
        inboundVolatileStores: pair === 'volatile-memory'
            ? createVolatileALInboundRuntimeStores({ namespace: 'held-offer:volatile' }, undefined)
            : undefined,
        outboundStores: createDefaultInMemoryALOutboundRuntimeStores({
            namespace: 'held-offer',
            decodePrepared: decodeALOutboundTransportMessage
        }),
        inboundDiagnostics: (event) => diagnostics.push(event)
    }).enableDefaultCallbacks();
    const connectionService = new WebRtcConnectionService(
        new WsRtcSignalingTransportUsingWsQBox(queueBoxClient, SIGNALING_TYPE),
        {
            sessionId: SELF,
            token: 'test-token',
            dataChannelName: 'room',
            rtcSignalingTopicId: SIGNALING_TYPE,
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 600_000 }
        },
        {
            faultPort: createPassThroughTransportFaultPort(),
            createOfferId: new DeterministicRtcOfferIds().createOfferId,
            nowEpochMs: () => Date.now(),
            writeRetainedSignalsDueNow: async (messages) => {
                await queueBoxClient.writeRetainedInboxMessagesDueNow(messages);
            }
        }
    );
    const group = createActiveGroup();
    const acceptedOverlays = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(connectionService, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        plannedOverlayCache: new LatestRepository<string, OverlayInfo>(),
        acceptedOverlayCache: acceptedOverlays
    }, {
        onOverlayAdopted: () => connectionService.writeHeldInboundSignalsDueNow(BROWSER_RTC_STAGE_LAYOUT_MISMATCH_REASON)
    });
    configureBrowserRtcPeerCreationPolicies(connectionService, manager);
    onTestFinished(async () => {
        connectionService.removePeerIfPresent(SENDER);
        const cleanup = await Promise.allSettled([queueBoxClient.close(), queueEngine.stop()]);
        nativeRuntime.dispose();
        const failure = cleanup.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') {
            throw failure.reason;
        }
    });
    await manager.getOrCreate(group.group).acceptGroupUpdate(group);
    queueEngine.start();
    const connecting = connectionService.connectSignaler();
    await vi.advanceTimersByTimeAsync(0);
    const socket = TestWebSocket.instances.at(-1);
    if (!socket) {
        throw new Error('Expected signaling socket');
    }
    socket.open();
    await connecting;
    return { nativeRuntime, socket, manager, acceptedOverlays, group, diagnostics };
}

/** Steps the engine through the short retries; the row then waits on the policy's 1 s delay. */
async function advanceUntilRetried(runtime: HeldOfferRuntime, msgId: string, retries: number): Promise<void> {
    for (let step = 0; step < 2_000 && readRetriedCount(runtime, msgId) < retries; step += 1) {
        await advanceTime(1);
    }
    expect(readRetriedCount(runtime, msgId)).toBe(retries);
}

/** Fake time moves one millisecond per step; fake-indexeddb settles its requests on real immediates between. */
async function advanceTime(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += 1) {
        await vi.advanceTimersByTimeAsync(1);
        for (let turn = 0; turn < 4; turn += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }
}

function readRetriedCount(runtime: HeldOfferRuntime, msgId: string): number {
    return runtime.diagnostics.filter((event) => event.kind === 'consumer-invocation' && event.msgId === msgId && event.outcome === 'retry').length;
}

function readRemoteOfferTypes(runtime: HeldOfferRuntime): readonly (string | undefined)[] {
    return runtime.nativeRuntime.createdConnections
        .filter((connection) => connection.remoteDescription !== null)
        .map((connection) => connection.remoteDescription?.type);
}

function createActiveGroup(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'room',
        sessionIds: [SELF, SENDER]
    });
    return {
        ...snapshot,
        group: { ...snapshot.group, lifecycleState: 'active' }
    };
}

function acceptedOverlay(group: GroupSnapshot): OverlayInfo {
    return {
        sourceGroupStateCausalRevision: group.causalRevision,
        provenance: 'server',
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: group.group,
        topology: 'tree',
        name: group.group.displayName,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        nextHopSessionIds: [SENDER],
        nextHopsBySessionId: undefined,
        degreeLimit: 2,
        overlayVersion: 1,
        updatedAtEpochMs: 1
    };
}

function toOfferEnvelope(msgId: string): string {
    const message = newALUnicastMessage(SENDER, newALEventRoute(SIGNALING_TYPE, SELF), SELF, SIGNALING_TYPE, {
        channel: 'RtcSignal',
        type: 'Signal',
        fromId: SENDER,
        toId: SELF,
        sessionId: SENDER,
        token: 'test-token',
        signalType: 'Offer',
        offerId: 'offer-1',
        payload: { description: { type: 'offer', sdp: 'held-offer-sdp' }, candidate: null }
    });
    return JSON.stringify({ ...message, id: { ...message.id, msgId } });
}
