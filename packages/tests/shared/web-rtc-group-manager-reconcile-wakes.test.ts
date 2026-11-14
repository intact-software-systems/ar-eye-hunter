// dprint-ignore
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { ClientInfo, OverlayInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { LatestRepository } from '@shared/cache/LatestRepository.ts';
import {
    DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS,
    WebRtcGroupManager
} from '@shared/services/web-rtc-group-manager.ts';
import {
    acceptActiveLayoutGroup,
    createClientInfo,
    createGroupSnapshot,
    createOverlayInfo,
    createRtcConnectionHarness,
    type RtcConnectionHarness
} from './web-rtc-group-manager-test-fixture.ts';

describe('WebRtcGroupManager reconcile wakes', () => {
    it('dials paced peers as in-flight setups complete', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        const peerIds = ['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e'];
        for (const peerId of peerIds) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }

        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 1,
                memberSessionIds: ['self', ...peerIds],
                maxConcurrentEdgeSetups: 2
            })
        );

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
        expect(rtcQBox.service.inFlightPeerIds()).toEqual(['peer-a', 'peer-b']);
        expect(manager.readDiagnostics()).toMatchObject({ connectAttemptCount: 2, connectDeferredPacingCount: 3 });

        rtcQBox.nativePeer('peer-a').setConnected();
        await manager.whenReconciled();

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b', 'peer-c']);
        expect(rtcQBox.service.inFlightPeerIds()).toEqual(['peer-b', 'peer-c']);

        rtcQBox.nativePeer('peer-b').setConnected();
        rtcQBox.nativePeer('peer-c').setConnected();
        await manager.whenReconciled();

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b', 'peer-c', 'peer-d', 'peer-e']);
        expect(manager.readDiagnostics()).toMatchObject({ connectAttemptCount: 5 });
    });

    it('redials after removal when another dial is paced', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        for (const peerId of ['peer-a', 'peer-b']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 1,
                memberSessionIds: ['self', 'peer-a', 'peer-b'],
                maxConcurrentEdgeSetups: 1
            })
        );
        expect(manager.readDiagnostics()).toMatchObject({ reconcileRunCount: 1, connectAttemptCount: 1 });
        const lifecycle: string[] = [];
        rtcQBox.service.onRtcPeerLifecycleDo('observer-after-manager', {
            onCreated: (peer) => {
                lifecycle.push(`created:${peer.peerId}`);
            },
            onDeleted: (peer) => {
                lifecycle.push(`deleted:${peer.peerId}`);
            }
        });

        rtcQBox.service.disconnectPeer('peer-a');
        expect(lifecycle).toEqual(['deleted:peer-a']);
        await manager.whenReconciled();

        expect(lifecycle).toEqual(['deleted:peer-a', 'created:peer-a']);
        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);
        expect(manager.readDiagnostics()).toMatchObject({ reconcileRunCount: 2, connectAttemptCount: 2 });
        manager.stopReconcileWakes();
    });

    it('redials a desired peer when its setup closes without paced work', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        clientCache.set('peer-a', createClientInfo('peer-a', true));
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 1,
                memberSessionIds: ['self', 'peer-a']
            })
        );
        expect(manager.readDiagnostics()).toMatchObject({
            reconcileRunCount: 1,
            connectAttemptCount: 1,
            connectDeferredPacingCount: 0
        });

        rtcQBox.nativePeer('peer-a').close();
        await manager.whenReconciled();

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);
        expect(manager.readDiagnostics()).toMatchObject({
            reconcileRunCount: 2,
            connectAttemptCount: 2
        });
        manager.stopReconcileWakes();
    });

    it('stands down a queued setup wake after reconcile wakes stop', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        for (const peerId of ['peer-a', 'peer-b']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 1,
                memberSessionIds: ['self', 'peer-a', 'peer-b'],
                maxConcurrentEdgeSetups: 1
            })
        );
        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a']);

        rtcQBox.service.disconnectPeer('peer-a');
        manager.stopReconcileWakes();
        await manager.whenReconciled();

        expect(rtcQBox.knownPeerIds()).toEqual([]);
        expect(manager.readDiagnostics()).toMatchObject({ reconcileRunCount: 1 });
    });

    it('does not re-run for a peer ending caused by the current reconcile pass', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self', [], (peerId) => {
            if (peerId === 'peer-a') {
                throw new Error('lane refused');
            }
            return true;
        });
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        for (const peerId of ['peer-a', 'peer-b', 'peer-c']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 1,
                memberSessionIds: ['self', 'peer-a', 'peer-b', 'peer-c'],
                maxConcurrentEdgeSetups: 1
            })
        );
        expect(rtcQBox.knownPeerIds()).toEqual(['peer-b']);

        await manager.ensureAllGroupsConnected();
        await manager.whenReconciled();

        expect(manager.readDiagnostics()).toMatchObject({
            reconcileRunCount: 2,
            reconcileCoalescedRerunCount: 0,
            connectDeferredPacingCount: 3
        });
        manager.stopReconcileWakes();
    });

    it('ignores established-peer wakes without paced work and all wakes after stop', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        for (const peerId of ['peer-a', 'peer-b']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        await acceptActiveLayoutGroup(
            manager,
            acceptedOverlayCache,
            createGroupSnapshot({ groupId: 'group-1', membershipVersion: 1, memberSessionIds: ['self', 'peer-a', 'peer-b'] })
        );
        expect(manager.readDiagnostics()).toMatchObject({ reconcileRunCount: 1, connectDeferredPacingCount: 0 });

        rtcQBox.nativePeer('peer-a').setConnected();
        await manager.whenReconciled();
        expect(manager.readDiagnostics().reconcileRunCount).toBe(1);

        await manager.acceptGroupUpdate(
            createGroupSnapshot({
                groupId: 'group-1',
                membershipVersion: 2,
                memberSessionIds: ['self', 'peer-a', 'peer-b'],
                maxConcurrentEdgeSetups: 1
            })
        );
        manager.stopReconcileWakes();
        rtcQBox.nativePeer('peer-b').setConnected();
        await manager.whenReconciled();

        expect(manager.readDiagnostics().reconcileRunCount).toBe(2);
    });

    it('waits while either group owning a peer is at its setup bound', async () => {
        const groupCache = new LatestRepository<string, GroupSnapshot>();
        const clientCache = new LatestRepository<string, ClientInfo>();
        const rtcQBox = createRtcConnectionHarness('self');
        const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
        const manager = new WebRtcGroupManager(
            rtcQBox.service,
            { groupCache, clientCache, acceptedOverlayCache },
            { overlayTransitionGraceMs: 0, onOverlayAdopted: async () => {} }
        );
        manager.startReconcileWakes();
        for (const peerId of ['peer-a', 'peer-shared', 'peer-b']) {
            clientCache.set(peerId, createClientInfo(peerId, true));
        }
        const saturated = createGroupSnapshot({
            groupId: 'group-saturated',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-a', 'peer-shared'],
            maxConcurrentEdgeSetups: 1
        });
        const idle = createGroupSnapshot({
            groupId: 'group-idle',
            membershipVersion: 1,
            memberSessionIds: ['self', 'peer-shared', 'peer-b'],
            maxConcurrentEdgeSetups: 5
        });

        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, saturated);
        await acceptActiveLayoutGroup(manager, acceptedOverlayCache, idle);

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);

        rtcQBox.nativePeer('peer-a').setConnected();
        await manager.whenReconciled();

        expect(rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b', 'peer-shared']);
    });

    describe('retained peer expiry', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('disconnects retained peers when their grace expires without another event', async () => {
            const retirement = await retireLayoutOverPeers();

            expect(retirement.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
            expect(retirement.manager.readDiagnostics()).toMatchObject({
                retainedCreatedCount: 2,
                retainedExpiredCount: 0
            });

            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS + 1);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual([]);
            expect(retirement.manager.readDiagnostics()).toMatchObject({
                retainedExpiredCount: 2,
                disconnectCount: 2
            });
        });

        it('keeps retained peers connected for the complete grace window', async () => {
            const retirement = await retireLayoutOverPeers();

            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS - 1);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
            expect(retirement.manager.readDiagnostics().retainedExpiredCount).toBe(0);
        });

        it('cancels the retained-expiry wake when reconcile wakes stop', async () => {
            const retirement = await retireLayoutOverPeers();
            retirement.manager.stopReconcileWakes();
            const passesBefore = retirement.manager.readDiagnostics().reconcileRunCount;

            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS * 4);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
            expect(retirement.manager.readDiagnostics()).toMatchObject({
                reconcileRunCount: passesBefore,
                retainedExpiredCount: 0
            });
        });

        it('re-arms retained-expiry wake after reconcile wakes restart', async () => {
            const retirement = await retireLayoutOverPeers();
            retirement.manager.stopReconcileWakes();
            retirement.manager.startReconcileWakes();

            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS + 1);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual([]);
            expect(retirement.manager.readDiagnostics().retainedExpiredCount).toBe(2);
        });

        it('does not arm retained-expiry wakes before reconcile wakes start', async () => {
            const retirement = await retireLayoutOverPeers({ startReconcileWakes: false });

            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS * 4);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
            expect(retirement.manager.readDiagnostics().retainedExpiredCount).toBe(0);
        });

        it('disarms retained-expiry wake when the retained peers become desired again', async () => {
            const retirement = await retireLayoutOverPeers();
            await acceptActiveLayoutGroup(
                retirement.manager,
                retirement.acceptedOverlayCache,
                createGroupSnapshot({
                    groupId: 'group-1',
                    membershipVersion: 3,
                    memberSessionIds: ['self', 'peer-a', 'peer-b']
                })
            );

            const passesBefore = retirement.manager.readDiagnostics().reconcileRunCount;
            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS * 4);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
            expect(retirement.manager.readDiagnostics()).toMatchObject({
                reconcileRunCount: passesBefore,
                retainedExpiredCount: 0,
                disconnectCount: 0
            });
        });

        it('re-arms for the next retained peer after collecting the earliest expiry', async () => {
            const retirement = await retireLayoutOverPeers();
            await vi.advanceTimersByTimeAsync(5_000);
            await retireSecondGroupOverPeer(retirement, 'peer-c');

            await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS - 5_000 + 1);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual(['peer-c']);
            expect(retirement.manager.readDiagnostics().retainedExpiredCount).toBe(2);

            await vi.advanceTimersByTimeAsync(5_000 + 1);

            expect(retirement.rtcQBox.knownPeerIds()).toEqual([]);
            expect(retirement.manager.readDiagnostics().retainedExpiredCount).toBe(3);
        });
    });
});

describe('WebRtcGroupManager planned layouts', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('an active room dials its published planned layout\'s peers before the promotion', async () => {
        const fixture = createPlannedLayoutFixture();

        await fixture.manager.acceptGroupUpdate(fixture.group);

        expect(fixture.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b']);
        expect(fixture.manager.state().desiredPeerIds).toEqual(['peer-a', 'peer-b']);
    });

    it('a planned layout replaced before its promotion keeps its dialled peers only for the overlay transition grace', async () => {
        vi.useFakeTimers();
        const fixture = createPlannedLayoutFixture();
        fixture.manager.startReconcileWakes();
        await fixture.manager.acceptGroupUpdate(fixture.group);
        fixture.rtcQBox.nativePeer('peer-b').setConnected();

        fixture.plannedOverlayCache.set(
            toScopedOverlayId(fixture.group.group),
            createOverlayInfo(fixture.group, ['peer-c'], 3)
        );
        await fixture.manager.notifyOverlayTopologyChanged();

        expect(fixture.manager.state().desiredPeerIds).toEqual(['peer-a', 'peer-c']);
        expect(fixture.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-b', 'peer-c']);

        await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS - 1);
        expect(fixture.rtcQBox.knownPeerIds()).toContain('peer-b');

        await vi.advanceTimersByTimeAsync(2);
        expect(fixture.rtcQBox.knownPeerIds()).toEqual(['peer-a', 'peer-c']);
        fixture.manager.stopReconcileWakes();
    });

    it('a reconfiguring room still holds its planned layout without dialling it', async () => {
        const fixture = createPlannedLayoutFixture();

        await fixture.manager.acceptGroupUpdate({
            ...fixture.group,
            group: { ...fixture.group.group, lifecycleState: 'reconfiguring' }
        });

        expect(fixture.rtcQBox.knownPeerIds()).toEqual(['peer-a']);
        expect(fixture.manager.state().desiredPeerIds).toEqual(['peer-a']);
    });
});

describe('WebRtcGroupManager planned layouts under the connection cap', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('a planned layout\'s peers never evict an edge retained for an overlay transition', async () => {
        const fixture = createCapFixture(10);
        await fixture.setLayout('accepted', ['a1', 'a2', 'a3', 'a4', 'a5']);
        await fixture.setLayout('accepted', ['p1', 'p2', 'p3', 'p4', 'p5']);
        expect(fixture.rtcQBox.knownPeerIds().slice().sort()).toEqual(
            ['a1', 'a2', 'a3', 'a4', 'a5', 'p1', 'p2', 'p3', 'p4', 'p5']
        );

        await fixture.setLayout('planned', ['q1', 'q2', 'q3', 'q4', 'q5']);

        expect(fixture.rtcQBox.knownPeerIds().slice().sort()).toEqual(
            ['a1', 'a2', 'a3', 'a4', 'a5', 'p1', 'p2', 'p3', 'p4', 'p5']
        );
        expect(fixture.manager.readDiagnostics().retainedEvictionCount).toBe(0);

        await vi.advanceTimersByTimeAsync(DEFAULT_WEBRTC_OVERLAY_TRANSITION_GRACE_MS + 1);
        await fixture.connectKnownPeers();

        expect(fixture.rtcQBox.knownPeerIds().slice().sort()).toEqual(
            ['p1', 'p2', 'p3', 'p4', 'p5', 'q1', 'q2', 'q3', 'q4', 'q5']
        );
    });

    it('planned peers are dialled up to the budget the accepted and retained peers leave', async () => {
        const fixture = createCapFixture(10);
        await fixture.setLayout('accepted', ['a1', 'a2', 'a3', 'a4', 'a5']);
        await fixture.setLayout('accepted', ['p1', 'p2', 'p3']);

        await fixture.setLayout('planned', ['q1', 'q2', 'q3', 'q4', 'q5']);

        expect(fixture.rtcQBox.knownPeerIds().slice().sort()).toEqual(
            ['a1', 'a2', 'a3', 'a4', 'a5', 'p1', 'p2', 'p3', 'q1', 'q2']
        );
        expect(fixture.manager.readDiagnostics().retainedEvictionCount).toBe(0);
    });
});

function createCapFixture(maxPeerConnections: number) {
    const rtcQBox = createRtcConnectionHarness('self');
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(rtcQBox.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        acceptedOverlayCache,
        plannedOverlayCache
    }, { maxPeerConnections, onOverlayAdopted: async () => {} });
    manager.startReconcileWakes();
    const peerIds = ['a', 'p', 'q'].flatMap((prefix) => [1, 2, 3, 4, 5].map((index) => `${prefix}${index}`));
    const group = createGroupSnapshot({
        groupId: 'group-1',
        membershipVersion: 1,
        memberSessionIds: ['self', ...peerIds],
        maxConcurrentEdgeSetups: 20
    });
    let overlayVersion = 0;

    async function connectKnownPeers(): Promise<void> {
        for (const peerId of rtcQBox.knownPeerIds()) {
            rtcQBox.nativePeer(peerId).setConnected();
        }
        await manager.whenReconciled();
    }

    async function setLayout(role: 'accepted' | 'planned', nextHopSessionIds: readonly string[]): Promise<void> {
        const cache = role === 'accepted' ? acceptedOverlayCache : plannedOverlayCache;
        overlayVersion += 1;
        cache.set(toScopedOverlayId(group.group), createOverlayInfo(group, nextHopSessionIds, overlayVersion));
        await manager.acceptGroupUpdate(group);
        await manager.notifyOverlayTopologyChanged();
        await connectKnownPeers();
    }

    return { manager, rtcQBox, setLayout, connectKnownPeers };
}

function createPlannedLayoutFixture() {
    const rtcQBox = createRtcConnectionHarness('self');
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const plannedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(rtcQBox.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        acceptedOverlayCache,
        plannedOverlayCache
    }, { onOverlayAdopted: async () => {} });
    const group = createGroupSnapshot({
        groupId: 'group-1',
        membershipVersion: 1,
        memberSessionIds: ['self', 'peer-a', 'peer-b', 'peer-c']
    });
    const overlayId = toScopedOverlayId(group.group);
    acceptedOverlayCache.set(overlayId, createOverlayInfo(group, ['peer-a'], 1));
    plannedOverlayCache.set(overlayId, createOverlayInfo(group, ['peer-b'], 2));
    return { manager, rtcQBox, group, plannedOverlayCache };
}

interface RetiredLayoutFixture {
    readonly manager: WebRtcGroupManager;
    readonly rtcQBox: RtcConnectionHarness;
    readonly acceptedOverlayCache: LatestRepository<string, OverlayInfo>;
}

async function retireLayoutOverPeers(
    options: { readonly startReconcileWakes?: boolean; } = {}
): Promise<RetiredLayoutFixture> {
    const rtcQBox = createRtcConnectionHarness('self');
    const acceptedOverlayCache = new LatestRepository<string, OverlayInfo>();
    const manager = new WebRtcGroupManager(rtcQBox.service, {
        groupCache: new LatestRepository<string, GroupSnapshot>(),
        clientCache: new LatestRepository<string, ClientInfo>(),
        acceptedOverlayCache
    }, { onOverlayAdopted: async () => {} });
    if (options.startReconcileWakes !== false) {
        manager.startReconcileWakes();
    }

    const active = createGroupSnapshot({
        groupId: 'group-1',
        membershipVersion: 1,
        memberSessionIds: ['self', 'peer-a', 'peer-b']
    });
    await acceptActiveLayoutGroup(manager, acceptedOverlayCache, active);
    for (const peerId of ['peer-a', 'peer-b']) {
        rtcQBox.nativePeer(peerId).setConnected();
    }

    acceptedOverlayCache.take(toScopedOverlayId(active.group));
    await manager.acceptGroupUpdate({
        ...active,
        causalRevision: { groupRevision: 2, presenceRevision: 2 },
        group: { ...active.group, lifecycleState: 'dormant', snapshotVersion: 2, presenceVersion: 2 }
    });

    return { manager, rtcQBox, acceptedOverlayCache };
}

async function retireSecondGroupOverPeer(
    fixture: RetiredLayoutFixture,
    peerId: string
): Promise<void> {
    const active = createGroupSnapshot({
        groupId: 'group-2',
        membershipVersion: 1,
        memberSessionIds: ['self', peerId]
    });
    await acceptActiveLayoutGroup(fixture.manager, fixture.acceptedOverlayCache, active);
    fixture.rtcQBox.nativePeer(peerId).setConnected();

    fixture.acceptedOverlayCache.take(toScopedOverlayId(active.group));
    await fixture.manager.acceptGroupUpdate({
        ...active,
        causalRevision: { groupRevision: 2, presenceRevision: 2 },
        group: { ...active.group, lifecycleState: 'dormant', snapshotVersion: 2, presenceVersion: 2 }
    });
}
