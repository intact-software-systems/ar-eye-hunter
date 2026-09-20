// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    configureBrowserALRuntimeStores,
    resolveBrowserRtcOverlayALOutboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { newALBroadcastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import '../../setup-browser-indexeddb.ts';
import { captureOutboundWorkRunnable, peekOutboundWorkReadyAt } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import {
    installNativeRtcRuntime,
    type NativeRtcRuntime,
    type SimulatedNativeRtcDataChannel
} from '../../shared/native-rtc-connection-fixture.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

let nativeRuntime: NativeRtcRuntime;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    nativeRuntime = installNativeRtcRuntime();
});

afterEach(() => {
    nativeRuntime.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

it('recovers the same IndexedDB room original when its captured RTC edge becomes authorized after owner recreation', async () => {
    const { oldNative, fresh, original } = await recreateHeldOriginal();
    await drainAndExpectRetainedEdge(fresh, original);

    fresh.observe(['receiver']);
    vi.setSystemTime(1_200);
    await fresh.drain();
    expect(oldNative.sent).toEqual([]);
    expect(fresh.native.sent).toHaveLength(1);
    const wireOriginal = decodePersistedALMessage(JSON.stringify(original));
    expect(decodePersistedALMessage(String(fresh.native.sent[0]))).toMatchObject({
        id: wireOriginal.id,
        targets: wireOriginal.targets,
        payload: wireOriginal.payload,
        delivery: wireOriginal.delivery,
        qos: wireOriginal.qos,
        constraints: wireOriginal.constraints,
        forwarding: { nextHopPeerIds: ['receiver'] }
    });
});

it('never retargets retained work to a different newly authorized peer', async () => {
    const { fresh, original } = await recreateHeldOriginal();
    await drainAndExpectRetainedEdge(fresh, original);
    await fresh.open('other');
    fresh.observe(['other']);
    vi.setSystemTime(1_200);
    await fresh.drain();
    expect(fresh.native.sent).toEqual([]);
    expect(fresh.readNative('other').sent).toEqual([]);
    expect(fresh.settlements.at(-1)).toMatchObject({ outcome: 'not-ready', submissionAttempted: false, willRetry: true });
});

it('does not resurrect the original when its captured edge returns at the original deadline', async () => {
    const { fresh, original } = await recreateHeldOriginal();
    await drainAndExpectRetainedEdge(fresh, original);
    fresh.observe(['receiver']);
    const expiresAtMs = original.constraints?.expiresAtMs;
    if (expiresAtMs === undefined) {
        throw new Error('The original must have its canonical absolute deadline');
    }
    vi.setSystemTime(expiresAtMs);
    await fresh.drain();
    expect(fresh.native.sent).toEqual([]);
    const stores = resolveBrowserRtcOverlayALOutboundRuntimeStores(fresh.sessionId);
    expect(await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace)).toBeUndefined();
});

it.each(['cancel', 'dispose'] as const)('prevents the current owner writing after %s during topology retention', async (operation) => {
    const { fresh, original } = await recreateHeldOriginal();
    await drainAndExpectRetainedEdge(fresh, original);
    const native = fresh.native;
    if (operation === 'cancel') {
        fresh.manager.cancel(original.id.msgId);
    }
    else {
        fresh.close();
    }
    fresh.observe(['receiver']);
    vi.setSystemTime(1_200);
    await fresh.drain();
    expect(native.sent).toEqual([]);
    if (operation === 'dispose') {
        const resumed = new RtcRecoveryOwner(fresh.sessionId);
        await resumed.open();
        await resumed.drain();
        expect(resumed.native.sent.map((frame) => decodePersistedALMessage(String(frame)).id.msgId)).toEqual([original.id.msgId]);
    }
});

it.each(['removed-overlay', 'foreign-overlay', 'expired-session', 'inactive-member'] as const)(
    'keeps %s terminal even when the captured edge is absent',
    async (denial) => {
        const { fresh, original } = await recreateHeldOriginal();
        const key = toScopedOverlayId(fresh.roomRef);
        const snapshot = fresh.groups.read(key);
        const overlay = fresh.overlays.read(key);
        if (!snapshot || !overlay) {
            throw new Error('The recreated owner must have its observed room and empty topology');
        }
        if (denial === 'removed-overlay') {
            fresh.overlays.accept(key, { ...overlay, state: 'removed' });
        }
        else if (denial === 'foreign-overlay') {
            fresh.overlays.accept(key, { ...overlay, groupRef: { ...fresh.roomRef, workspaceId: 'foreign' } });
        }
        else if (denial === 'expired-session') {
            fresh.groups.accept(key, {
                ...snapshot,
                activeSessions: snapshot.activeSessions.map((session) =>
                    session.sessionId === fresh.sessionId ? { ...session, expiresAtEpochMs: Date.now() } : session
                )
            });
        }
        else {
            fresh.groups.accept(key, {
                ...snapshot,
                members: snapshot.members.map((member) =>
                    member.principalId === fresh.sessionId && member.status === 'active' ? { ...member, status: 'banned', banned: member.updated } : member
                )
            });
        }
        await fresh.drain();
        expect(fresh.settlements.at(-1)).toMatchObject({
            kind: 'attempt-settled',
            msgId: original.id.msgId,
            outcome: 'no-targets',
            submissionAttempted: false,
            willRetry: false
        });
        fresh.observe(['receiver']);
        vi.setSystemTime(1_200);
        await fresh.drain();
        expect(fresh.native.sent).toEqual([]);
    }
);

it.each(['different-origin', 'relay'] as const)('does not grant originating retention to a %s attempt', async (mode) => {
    const sessionId = crypto.randomUUID();
    const old = new RtcRecoveryOwner(sessionId);
    await old.open();
    old.hold();
    const original = old.original('origin');
    if (mode === 'relay') {
        old.observe(['origin', 'receiver']);
        expect(await old.manager.forwardIfRequired(original, 'origin')).not.toEqual([]);
    }
    else {
        expect((await old.manager.enqueueIfAbsent(original)).verdict).toMatchObject({ kind: 'admitted', durable: true });
    }
    await old.drain();
    expect(old.native.sent).toEqual([]);
    old.close();
    const fresh = new RtcRecoveryOwner(sessionId);
    await fresh.open();
    fresh.observe(mode === 'relay' ? ['origin'] : []);
    vi.setSystemTime(1_100);
    await fresh.drain();
    expect(fresh.settlements.at(-1)).toMatchObject({ outcome: 'no-targets', submissionAttempted: false, willRetry: false });
    fresh.observe(['origin', 'receiver']);
    vi.setSystemTime(1_200);
    await fresh.drain();
    expect(fresh.native.sent).toEqual([]);
});

interface RetainedRtcOriginal {
    readonly oldNative: SimulatedNativeRtcDataChannel;
    readonly fresh: RtcRecoveryOwner;
    readonly original: ALMessage;
}

async function recreateHeldOriginal(): Promise<RetainedRtcOriginal> {
    const sessionId = crypto.randomUUID();
    const old = new RtcRecoveryOwner(sessionId);
    await old.open();
    const oldNative = old.native;
    old.hold();
    const original = old.original();
    const admission = await old.manager.enqueueIfAbsent(original);
    expect(admission.verdict).toMatchObject({ kind: 'admitted', durable: true });
    await old.drain();
    expect(oldNative.sent).toEqual([]);
    old.close();
    const fresh = new RtcRecoveryOwner(sessionId);
    await fresh.open();
    fresh.observe([]);
    vi.setSystemTime(1_100);
    return { oldNative, fresh, original: admission.message };
}

async function drainAndExpectRetainedEdge(owner: RtcRecoveryOwner, original: ALMessage): Promise<void> {
    await owner.drain();
    expect(owner.native.sent).toEqual([]);
    expect(owner.settlements).toContainEqual(expect.objectContaining({
        kind: 'attempt-settled',
        msgId: original.id.msgId,
        outcome: 'not-ready',
        submissionAttempted: false,
        willRetry: true
    }));
}

class RtcRecoveryOwner {
    readonly sessionId: string;
    readonly roomRef: GroupRef;
    readonly groups = new LatestRepository<string, GroupSnapshot>();
    readonly overlays = new LatestRepository<string, OverlayInfo>();
    readonly settlements: ALDeliverySettlement[] = [];
    readonly faults = createScriptedTransportFaultPort();
    readonly engine = new InboxOutboxEngine();
    readonly drain = captureOutboundWorkRunnable(this.engine);
    readonly connection: WebRtcConnectionService;
    readonly manager: WebRtcOverlayMulticastManager;

    constructor(sessionId: string) {
        this.sessionId = sessionId;
        this.roomRef = { applicationId: 'reload-app', workspaceId: 'workspace', groupId: sessionId };
        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
        this.connection = new WebRtcConnectionService({ connect: async () => {}, send: async () => {} }, {
            sessionId,
            token: 'fixture-token',
            iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
            dataChannelName: 'alm',
            faultPort: this.faults,
            rtcSignalingTopicId: 'rtc'
        });
        this.observe(['receiver']);
        this.manager = new WebRtcOverlayMulticastManager({
            connectionService: this.connection,
            groupCache: this.groups,
            overlayCache: this.overlays,
            multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, this.connection),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundSettlements: (settlement) => this.settlements.push(settlement),
            outboundRuntime: createDefaultALOutboundRuntimeResources({
                decodePrepared: decodeALOutboundTransportMessage,
                stores: resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId),
                queueEngine: this.engine
            }),
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        onTestFinished(() => this.close());
    }

    get native(): SimulatedNativeRtcDataChannel {
        return this.readNative('receiver');
    }

    readNative(peerId: string): SimulatedNativeRtcDataChannel {
        const pc = this.connection.readPeer(peerId)?.connection.status.pc;
        const native = nativeRuntime.createdConnections.find((candidate) => candidate === pc)?.channels[0];
        if (!native) {
            throw new Error('The real RTC owner must create its native receiver channel');
        }
        return native;
    }

    async open(peerId = 'receiver'): Promise<void> {
        const result = this.connection.ensurePeerConnectionStarted(peerId, true);
        if (!result.right) {
            throw new Error('The real RTC service must establish the fixture peer');
        }
        await this.readNative(peerId).open();
    }

    hold(): void {
        this.faults.inject({
            faultId: 'old-document-hold',
            carrier: 'rtc',
            action: 'drop',
            remaining: 'until-cleared',
            match: { typeId: 'reload.original', msgId: undefined, controlType: undefined }
        });
    }

    observe(nextHopSessionIds: readonly string[]): void {
        this.groups.accept(
            toScopedOverlayId(this.roomRef),
            createGroupSnapshotFixture({
                ...this.roomRef,
                sessionIds: [this.sessionId, 'receiver', 'origin', 'other']
            })
        );
        this.overlays.accept(toScopedOverlayId(this.roomRef), {
            overlayId: toScopedOverlayId(this.roomRef),
            groupRef: this.roomRef,
            provenance: 'server',
            state: 'active',
            topology: 'tree',
            name: 'Reload room',
            sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 2 },
            nextHopSessionIds,
            degreeLimit: 2,
            overlayVersion: 1,
            createdByClientId: this.sessionId,
            createdAtEpochMs: 1,
            updatedAtEpochMs: Date.now()
        });
    }

    original(senderId = this.sessionId): ALMessage {
        return {
            ...newALBroadcastMessage(
                senderId,
                {
                    topicId: 'room.reload',
                    contextId: this.roomRef.groupId,
                    resourceId: 'original'
                },
                'room',
                'reload.original',
                { original: true },
                { groupRef: this.roomRef, ttlMs: 30_000 }
            ),
            delivery: { reliability: 'at-least-once', ack: 'none' }
        };
    }

    close(): void {
        this.manager.dispose();
        this.engine.stop();
        for (const peerId of this.connection.knownPeerIds()) {
            this.connection.removePeerIfPresent(peerId);
        }
    }
}
