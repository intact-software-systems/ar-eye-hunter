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
            { overlayTransitionGraceMs: 0 }
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
            { overlayTransitionGraceMs: 0 }
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
            { overlayTransitionGraceMs: 0 }
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
            { overlayTransitionGraceMs: 0 }
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
            { overlayTransitionGraceMs: 0 }
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
            { overlayTransitionGraceMs: 0 }
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
            { overlayTransitionGraceMs: 0 }
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
    });
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
