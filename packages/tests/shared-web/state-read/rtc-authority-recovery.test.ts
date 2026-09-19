import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { acceptAuthoritativeGroupStateSnapshot } from '@shared-web/browser/state-cache/state-cache-snapshot-adoption.ts';
import { readStateGroupSnapshot } from '@shared-web/browser/state-read/point-read.ts';
import { RtcGroupSnapshotRefresh } from '@shared-web/browser/state-read/rtc-group-snapshot-refresh.ts';
import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { parseALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { createDefaultInMemoryALInboundRuntimeStores } from '@shared/alm/al-runtime-stores.ts';
import type { ALInboundRuntimeDiagnosticsEvent } from '@shared/alm/inbound/al-inbound-runtime-diagnostics.ts';
import { decodeALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import type { ReadableKeyedValues } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import {
    configureGroupStateSnapshotRepository,
    findGroupStateSnapshotByRef,
    readableGroupStateSnapshotCache,
    setGroupStateSnapshot
} from '@shared/repository/group-state-snapshots-repository.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { createDefaultWebRtcRxStreamerService, WebRtcRxStreamerService } from '@shared/services/web-rtc-rx-streamer-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import {
    createNativeRtcConnectionFixture,
    installNativeRtcRuntime,
    type NativeRtcRuntime,
    type SimulatedNativeRtcDataChannel
} from '../../shared/native-rtc-connection-fixture.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('RTC room authority recovery', () => {
    it.each(
        [
            'acknowledged',
            'no-ack',
            'sender-missing',
            'duplicate',
            'racing-repair',
            'unchanged-authority',
            'newer-authority',
            'coalesced-higher-floor',
            'refresh-failed',
            'disposed',
            'peer-removed',
            'peer-replaced',
            'expired',
            'wrong-scope',
            'insufficient-floor',
            'removed-member'
        ] as const
    )('rechecks the exact original after deferred authority refresh: %s', async (scenario) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const nativeRuntime = installNativeRtcRuntime();
        const receiverRepository = configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
        const senderGroups = new LatestRepository<string, GroupSnapshot>();
        const snapshot = createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] });
        senderGroups.set(toScopedOverlayId(room), snapshot);
        const response = Promise.withResolvers<Response>();
        const reads: string[] = [];
        vi.stubGlobal('fetch', (url: string | URL | Request) => {
            reads.push(String(url));
            return response.promise;
        });
        const refresh = new RtcGroupSnapshotRefresh({
            refreshGroupSnapshot: async (roomRef, minSnapshotVersion, signal) => {
                const read = await readStateGroupSnapshot(roomRef.groupId, roomRef, {
                    authSession: {
                        clientId: 'receiver',
                        username: 'receiver',
                        sessionId: 'receiver',
                        accessToken: 'fixture-token',
                        expiresAtEpochMs: 60_000
                    },
                    signal,
                    minCausalRevision: { groupRevision: minSnapshotVersion, presenceRevision: 0 }
                });
                signal.throwIfAborted();
                await acceptAuthoritativeGroupStateSnapshot(read.snapshot, roomRef);
            }
        });
        const sender = new NativeAuthorityEndpoint({
            sessionId: 'sender',
            peerId: 'receiver',
            nativeRuntime,
            groups: senderGroups,
            refresh: undefined
        });
        const receiver = new NativeAuthorityEndpoint({
            sessionId: 'receiver',
            peerId: 'sender',
            nativeRuntime,
            groups: readableGroupStateSnapshotCache(),
            refresh
        });
        onTestFinished(() => {
            response.resolve(new Response('', { status: 503 }));
            receiver.close();
            sender.close();
            receiverRepository.dispose();
            senderGroups.dispose();
            nativeRuntime.dispose();
            vi.restoreAllMocks();
            vi.useRealTimers();
        });
        await sender.native.open();
        await receiver.native.open();
        const ack = scenario === 'no-ack' ? 'none' : 'hop';
        const message = newALMulticastMessage(
            'sender',
            {
                topicId: 'room.messages',
                contextId: 'room',
                resourceId: 'recovery'
            },
            room,
            'recovery.message',
            { value: 1 },
            {
                ttlMs: 30_000,
                reliability: 'at-least-once',
                minSnapshotVersion: scenario === 'insufficient-floor' ? 2 : undefined,
                ack: ack === 'hop' ? 'all-logical-recipients' : 'none',
                qos: { durability: { algo: 'volatile' }, ack: { algo: ack, opts: { timeoutMs: 5_000 } } }
            }
        );

        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
        expect(await sender.multicast.enqueueIfAbsent(message)).toMatchObject({ verdict: { kind: 'admitted' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(sender.messages().map((entry) => entry.id.msgId)).toEqual([message.id.msgId]);
        const receiving = sender.transferTo(receiver);
        await vi.advanceTimersByTimeAsync(0);
        expect(receiver.delivered).toEqual([]);
        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
        expect(receiver.admissions).toContainEqual(expect.objectContaining({
            kind: 'admission-outcome',
            msgId: message.id.msgId,
            outcome: 'rejected',
            reason: 'not-yet-in-sync: Awaiting a room authority observation'
        }));
        expect(reads).toHaveLength(1);
        expect(reads[0]).toBe(
            '/api/state/apps/app/workspaces/workspace/groups/room?minGroupRevision=' +
                (scenario === 'insufficient-floor' ? '2' : '0') + '&minPresenceRevision=0'
        );
        expect(receiver.messages().map(parseALControlMessage)).toContainEqual({
            type: 'nack',
            payload: expect.objectContaining({ msgId: message.id.msgId, reason: 'not-yet-in-sync' })
        });
        if (scenario === 'sender-missing') {
            senderGroups.clearAll();
        }
        await receiver.transferTo(sender);
        const duplicateAdmissions: Promise<void>[] = [];
        let higherFloorMessage: ALMessage | undefined;
        if (scenario === 'duplicate') {
            duplicateAdmissions.push(receiver.native.receive(sender.native.sent[0]));
        }
        if (scenario === 'racing-repair') {
            await vi.advanceTimersByTimeAsync(100);
            expect(sender.messages().filter((sent) => sent.id.msgId === message.id.msgId)).toHaveLength(2);
            duplicateAdmissions.push(sender.transferTo(receiver));
        }
        if (scenario === 'coalesced-higher-floor') {
            higherFloorMessage = newALMulticastMessage(
                'sender',
                { topicId: 'room.messages', contextId: 'room', resourceId: 'higher-floor' },
                room,
                'recovery.message',
                { value: 2 },
                { ttlMs: 30_000, minSnapshotVersion: 2 }
            );
            expect(await sender.multicast.enqueueIfAbsent(higherFloorMessage)).toMatchObject({ verdict: { kind: 'admitted' } });
            await vi.advanceTimersByTimeAsync(0);
            expect(sender.messages().map((sent) => sent.id.msgId)).toContain(higherFloorMessage.id.msgId);
            duplicateAdmissions.push(sender.transferTo(receiver));
        }
        const currentSnapshot = scenario === 'newer-authority'
            ? {
                ...snapshot,
                group: { ...snapshot.group, snapshotVersion: 2 },
                causalRevision: { ...snapshot.causalRevision, groupRevision: 2 }
            }
            : snapshot;
        if (scenario === 'unchanged-authority' || scenario === 'newer-authority') {
            await acceptAuthoritativeGroupStateSnapshot(currentSnapshot, room);
        }
        if (scenario === 'disposed') {
            receiver.streamer.dispose();
        }
        if (scenario === 'peer-removed' || scenario === 'peer-replaced') {
            await receiver.removePeer(scenario === 'peer-replaced');
        }
        if (scenario === 'expired') {
            vi.setSystemTime(31_000);
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(receiver.delivered).toEqual([]);
        response.resolve(
            scenario === 'refresh-failed'
                ? new Response('', { status: 503 })
                : snapshotResponse(snapshot, scenario)
        );
        await Promise.all([receiving, ...duplicateAdmissions]);
        await vi.advanceTimersByTimeAsync(0);

        const shouldDeliver = [
            'acknowledged',
            'no-ack',
            'sender-missing',
            'duplicate',
            'racing-repair',
            'unchanged-authority',
            'newer-authority',
            'coalesced-higher-floor'
        ].includes(scenario);
        expect(receiver.delivered.map((entry) => entry.id.msgId)).toEqual(shouldDeliver ? [message.id.msgId] : []);
        expect(reads).toHaveLength(1);
        if (higherFloorMessage !== undefined) {
            expect(receiver.admissions).toContainEqual(expect.objectContaining({
                kind: 'admission-outcome',
                msgId: higherFloorMessage.id.msgId,
                outcome: 'rejected',
                reason: 'not-yet-in-sync: Awaiting the required room snapshot version'
            }));
        }
        if (shouldDeliver) {
            expect(receiver.delivered[0]).toMatchObject({
                id: message.id,
                targets: { mode: 'multicast', groupRef: room },
                payload: message.payload,
                constraints: { expiresAtMs: 31_000 }
            });
            expect(findGroupStateSnapshotByRef(room)).toEqual(currentSnapshot);
        }
    });
});

describe('authoritative room observation freshness', () => {
    it.each(['authoritative-refresh', 'first-authoritative-read', 'expired-session', 'expired-original', 'no-refresh', 'untrusted-duplicate'] as const)(
        'preserves the original cache expiry unless a current authoritative read renews it: %s',
        async (scenario) => {
            vi.useFakeTimers();
            vi.setSystemTime(1_000);
            const nativeRuntime = installNativeRtcRuntime();
            const senderRepository = configureGroupStateSnapshotRepository({ ttlMs: 60_000 });
            const receiverGroups = new LatestRepository<string, GroupSnapshot>();
            const initial = createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] });
            const snapshot: GroupSnapshot = {
                ...initial,
                activeSessions: initial.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: scenario === 'expired-session' ? 60_000 : 300_000 }))
            };
            if (scenario !== 'first-authoritative-read') {
                setGroupStateSnapshot(snapshot);
            }
            receiverGroups.set(toScopedOverlayId(room), snapshot);
            const reads: string[] = [];
            vi.stubGlobal('fetch', (url: string | URL | Request) => {
                reads.push(String(url));
                return Promise.resolve(snapshotResponse(snapshot, 'valid'));
            });
            onTestFinished(() => {
                senderRepository.dispose();
                receiverGroups.dispose();
                nativeRuntime.dispose();
                vi.restoreAllMocks();
                vi.useRealTimers();
            });

            vi.setSystemTime(51_000);
            if (scenario !== 'no-refresh' && scenario !== 'untrusted-duplicate') {
                const controller = new AbortController();
                const response = await readStateGroupSnapshot(room.groupId, room, {
                    authSession: {
                        clientId: 'sender',
                        username: 'sender',
                        sessionId: 'sender',
                        accessToken: 'fixture-token',
                        expiresAtEpochMs: 300_000
                    },
                    signal: controller.signal
                });
                controller.signal.throwIfAborted();
                expect(response.snapshot).toEqual(snapshot);
                expect(await acceptAuthoritativeGroupStateSnapshot(response.snapshot, room)).toBe(scenario === 'first-authoritative-read');
            }
            else if (scenario === 'untrusted-duplicate') {
                expect(setGroupStateSnapshot(snapshot)).toBe(false);
            }
            expect(findGroupStateSnapshotByRef(room)).toEqual(snapshot);
            expect(reads).toHaveLength(scenario !== 'no-refresh' && scenario !== 'untrusted-duplicate' ? 1 : 0);

            vi.setSystemTime(62_000);
            const sender = new NativeAuthorityEndpoint({
                sessionId: 'sender',
                peerId: 'receiver',
                nativeRuntime,
                groups: readableGroupStateSnapshotCache(),
                refresh: undefined
            });
            const receiver = new NativeAuthorityEndpoint({
                sessionId: 'receiver',
                peerId: 'sender',
                nativeRuntime,
                groups: receiverGroups,
                refresh: undefined
            });
            onTestFinished(() => {
                receiver.close();
                sender.close();
            });
            await sender.native.open();
            await receiver.native.open();
            const message = newALMulticastMessage(
                'sender',
                { topicId: 'room.messages', contextId: 'room', resourceId: 'freshness' },
                room,
                'freshness.message',
                { value: 1 },
                { ttlMs: 30_000, reliability: 'at-least-once', ack: 'none' }
            );
            if (scenario === 'expired-original') {
                vi.setSystemTime(92_000);
            }
            const admission = await sender.multicast.enqueueIfAbsent(message);
            await vi.advanceTimersByTimeAsync(0);
            await sender.transferTo(receiver);

            if (scenario === 'authoritative-refresh' || scenario === 'first-authoritative-read') {
                expect(admission.verdict).toMatchObject({ kind: 'admitted' });
                expect(sender.messages().map((sent) => sent.id.msgId)).toEqual([message.id.msgId]);
                expect(receiver.delivered.map((received) => received.id.msgId)).toEqual([message.id.msgId]);
                expect(findGroupStateSnapshotByRef(room)).toEqual(snapshot);
                expect(receiver.delivered[0]).toMatchObject({
                    id: message.id,
                    targets: { mode: 'multicast', groupRef: room },
                    payload: message.payload,
                    constraints: { expiresAtMs: 92_000 }
                });
            }
            else {
                if (scenario === 'no-refresh' || scenario === 'untrusted-duplicate') {
                    expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
                }
                else {
                    expect(findGroupStateSnapshotByRef(room)).toEqual(snapshot);
                }
                expect(sender.messages()).toEqual([]);
                expect(receiver.delivered).toEqual([]);
            }
        }
    );
});

function snapshotResponse(snapshot: GroupSnapshot, scenario: string): Response {
    const authority = scenario === 'wrong-scope'
        ? createGroupSnapshotFixture({ ...room, workspaceId: 'wrong', sessionIds: ['sender', 'receiver'] })
        : scenario === 'removed-member'
        ? {
            ...snapshot,
            members: snapshot.members.map((member) =>
                member.principalId === 'sender'
                    ? { ...member, status: 'removed' as const, removed: member.updated }
                    : member
            )
        }
        : snapshot;
    return new Response(JSON.stringify(authority), {
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': '1',
            'rallar-presence-revision': '2'
        }
    });
}

namespace NativeAuthorityEndpoint {
    export interface Input {
        readonly sessionId: string;
        readonly peerId: string;
        readonly nativeRuntime: NativeRtcRuntime;
        readonly groups: ReadableKeyedValues<string, GroupSnapshot>;
        readonly refresh: RtcGroupSnapshotRefresh | undefined;
    }
}

class NativeAuthorityEndpoint {
    readonly resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage });
    readonly multicast: WebRtcOverlayMulticastManager;
    readonly streamer: WebRtcRxStreamerService;
    readonly native: SimulatedNativeRtcDataChannel;
    readonly delivered: ALMessage[] = [];
    readonly admissions: ALInboundRuntimeDiagnosticsEvent[] = [];
    private readonly connection;
    private readonly overlays = new LatestRepository<string, OverlayInfo>();
    private transferredCount = 0;
    private readonly peerId: string;

    constructor(input: NativeAuthorityEndpoint.Input) {
        this.peerId = input.peerId;
        this.connection = createNativeRtcConnectionFixture({
            sessionId: input.sessionId,
            token: 'fixture-token',
            faultPort: createPassThroughTransportFaultPort(),
            rtcSignalingTopicId: 'rtc',
            dataChannelName: 'reliable',
            iceCandidates: { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 }
        }, input.nativeRuntime);
        this.connection.service.ensurePeerConnectionStarted(input.peerId, true);
        this.native = this.connection.nativePeer(input.peerId).channels[0];
        this.overlays.set(toScopedOverlayId(room), createOverlay(input.peerId));
        this.multicast = new WebRtcOverlayMulticastManager({
            connectionService: this.connection.service,
            groupCache: input.groups,
            overlayCache: this.overlays,
            multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, this.connection.service),
            qosProvider: undefined,
            outboundDiagnostics: undefined,
            outboundSettlements: undefined,
            outboundRuntime: this.resources,
            circuitBreaker: toCircuitBreaker(),
            rateLimiter: toRateLimiter(),
            dequeueResilience: createDefaultALOutboundDequeueResilience()
        });
        this.streamer = createDefaultWebRtcRxStreamerService({
            multicast: this.multicast,
            sessionId: input.sessionId,
            inboundStores: createDefaultInMemoryALInboundRuntimeStores(),
            roomAuthorityRefresh: input.refresh,
            inboundDiagnostics: (event) => this.admissions.push(event)
        });
        this.streamer.setRttReportingPeerIds([]);
        this.streamer.onAllInboxMessagesDo({
            onMessage: async (message) => {
                this.delivered.push(message);
            }
        });
        this.streamer.addPeer(this.connection.service.readPeer(input.peerId)!);
    }

    messages(): readonly ALMessage[] {
        return this.native.sent.map((frame) => decodePersistedALMessage(String(frame)));
    }

    async transferTo(receiver: NativeAuthorityEndpoint): Promise<void> {
        for (const frame of this.native.sent.slice(this.transferredCount)) {
            this.transferredCount += 1;
            await receiver.native.receive(frame);
            await vi.advanceTimersByTimeAsync(0);
        }
    }

    async removePeer(replace: boolean): Promise<void> {
        const peer = this.connection.service.readPeer(this.peerId)!;
        this.streamer.removePeer(peer);
        this.connection.service.removePeerIfPresent(this.peerId);
        if (replace) {
            this.connection.service.ensurePeerConnectionStarted(this.peerId, true);
            this.streamer.addPeer(this.connection.service.readPeer(this.peerId)!);
            await this.connection.nativePeer(this.peerId).channels[0].open();
        }
    }

    close(): void {
        this.streamer.dispose();
        this.multicast.dispose();
        this.connection.dispose();
        this.overlays.dispose();
    }
}

function createOverlay(peerId: string): OverlayInfo {
    return {
        overlayId: toScopedOverlayId(room),
        groupRef: room,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'Room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 2 },
        nextHopSessionIds: [peerId],
        degreeLimit: 2,
        overlayVersion: 1,
        createdByClientId: 'sender',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}
