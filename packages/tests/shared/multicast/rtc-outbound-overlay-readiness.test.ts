import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import {
    newALBroadcastMessage,
    newALMulticastMessage,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALQosEffectivePolicy, ALQosInputProvider } from '@shared/al-contracts/al-policy.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { decodeALOutboundTransportMessage, type ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createDefaultALOutboundDequeueResilience,
    createDefaultALOutboundRuntimeResources
} from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import type { OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import { WebRtcOverlayMulticastManager } from '@shared/multicast/web-rtc-overlay-multicast-manager.ts';
import { WebRtcOverlayMulticastService } from '@shared/multicast/web-rtc-overlay-multicast-service.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toCircuitBreaker } from '@shared/resilience/circuit-breaker.ts';
import { toRateLimiter } from '@shared/resilience/Resilience.ts';
import { WebRtcConnectionService } from '@shared/services/web-rtc-connection-service.ts';
import { createPassThroughTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';

import { createGroupSnapshotFixture } from '../../shared-web/authoritative-group-fixtures.ts';
import { computeOutboundTestAdmission } from '../alm/outbound-runtime-test-fixture.ts';
import { installNativeRtcRuntime, type NativeRtcRuntime } from '../native-rtc-connection-fixture.ts';

const roomRef = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const overlayId = toScopedOverlayId(roomRef);
let native: NativeRtcRuntime;

interface OverlayFixture {
    readonly manager: WebRtcOverlayMulticastManager;
    readonly connection: WebRtcConnectionService;
    readonly groups: LatestRepository<string, GroupSnapshot>;
    readonly overlays: LatestRepository<string, OverlayInfo>;
    readonly resources: ALOutboundMessageRuntime.Resources<ALOutboundTransportMessage>;
    readonly qosProvider: ALQosInputProvider | undefined;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    native = installNativeRtcRuntime();
});

afterEach(() => {
    native.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('RTC durable accepted-overlay readiness', () => {
    it('submits prepared accepted traffic through a surviving edge during flowing reconfiguration', async () => {
        const fixture = await createFixture();
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        const message = createMessage('multicast');
        const reconfiguring = createFlowingReconfiguration();
        validateAuthoritativeGroupSnapshot(reconfiguring, roomRef);
        const commit = fixture.resources.admissionStore.commitBundle.bind(fixture.resources.admissionStore);
        vi.spyOn(fixture.resources.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const committed = await commit(bundle);
            expect(committed).toBe('committed');
            const prepared = await readPreparedEntry(fixture);
            expect(prepared).toMatchObject({ status: EntityStatus.NEW, dequeueAudit: { attempts: 0 } });
            expect(prepared.audit.expiryTs.epochMilliseconds).toBe(6_000);
            expect(JSON.parse(prepared.resource).payload).toMatchObject({
                kind: 'send-prepared',
                message: { msgId: message.id.msgId, senderId: 'self', expiresAtMs: 6_000 },
                prepared: { forwarding: { nextHopPeerIds: ['peer-1'] } }
            });
            expect(native.createdConnections[0].channels[0].sent).toEqual([]);
            vi.setSystemTime(1_050);
            fixture.groups.accept('room', reconfiguring);
            return committed;
        });

        const admitted = await fixture.manager.enqueueIfAbsent(message);
        expect(admitted.status, admitted.reason).toBe('enqueued');
        expect(reconfiguring.causalRevision).toEqual({ groupRevision: 2, presenceRevision: 4 });
        expect(reconfiguring.group.acceptedLayoutIdentity).toEqual({ groupRevision: 1, presenceRevision: 3, version: 7, state: 'active' });
        await vi.advanceTimersByTimeAsync(0);

        const completed = await readPreparedEntry(fixture);
        expect(completed).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 1 } });
        expect(completed.audit.expiryTs.epochMilliseconds).toBe(6_000);
        const sent = native.createdConnections[0].channels[0].sent;
        expect(sent).toHaveLength(1);
        expect(JSON.parse(String(sent[0]))).toMatchObject({
            id: message.id,
            constraints: { expiresAtMs: 6_000 },
            forwarding: { nextHopPeerIds: ['peer-1'] }
        });
        expect(native.createdConnections[1].channels[0].sent).toEqual([]);
    });

    it.each(
        [
            'halted',
            'identity-missing',
            'identity-removed',
            'identity-superseded',
            'room-expired',
            'session-expired',
            'member-removed',
            'overlay-removed',
            'overlay-foreign',
            'overlay-superseded',
            'edge-removed'
        ] as const
    )('never revives prepared traffic revoked by %s during reconfiguration', async (revocation) => {
        const fixture = await createFixture();
        const overlay = createOverlay(['peer-1']);
        fixture.overlays.accept(overlayId, overlay);
        const snapshot = createFlowingReconfiguration();
        const revoked: GroupSnapshot = {
            ...snapshot,
            group: {
                ...snapshot.group,
                transportState: revocation === 'halted' ? 'halted' : 'flowing',
                expiresAtEpochMs: revocation === 'room-expired' ? 1_000 : null,
                acceptedLayoutIdentity: revocation === 'identity-missing'
                    ? null
                    : revocation === 'identity-removed'
                    ? { groupRevision: 2, presenceRevision: 4, version: 8, state: 'removed' }
                    : revocation === 'identity-superseded'
                    ? { groupRevision: 2, presenceRevision: 4, version: 8, state: 'active' }
                    : snapshot.group.acceptedLayoutIdentity
            },
            activeSessions: snapshot.activeSessions.map((session) =>
                revocation === 'session-expired' && session.sessionId === 'peer-1'
                    ? { ...session, expiresAtEpochMs: 1_000 }
                    : session
            ),
            members: snapshot.members.map((member) =>
                revocation === 'member-removed' && member.principalId === 'peer-1'
                    ? { ...member, status: 'removed', removed: member.updated, left: null, banned: null }
                    : member
            )
        };
        const commit = fixture.resources.admissionStore.commitBundle.bind(fixture.resources.admissionStore);
        vi.spyOn(fixture.resources.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            const committed = await commit(bundle);
            expect(committed).toBe('committed');
            expect(await readPreparedEntry(fixture)).toMatchObject({ status: EntityStatus.NEW });
            fixture.groups.accept('room', revoked);
            fixture.overlays.accept(overlayId, {
                ...overlay,
                state: revocation === 'overlay-removed' ? 'removed' : 'active',
                groupRef: revocation === 'overlay-foreign' ? { ...roomRef, workspaceId: 'other' } : roomRef,
                overlayVersion: revocation === 'overlay-superseded' ? 8 : 7,
                nextHopSessionIds: revocation === 'edge-removed' ? [] : ['peer-1']
            });
            return committed;
        });

        expect((await fixture.manager.enqueueIfAbsent(createMessage('multicast'))).status).toBe('enqueued');
        await vi.advanceTimersByTimeAsync(0);
        expect(await readPreparedEntry(fixture)).toMatchObject({ status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 1 } });
        fixture.groups.accept('room', createSnapshot());
        fixture.overlays.accept(overlayId, overlay);
        await vi.advanceTimersByTimeAsync(500);
        expect(native.createdConnections.flatMap((peer) => peer.channels.flatMap((channel) => channel.sent))).toEqual([]);
    });

    it.each([true, false])('retains captured durability and ACK=%s when provider defaults change during the gap', async (acknowledge) => {
        let defaults: Partial<ALQosEffectivePolicy> = {
            delivery: { algo: 'at-least-once', opts: {} },
            durability: { algo: 'local-outbox', opts: {} },
            ack: { algo: acknowledge ? 'hop' : 'none', opts: { timeoutMs: acknowledge ? 200 : 0 } },
            retry: { algo: 'exp-backoff', opts: { maxAttempts: 2 } }
        };
        const fixture = await createFixture({ defaultsForMessage: () => defaults });
        const message = { ...createMessage('multicast'), delivery: undefined, qos: undefined };
        const warnings = vi.spyOn(console, 'warn');
        const admitted = await fixture.manager.enqueueIfAbsent(message);
        expect(admitted.status, admitted.reason).toBe('enqueued');
        expect(admitted.entries).toHaveLength(1);
        expect(admitted.entries[0].status).toBe(EntityStatus.NEW);
        const admittedKeys = await fixture.resources.workQueue.getAllKeys();
        defaults = {
            delivery: { algo: 'best-effort', opts: {} },
            durability: { algo: 'volatile', opts: {} },
            ack: { algo: acknowledge ? 'none' : 'hop', opts: { timeoutMs: acknowledge ? 0 : 300 } },
            retry: { algo: 'none', opts: { maxAttempts: 0 } }
        };
        await vi.advanceTimersByTimeAsync(1_250);
        const pending = await fixture.resources.workQueue.getItem(admitted.entries[0].key);
        expect(pending).toMatchObject({ dequeueAudit: { attempts: 0 } });
        expect(JSON.parse(pending!.resource).constraints.expiresAtMs).toBe(6_000);
        expect(await fixture.resources.workQueue.getAllKeys()).toEqual(admittedKeys);
        expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();
        expect(native.createdConnections.flatMap((peer) => peer.channels.flatMap((channel) => channel.sent))).toEqual([]);
        expect(warnings.mock.calls).toEqual([]);

        fixture.overlays.accept(overlayId, createOverlay(['peer-2']));
        await vi.advanceTimersByTimeAsync(50);
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
        expect(native.createdConnections[1].channels[0].sent).toHaveLength(1);
        if (acknowledge) {
            expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toMatchObject({
                expectedPeerIds: ['peer-2'],
                timeoutMs: 200,
                maxAttempts: 2,
                deadlineAtMs: 2_500
            });
            await fixture.manager.acceptControlMessage(newALAckControlMessage(
                { v: 2, msgId: 'captured-policy-ack', ts: Date.now(), senderId: 'peer-2' },
                { ackedMsgId: message.id.msgId, fromPeerId: 'peer-2', toPeerId: 'self', status: 'accepted', observedAtEpochMs: Date.now() }
            ));
        }
        else {
            expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();
        }
        await vi.advanceTimersByTimeAsync(500);
        expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();
        expect(native.createdConnections[1].channels[0].sent).toHaveLength(1);
    });

    it.each(['volatile', 'best-effort', 'fixed-audience', 'nonlocal', 'excluded', 'visited', 'hinted-away'] as const)(
        'does not acquire durable absent-cache work for %s',
        async (denial) => {
            const fixture = await createFixture();
            const original = createMessage('broadcast');
            const message = toIneligibleMessage(original, denial);
            const result = await fixture.manager.enqueueIfAbsent(message);
            expect(result.status, result.reason).toBe('no-route');
            expect(result.entries).toEqual([]);
            expect(await fixture.resources.workQueue.getAllKeys()).toEqual([]);
        }
    );

    it.each(
        [
            'unknown',
            'pending-session',
            'pending-member',
            'halted',
            'identity-missing',
            'identity-stale',
            'identity-removed',
            'room-inactive',
            'foreign',
            'self-only'
        ] as const
    )(
        'does not admit initial %s authority as a cache wait',
        async (denial) => {
            const fixture = await createFixture();
            fixture.groups.delete('room');
            const snapshot = toAuthoritySnapshot(denial);
            if (snapshot) {
                fixture.groups.accept('room', snapshot);
            }
            const result = await fixture.manager.enqueueIfAbsent(createMessage('broadcast'));
            expect(result.status, result.reason).toBe('no-route');
            expect(result.entries).toEqual([]);
            expect(await fixture.resources.workQueue.getAllKeys()).toEqual([]);
        }
    );

    it.each(['removed', 'foreign', 'planned', 'wrong-version'] as const)(
        'rejects an explicit %s overlay despite an exact scoped alternative',
        async (denial) => {
            const fixture = await createFixture();
            fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
            const overlay = createOverlay(['peer-2']);
            fixture.overlays.accept('explicit', {
                ...overlay,
                overlayId: 'explicit',
                state: denial === 'removed' ? 'removed' : 'active',
                groupRef: denial === 'foreign' ? { ...roomRef, workspaceId: 'other' } : roomRef,
                provenance: denial === 'planned' ? 'bootstrap' : 'server',
                overlayVersion: denial === 'wrong-version' ? 8 : 7
            });
            const original = createMessage('broadcast');
            const result = await fixture.manager.enqueueIfAbsent({ ...original, forwarding: { overlayId: 'explicit' } });
            expect(result.status, result.reason).toBe('no-route');
            expect(result.entries).toEqual([]);
            expect(native.createdConnections.flatMap((peer) => peer.channels.flatMap((channel) => channel.sent))).toEqual([]);
        }
    );

    it('preserves fixed-audience broadcast dispatch on exact active topology', async () => {
        const fixture = await createFixture();
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        const result = await fixture.manager.enqueueIfAbsent(toIneligibleMessage(createMessage('broadcast'), 'fixed-audience'));
        expect(result.status).toBe('enqueued');
        await vi.advanceTimersByTimeAsync(0);
        expect(native.createdConnections[0].channels[0].sent).toHaveLength(1);
    });

    it('does not dispatch an active cached layout after transport authority halts', async () => {
        const fixture = await createFixture();
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        fixture.groups.accept('room', toAuthoritySnapshot('halted')!);
        expect((await fixture.manager.enqueueIfAbsent(createMessage('broadcast'))).status).toBe('skipped');
        await vi.advanceTimersByTimeAsync(100);
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
    });

    it('treats explicit overlay removal as terminal even while the room cache is absent', async () => {
        const fixture = await createFixture();
        const admitted = await fixture.manager.enqueueIfAbsent(createMessage('broadcast'));
        expect(admitted.status).toBe('enqueued');
        fixture.groups.delete('room');
        fixture.overlays.accept(overlayId, { ...createOverlay(['peer-1']), state: 'removed' });
        await vi.advanceTimersByTimeAsync(100);
        expect(await fixture.resources.workQueue.getItem(admitted.entries[0].key)).toMatchObject({ status: EntityStatus.COMPLETED });
        fixture.groups.accept('room', createSnapshot());
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        await vi.advanceTimersByTimeAsync(100);
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
    });

    it.each(['unknown', 'pending-session', 'pending-member'] as const)(
        'keeps owned work ready without spending attempts through temporary %s authority',
        async (pending) => {
            const fixture = await createFixture();
            const result = await fixture.manager.enqueueIfAbsent(createMessage('multicast'));
            expect(result.status).toBe('enqueued');
            fixture.groups.delete('room');
            const snapshot = toAuthoritySnapshot(pending);
            if (snapshot) {
                fixture.groups.accept('room', snapshot);
            }
            await vi.advanceTimersByTimeAsync(1_250);
            expect(await fixture.resources.workQueue.getItem(result.entries[0].key)).toMatchObject({ dequeueAudit: { attempts: 0 } });
            fixture.groups.accept('room', createSnapshot());
            fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
            await vi.advanceTimersByTimeAsync(100);
            expect(native.createdConnections[0].channels[0].sent).toHaveLength(1);
        }
    );

    it('reconstructs the same pending canonical work after manager restart', async () => {
        const fixture = await createFixture();
        const message = createMessage('multicast');
        const admitted = await fixture.manager.enqueueIfAbsent(message);
        expect(admitted.status).toBe('enqueued');
        await vi.advanceTimersByTimeAsync(200);
        fixture.manager.dispose();
        const restarted = createManager({
            ...fixture,
            resources: createDefaultALOutboundRuntimeResources({
                decodePrepared: decodeALOutboundTransportMessage,
                stores: { admissionStore: fixture.resources.admissionStore, workQueue: fixture.resources.workQueue }
            })
        });
        expect((await restarted.enqueueIfAbsent(message)).status).toBe('duplicate');
        fixture.overlays.accept(overlayId, createOverlay(['peer-2']));
        await vi.advanceTimersByTimeAsync(100);
        expect(native.createdConnections[1].channels[0].sent).toHaveLength(1);
        expect(await fixture.resources.workQueue.getItem(admitted.entries[0].key)).toMatchObject({ status: EntityStatus.COMPLETED });
    });

    it('cancels owned work during the cache gap when its manager is disposed', async () => {
        const fixture = await createFixture();
        expect((await fixture.manager.enqueueIfAbsent(createMessage('broadcast'))).status).toBe('enqueued');
        await vi.advanceTimersByTimeAsync(100);
        fixture.manager.dispose();
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        await vi.advanceTimersByTimeAsync(500);
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
    });

    it('leaves no native submission after the exact original expiry boundary', async () => {
        const fixture = await createFixture();
        const result = await fixture.manager.enqueueIfAbsent(createMessage('multicast'));
        expect(result.status).toBe('enqueued');
        await vi.advanceTimersByTimeAsync(4_999);
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        await vi.advanceTimersByTimeAsync(1);
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
        fixture.manager.dispose();
        await vi.advanceTimersByTimeAsync(100);
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
    });

    it('rechecks logical authority after a real zero-copy optimistic admission conflict', async () => {
        const fixture = await createFixture();
        const competitor = await computeOutboundTestAdmission(fixture.resources.admissionStore, {
            ...createMessage('broadcast'),
            route: { topicId: 'chat', resourceId: 'competitor', contextId: 'room' }
        });
        const commit = fixture.resources.admissionStore.commitBundle.bind(fixture.resources.admissionStore);
        vi.spyOn(fixture.resources.admissionStore, 'commitBundle').mockImplementationOnce(async (bundle) => {
            expect(await commit(competitor)).toBe('committed');
            fixture.groups.accept('room', { ...createSnapshot(), group: { ...createSnapshot().group, transportState: 'halted' } });
            return await commit(bundle);
        });
        const message = createMessage('multicast');
        expect((await fixture.manager.enqueueIfAbsent(message)).status).toBe('pending-admission');
        await vi.advanceTimersByTimeAsync(100);
        expect(await fixture.resources.admissionStore.readSentMessage(message.id.msgId)).toBeUndefined();
        fixture.groups.accept('room', createSnapshot());
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        await vi.advanceTimersByTimeAsync(200);
        expect(await fixture.resources.admissionStore.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(native.createdConnections[0].channels[0].sent).toEqual([]);
    });

    it.each(['broadcast', 'multicast'] as const)(
        'retains one %s beyond the retry budget and sends only after exact accepted topology recovers',
        async (mode) => {
            const fixture = await createFixture();
            const message = createMessage(mode);
            const warnings = vi.spyOn(console, 'warn');
            const admitted = await fixture.manager.enqueueIfAbsent(message);
            expect(admitted.status, admitted.reason).toBe('enqueued');
            expect(admitted.entries).toHaveLength(1);
            expect(admitted.entry ?? admitted.entries[0]).toMatchObject({ status: EntityStatus.NEW });
            await vi.advanceTimersByTimeAsync(0);
            const duplicate = await fixture.manager.enqueueIfAbsent(message);
            expect(duplicate.status).toBe('duplicate');
            await vi.advanceTimersByTimeAsync(1_250);
            const canonical = await fixture.resources.workQueue.getItem(admitted.entries[0].key);
            expect(canonical).toMatchObject({ dequeueAudit: { attempts: 0 } });
            expect(JSON.parse(canonical!.resource).constraints.expiresAtMs).toBe(6_000);
            expect(native.createdConnections.flatMap((peer) => peer.channels.flatMap((channel) => channel.sent))).toEqual([]);
            expect(warnings.mock.calls).toEqual([]);
            expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();

            fixture.overlays.accept(overlayId, createOverlay(['peer-2']));
            await vi.advanceTimersByTimeAsync(100);

            expect(native.createdConnections[0].channels[0].sent).toEqual([]);
            expect(native.createdConnections[1].channels[0].sent).toHaveLength(1);
            expect(JSON.parse(String(native.createdConnections[1].channels[0].sent[0]))).toMatchObject({
                id: message.id,
                constraints: { expiresAtMs: 6_000 },
                forwarding: { nextHopPeerIds: ['peer-2'] }
            });
            expect(await fixture.resources.workQueue.getItem(admitted.entries[0].key)).toMatchObject({ status: EntityStatus.COMPLETED });
        }
    );

    it('captures ACK policy without a timeout until the recovered recipient set exists', async () => {
        const fixture = await createFixture();
        const original = createMessage('multicast');
        const message = { ...original, qos: { ...original.qos, ack: { algo: 'hop' as const, opts: { timeoutMs: 200 } } } };
        expect((await fixture.manager.enqueueIfAbsent(message)).status).toBe('enqueued');
        expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(500);
        expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();
        fixture.overlays.accept(overlayId, createOverlay(['peer-2']));
        await vi.advanceTimersByTimeAsync(50);
        expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toMatchObject({ expectedPeerIds: ['peer-2'] });
        await fixture.manager.acceptControlMessage(newALAckControlMessage(
            { v: 2, msgId: 'recovered-ack', ts: Date.now(), senderId: 'peer-2' },
            { ackedMsgId: message.id.msgId, fromPeerId: 'peer-2', toPeerId: 'self', status: 'accepted', observedAtEpochMs: Date.now() }
        ));
        await vi.advanceTimersByTimeAsync(500);
        expect(await fixture.resources.admissionStore.readPendingAck(message.id.msgId)).toBeUndefined();
        expect(native.createdConnections[1].channels[0].sent).toHaveLength(1);
    });

    it('retains ordering identity and supersedes older gap work before native recovery', async () => {
        const fixture = await createFixture();
        const original = createMessage('multicast');
        const first: ALMessage = {
            ...original,
            ordering: { orderingKey: 'presence', epoch: 0, seq: 1 },
            qos: { ...original.qos, supersedence: { algo: 'latest-wins', opts: { supersedenceKey: 'presence' } } }
        };
        const second: ALMessage = { ...first, id: { ...first.id, msgId: 'newer-gap' }, ordering: { orderingKey: 'presence', epoch: 0, seq: 2 } };
        const oldAdmission = await fixture.manager.enqueueIfAbsent(first);
        const newAdmission = await fixture.manager.enqueueIfAbsent(second);
        expect(oldAdmission.status, oldAdmission.reason).toBe('enqueued');
        expect(newAdmission.status, newAdmission.reason).toBe('enqueued');
        expect(JSON.parse(newAdmission.entries[0].resource)).toMatchObject({ ordering: second.ordering, constraints: { expiresAtMs: 6_000 } });
        await vi.advanceTimersByTimeAsync(100);
        fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
        await vi.advanceTimersByTimeAsync(100);
        const sent = native.createdConnections[0].channels[0].sent.map((value) => JSON.parse(String(value)));
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ id: second.id, ordering: second.ordering });
        expect(await fixture.resources.workQueue.getItem(oldAdmission.entries[0].key)).toMatchObject({ status: EntityStatus.COMPLETED });
    });

    it.each(['halted', 'identity-removed', 'room-inactive', 'session-expired', 'member-removed', 'overlay-removed'] as const)(
        'terminates owned work after %s and never sends it after restoration',
        async (revocation) => {
            const fixture = await createFixture();
            const admitted = await fixture.manager.enqueueIfAbsent(createMessage('broadcast'));
            expect(admitted.status).toBe('enqueued');
            await vi.advanceTimersByTimeAsync(50);
            const snapshot = createSnapshot();
            const revoked = {
                ...snapshot,
                group: {
                    ...snapshot.group,
                    transportState: revocation === 'halted' ? 'halted' as const : 'flowing' as const,
                    acceptedLayoutIdentity: revocation === 'identity-removed' ? null : snapshot.group.acceptedLayoutIdentity,
                    expiresAtEpochMs: revocation === 'room-inactive' ? Date.now() : null
                },
                activeSessions: snapshot.activeSessions.map((session) => ({
                    ...session,
                    expiresAtEpochMs: revocation === 'session-expired' ? Date.now() : session.expiresAtEpochMs
                })),
                members: snapshot.members.map((member) =>
                    revocation === 'member-removed'
                        ? { ...member, status: 'removed' as const, removed: member.updated, left: null, banned: null }
                        : member
                )
            };
            if (revocation === 'overlay-removed') {
                fixture.overlays.accept(overlayId, { ...createOverlay(['peer-1']), state: 'removed' });
            }
            fixture.groups.accept('room', revoked);
            await vi.advanceTimersByTimeAsync(100);
            expect(await fixture.resources.workQueue.getItem(admitted.entries[0].key)).toMatchObject({ status: EntityStatus.COMPLETED });
            fixture.groups.accept('room', createSnapshot());
            fixture.overlays.accept(overlayId, createOverlay(['peer-1']));
            await vi.advanceTimersByTimeAsync(200);
            expect(native.createdConnections.flatMap((peer) => peer.channels.flatMap((channel) => channel.sent))).toEqual([]);
        }
    );
});

function toIneligibleMessage(message: ALMessage, denial: string): ALMessage {
    if (message.targets?.mode !== 'broadcast') {
        throw new Error('Expected a broadcast fixture');
    }
    switch (denial) {
        case 'volatile':
            return { ...message, delivery: { reliability: 'best-effort', ack: 'none' }, qos: { durability: { algo: 'volatile' }, retry: { algo: 'none' } } };
        case 'best-effort':
            return {
                ...message,
                qos: { delivery: { algo: 'best-effort' }, durability: { algo: 'volatile' } },
                delivery: { reliability: 'best-effort', ack: 'none' }
            };
        case 'fixed-audience':
            return { ...message, targets: { ...message.targets, recipientPeerIds: ['peer-1'] } };
        case 'nonlocal':
            return { ...message, id: { ...message.id, senderId: 'peer-1' } };
        case 'excluded':
            return { ...message, targets: { ...message.targets, exceptPeerIds: ['peer-1', 'peer-2'] } };
        case 'visited':
            return { ...message, diagnostics: { visitedPeerIds: ['peer-1', 'peer-2'] } };
        case 'hinted-away':
            return { ...message, forwarding: { nextHopPeerIds: ['outsider'] } };
        default:
            throw new Error('Unknown message denial fixture');
    }
}

function toAuthoritySnapshot(denial: string): GroupSnapshot | undefined {
    const snapshot = createSnapshot();
    switch (denial) {
        case 'unknown':
            return undefined;
        case 'pending-session':
            return { ...snapshot, activeSessions: snapshot.activeSessions.filter((session) => session.sessionId !== 'self') };
        case 'pending-member':
            return { ...snapshot, members: snapshot.members.filter((member) => member.principalId !== 'self') };
        case 'halted':
            return { ...snapshot, group: { ...snapshot.group, transportState: 'halted' } };
        case 'identity-missing':
            return { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: null } };
        case 'identity-stale':
            return { ...snapshot, causalRevision: { groupRevision: 1, presenceRevision: 4 } };
        case 'identity-removed':
            return {
                ...snapshot,
                group: { ...snapshot.group, acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 3, version: 7, state: 'removed' } }
            };
        case 'room-inactive':
            return { ...snapshot, group: { ...snapshot.group, expiresAtEpochMs: Date.now() } };
        case 'foreign':
            return { ...snapshot, group: { ...snapshot.group, workspaceId: 'other' } };
        case 'self-only':
            return { ...snapshot, activeSessions: snapshot.activeSessions.filter((session) => session.sessionId === 'self') };
        default:
            throw new Error('Unknown authority denial fixture');
    }
}

async function createFixture(qosProvider?: ALQosInputProvider): Promise<OverlayFixture> {
    const connection = new WebRtcConnectionService({ send: async () => {}, connect: async () => {} }, {
        sessionId: 'self',
        token: 'test-token',
        iceCandidates: { iceServers: [], expiresAtEpochMs: 60_000 },
        dataChannelName: 'alm',
        rtcSignalingTopicId: 'rtc',
        faultPort: createPassThroughTransportFaultPort()
    });
    for (const peerId of ['peer-1', 'peer-2']) {
        connection.ensurePeerConnectionStarted(peerId, true);
    }
    for (const peer of native.createdConnections) {
        peer.setConnected();
        await peer.channels[0].open();
    }
    onTestFinished(() => {
        for (const peerId of connection.knownPeerIds()) {
            connection.removePeerIfPresent(peerId);
        }
    });
    const groups = new LatestRepository<string, GroupSnapshot>();
    const overlays = new LatestRepository<string, OverlayInfo>();
    groups.accept('room', createSnapshot());
    const resources = createDefaultALOutboundRuntimeResources({ decodePrepared: decodeALOutboundTransportMessage, random: () => 0.5 });
    const manager = createManager({ connection, groups, overlays, resources, qosProvider });
    return { manager, connection, groups, overlays, resources, qosProvider };
}

function createManager(fixture: Omit<OverlayFixture, 'manager'>): WebRtcOverlayMulticastManager {
    const manager = new WebRtcOverlayMulticastManager({
        connectionService: fixture.connection,
        groupCache: fixture.groups,
        overlayCache: fixture.overlays,
        multicasterFactory: (id) => new WebRtcOverlayMulticastService(id, fixture.connection),
        qosProvider: fixture.qosProvider,
        outboundDiagnostics: undefined,
        outboundRuntime: fixture.resources,
        circuitBreaker: toCircuitBreaker(),
        rateLimiter: toRateLimiter(),
        dequeueResilience: createDefaultALOutboundDequeueResilience()
    });
    onTestFinished(() => manager.dispose());
    return manager;
}

function createSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['self', 'peer-1', 'peer-2'] });
    return { ...snapshot, group: { ...snapshot.group, acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 3, version: 7, state: 'active' } } };
}

function createFlowingReconfiguration(): GroupSnapshot {
    const snapshot = createSnapshot();
    return {
        ...snapshot,
        causalRevision: { groupRevision: 2, presenceRevision: 4 },
        group: {
            ...snapshot.group,
            snapshotVersion: 2,
            presenceVersion: 4,
            lifecycleState: 'reconfiguring',
            formationEpoch: 1,
            formationElectorate: ['self', 'peer-1', 'peer-2']
        },
        activeSessions: snapshot.activeSessions.filter((session) => session.sessionId !== 'peer-2'),
        onlineMemberCount: 2
    };
}

async function readPreparedEntry(fixture: OverlayFixture): Promise<ResourceEntry> {
    const rows = await Promise.all((await fixture.resources.workQueue.getAllKeys()).map((key) => fixture.resources.workQueue.getItem(key)));
    const prepared = rows.filter((row) => row && JSON.parse(row.resource).payload?.kind === 'send-prepared');
    expect(prepared).toHaveLength(1);
    return prepared[0]!;
}

function createOverlay(nextHopSessionIds: readonly string[]): OverlayInfo {
    return {
        overlayId,
        groupRef: roomRef,
        provenance: 'server',
        state: 'active',
        topology: 'tree',
        name: 'room',
        sourceGroupStateCausalRevision: { groupRevision: 1, presenceRevision: 3 },
        nextHopSessionIds,
        degreeLimit: 3,
        overlayVersion: 7,
        createdByClientId: 'self',
        createdAtEpochMs: 1,
        updatedAtEpochMs: 1
    };
}

function createMessage(mode: 'broadcast' | 'multicast'): ALMessage {
    const route = { topicId: 'chat', resourceId: 'gap', contextId: 'room' };
    const options = {
        ttlMs: 5_000,
        reliability: 'at-least-once' as const,
        qos: { durability: { algo: 'local-outbox' as const }, retry: { algo: 'exp-backoff' as const, opts: { maxAttempts: 2 } } }
    };
    return mode === 'broadcast'
        ? newALBroadcastMessage('self', route, 'room', 'chat.message', { text: 'gap' }, { ...options, groupRef: roomRef })
        : newALMulticastMessage('self', route, roomRef, 'chat.message', { text: 'gap' }, options);
}
