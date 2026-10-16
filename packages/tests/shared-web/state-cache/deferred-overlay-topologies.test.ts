import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { DeferredOverlayTopologies } from '@shared-web/browser/state-cache/deferred-overlay-topologies.ts';
import { adoptOverlayTopology } from '@shared-web/browser/state-cache/overlay-topology-message-dispatch.ts';
// dprint-ignore
import {
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import {
    findAcceptedOverlayById,
    findPlannedOverlayById,
    readOverlayAdoptionDiagnostics,
    resetOverlayAdoptionDiagnostics
} from '@shared/repository/overlays-repository.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createGroupSnapshot,
    createGroupStateDeltaEnvelope,
    createPagedSnapshotReceiver,
    createTopologySnapshot,
    createWebRtcGroupManager,
    toSnapshotPageMessages,
    withGroupCausalRevision
} from './browser-state-cache-lifecycle-fixtures.ts';

const CLIENT: ClientInfo = { clientId: 'alice', sessionId: 'session-a', isOnline: true };
const OTHERS = ['session-b', 'session-c'] as const;

describe('browser overlay adoption deferred until the own session is in the cached group', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
        resetOverlayAdoptionDiagnostics();
    });

    it('adopts a layout that arrived before the delta adding the own session, and covers its duplicate pages', async () => {
        const browser = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await browser.receive(groupSnapshotMessage(before));
        const layout = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);

        const publication = topologyMessage(layout, 'topology-v2');
        await browser.receive(publication);
        // The same pages again: duplicates of a completed transfer, discarded by snapshot assembly.
        await browser.receive(publication);

        expect(findPlannedOverlayById(layout.overlayId)).toBeUndefined();
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDeferredCount: 1,
            membershipDeferredAdoptedCount: 0
        });

        await browser.receive(deltaMessage(before, groupAt({ groupRevision: 2, presenceRevision: 2 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(layout.overlayId)).toMatchObject({
            provenance: 'server',
            overlayVersion: 2,
            nextHopSessionIds: ['session-b']
        });
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDeferredCount: 1,
            membershipDeferredAdoptedCount: 1,
            membershipIneligibleDroppedCount: 0
        });
    });

    it('adopts a layout that arrived before the own join response for a group never cached', async () => {
        const browser = installBrowser();
        const join = groupAt({ groupRevision: 33, presenceRevision: 16 }, OTHERS);
        const layout = createTopologySnapshot(join, { groupRevision: 33, presenceRevision: 17 }, 2);

        await browser.receive(topologyMessage(layout, 'topology-v2'));
        await browser.hydrate([join]);
        await browser.receive(deltaMessage(join, groupAt({ groupRevision: 33, presenceRevision: 17 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(layout.overlayId)).toMatchObject({ provenance: 'server', overlayVersion: 2 });
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDeferredCount: 1,
            membershipDeferredAdoptedCount: 1
        });
    });

    it('keeps a held layout across a room refresh that reinstalls the observers for the same session', async () => {
        const browser = installBrowser();
        const join = groupAt({ groupRevision: 33, presenceRevision: 16 }, OTHERS);
        const layout = createTopologySnapshot(join, { groupRevision: 33, presenceRevision: 17 }, 2);
        await browser.receive(topologyMessage(layout, 'topology-v2'));

        // A room refresh hydrates with its own options, which replaces the observer context.
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: browser.manager,
            clientData: CLIENT,
            clientSnapshots: [],
            groupSnapshots: [groupAt({ groupRevision: 33, presenceRevision: 17 }, [...OTHERS, 'session-a'])],
            options: { groupFormation: { bootstrapDegree: 3 } }
        });

        expect(findPlannedOverlayById(layout.overlayId)).toMatchObject({ provenance: 'server', overlayVersion: 2 });
        expect(readOverlayAdoptionDiagnostics().membershipDeferredAdoptedCount).toBe(1);
    });

    it('assembles a layout transfer that a same-session room refresh interrupts', async () => {
        const browser = installBrowser();
        const layout = largeTopology(groupAt({ groupRevision: 33, presenceRevision: 17 }, OTHERS));
        const [first, ...rest] = toSnapshotPageMessages(topologyMessage(layout, 'topology-v2'));
        expect(rest.length).toBeGreaterThan(0);

        await browser.receivePage(first);
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: browser.manager,
            clientData: CLIENT,
            clientSnapshots: [],
            groupSnapshots: [groupAt({ groupRevision: 33, presenceRevision: 17 }, [...OTHERS, 'session-a'])],
            options: { groupFormation: { bootstrapDegree: 3 } }
        });
        for (const page of rest) {
            await browser.receivePage(page);
        }

        expect(findPlannedOverlayById(layout.overlayId)).toMatchObject({ provenance: 'server', overlayVersion: 2 });
    });

    it('cancels a layout transfer when the lifecycle is installed for a new connection', async () => {
        const first = installBrowser();
        const layout = largeTopology(groupAt({ groupRevision: 33, presenceRevision: 17 }, OTHERS));
        const [opening, ...rest] = toSnapshotPageMessages(topologyMessage(layout, 'topology-v2'));
        await first.receivePage(opening);

        const second = installBrowser();
        for (const page of rest) {
            await second.receivePage(page);
        }
        await second.hydrate([groupAt({ groupRevision: 33, presenceRevision: 17 }, [...OTHERS, 'session-a'])]);

        expect(findPlannedOverlayById(layout.overlayId)?.provenance).toBe('bootstrap');
        expect(readOverlayAdoptionDiagnostics().membershipIneligibleDeferredCount).toBe(0);
    });

    it('adopts the layout for a late joiner whose join snapshot predates its own presence', async () => {
        const browser = installBrowser();
        const join = groupAt({ groupRevision: 58, presenceRevision: 38 }, OTHERS);
        await browser.hydrate([join]);
        const layout = createTopologySnapshot(join, { groupRevision: 58, presenceRevision: 44 }, 8);

        await browser.receive(topologyMessage(layout, 'topology-v8'));
        expect(findPlannedOverlayById(layout.overlayId)?.provenance).not.toBe('server');

        await browser.receive(deltaMessage(join, groupAt({ groupRevision: 59, presenceRevision: 44 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(layout.overlayId)).toMatchObject({ provenance: 'server', overlayVersion: 8 });
        expect(readOverlayAdoptionDiagnostics().membershipDeferredAdoptedCount).toBe(1);
    });

    it('keeps only the newest ineligible layout per group', async () => {
        const browser = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await browser.hydrate([before]);
        const older = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);
        const newer = createTopologySnapshot(before, { groupRevision: 3, presenceRevision: 3 }, 3);

        await browser.receive(topologyMessage(older, 'topology-v2'));
        await browser.receive(topologyMessage(newer, 'topology-v3'));
        await browser.receive(topologyMessage(older, 'topology-v2-late'));
        await browser.receive(deltaMessage(before, groupAt({ groupRevision: 4, presenceRevision: 4 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(newer.overlayId)).toMatchObject({ provenance: 'server', overlayVersion: 3 });
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDeferredCount: 2,
            membershipIneligibleDroppedCount: 1,
            membershipDeferredAdoptedCount: 1
        });
    });

    it('never adopts a kept layout older than the layout the admitting snapshot already accepted', async () => {
        const browser = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await browser.hydrate([before]);
        const kept = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);
        const accepted = createTopologySnapshot(before, { groupRevision: 3, presenceRevision: 3 }, 3);
        await browser.receive(topologyMessage(kept, 'topology-v2'));

        const admitted = groupAt({ groupRevision: 4, presenceRevision: 4 }, [...OTHERS, 'session-a']);
        await browser.receive(deltaMessage(before, {
            ...admitted,
            group: { ...admitted.group, acceptedLayoutIdentity: toGroupLayoutIdentity(accepted) }
        }));

        expect(findPlannedOverlayById(kept.overlayId)?.provenance).toBe('bootstrap');
        expect(findAcceptedOverlayById(kept.overlayId)).toBeUndefined();
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            dominatedDroppedCount: 1,
            membershipDeferredAdoptedCount: 0
        });
    });

    it('drops a kept layout once the cached group passes its revision without the own session', async () => {
        const browser = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await browser.hydrate([before]);
        const kept = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);
        await browser.receive(topologyMessage(kept, 'topology-v2'));

        const passed = groupAt({ groupRevision: 3, presenceRevision: 3 }, OTHERS);
        await browser.receive(deltaMessage(before, passed));
        await browser.receive(deltaMessage(passed, groupAt({ groupRevision: 4, presenceRevision: 4 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(kept.overlayId)?.provenance).toBe('bootstrap');
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDeferredCount: 1,
            membershipIneligibleDroppedCount: 1,
            membershipDeferredAdoptedCount: 0
        });
    });

    it('drops a kept layout when the group leaves the cache and does not adopt it on rejoin', async () => {
        const browser = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await browser.hydrate([before]);
        const kept = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);
        await browser.receive(topologyMessage(kept, 'topology-v2'));

        groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(before.group);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
        await browser.hydrate([groupAt({ groupRevision: 4, presenceRevision: 4 }, [...OTHERS, 'session-a'])]);

        expect(findPlannedOverlayById(kept.overlayId)?.provenance).toBe('bootstrap');
        expect(readOverlayAdoptionDiagnostics().membershipDeferredAdoptedCount).toBe(0);
    });

    it('drops kept layouts when the state-cache lifecycle is installed for a new connection context', async () => {
        const first = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await first.hydrate([before]);
        const kept = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);
        await first.receive(topologyMessage(kept, 'topology-v2'));

        const second = installBrowser();
        await second.receive(deltaMessage(before, groupAt({ groupRevision: 3, presenceRevision: 3 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(kept.overlayId)?.provenance).toBe('bootstrap');
        expect(readOverlayAdoptionDiagnostics().membershipDeferredAdoptedCount).toBe(0);
    });

    it('does not keep a layout that the cached group has already passed without the own session', async () => {
        const browser = installBrowser();
        const current = groupAt({ groupRevision: 3, presenceRevision: 3 }, OTHERS);
        await browser.hydrate([current]);
        const stale = createTopologySnapshot(current, { groupRevision: 2, presenceRevision: 2 }, 2);

        await browser.receive(topologyMessage(stale, 'topology-v2'));
        await browser.receive(deltaMessage(current, groupAt({ groupRevision: 4, presenceRevision: 4 }, [...OTHERS, 'session-a'])));

        expect(findPlannedOverlayById(stale.overlayId)?.provenance).toBe('bootstrap');
        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDroppedCount: 1,
            membershipIneligibleDeferredCount: 0,
            membershipDeferredAdoptedCount: 0
        });
    });

    it('counts a republished copy of the kept layout as deferred, not dropped', async () => {
        const browser = installBrowser();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        await browser.hydrate([before]);
        const layout = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);

        await browser.receive(topologyMessage(layout, 'topology-v2'));
        await browser.receive(topologyMessage(layout, 'topology-v2-replay'));

        expect(readOverlayAdoptionDiagnostics()).toMatchObject({
            membershipIneligibleDeferredCount: 2,
            membershipIneligibleDroppedCount: 0
        });
    });

    it('keeps the later-planned version when a new layout is incomparable to the kept one', () => {
        const deferredTopologies = new DeferredOverlayTopologies();
        const group = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        const kept = createTopologySnapshot(group, { groupRevision: 3, presenceRevision: 2 }, 4);
        const laterPlanned = createTopologySnapshot(group, { groupRevision: 2, presenceRevision: 3 }, 5);
        const earlierPlanned = createTopologySnapshot(group, { groupRevision: 4, presenceRevision: 1 }, 3);

        expect(deferredTopologies.keep(kept)).toBe(true);
        expect(deferredTopologies.keep(laterPlanned)).toBe(true);
        expect(deferredTopologies.find(group.group)).toBe(laterPlanned);
        expect(deferredTopologies.keep(earlierPlanned)).toBe(false);
        expect(deferredTopologies.find(group.group)).toBe(laterPlanned);
    });

    it('discards a kept layout once a layout at least as new is adopted directly', async () => {
        const deferredTopologies = new DeferredOverlayTopologies();
        const manager = createWebRtcGroupManager();
        const before = groupAt({ groupRevision: 1, presenceRevision: 1 }, OTHERS);
        groupStateSnapshotsRepository.setGroupStateSnapshot(before);
        const kept = createTopologySnapshot(before, { groupRevision: 2, presenceRevision: 2 }, 2);
        const adopted = createTopologySnapshot(before, { groupRevision: 3, presenceRevision: 3 }, 3);
        const input = { sessionId: 'session-a', webRtcGroupManager: manager, adoption: 'publication', deferredTopologies } as const;

        await expect(adoptOverlayTopology({ ...input, topology: kept })).resolves.toMatchObject({
            outcome: 'membership-ineligible-deferred',
            changed: false
        });
        expect(deferredTopologies.find(before.group)).toBe(kept);

        groupStateSnapshotsRepository.setGroupStateSnapshot(groupAt({ groupRevision: 3, presenceRevision: 3 }, [...OTHERS, 'session-a']));
        await expect(adoptOverlayTopology({ ...input, topology: adopted })).resolves.toMatchObject({ changed: true });

        expect(deferredTopologies.find(before.group)).toBeUndefined();
        expect(findPlannedOverlayById(adopted.overlayId)?.overlayVersion).toBe(3);
    });
});

interface InstalledBrowser {
    readonly manager: ReturnType<typeof createWebRtcGroupManager>;
    receive(message: ALMessage): Promise<void>;
    receivePage(page: ALMessage): Promise<void>;
    hydrate(groupSnapshots: readonly GroupSnapshot[]): Promise<void>;
}

function installBrowser(): InstalledBrowser {
    const manager = createWebRtcGroupManager();
    let receive: ((message: ALMessage) => Promise<void>) | undefined;
    let receivePage: ((page: ALMessage) => Promise<void>) | undefined;
    browserStateCacheLifecycle.initialise({
        inbox: {
            onAllInboxMessagesDo: vi.fn((callback: { onMessage: (message: ALMessage) => Promise<void>; }) => {
                receive = createPagedSnapshotReceiver(callback.onMessage);
                receivePage = callback.onMessage;
            })
        },
        webRtcGroupManager: manager,
        clientData: CLIENT
    });
    return {
        manager,
        receive: async (message) => {
            await receive!(message);
        },
        receivePage: async (page) => {
            await receivePage!(page);
        },
        hydrate: async (groupSnapshots) => {
            await browserStateCacheLifecycle.hydrate({
                webRtcGroupManager: manager,
                clientData: CLIENT,
                clientSnapshots: [],
                groupSnapshots
            });
        }
    };
}

/** A connected path over enough sessions that its transfer spans several pages. */
function largeTopology(group: GroupSnapshot): RallarOverlayTopologySnapshot {
    const layout = createTopologySnapshot(group, { groupRevision: 33, presenceRevision: 17 }, 2);
    const sessionIds = [
        'session-a',
        'session-b',
        ...Array.from({ length: 1_000 }, (_, index) => `session-extra-${String(index).padStart(6, '0')}`)
    ];
    return {
        ...layout,
        activeSessionIds: sessionIds,
        nextHopsBySessionId: Object.fromEntries(
            sessionIds.map((sessionId, index) => [sessionId, [sessionIds[index - 1], sessionIds[index + 1]].filter((peer) => peer !== undefined)])
        )
    };
}

function groupAt(causalRevision: GroupStateCausalRevision, sessionIds: readonly string[]): GroupSnapshot {
    return withGroupCausalRevision(
        createGroupSnapshot({
            groupId: 'room-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds,
            snapshotVersion: causalRevision.groupRevision
        }),
        causalRevision
    );
}

function groupSnapshotMessage(snapshot: GroupSnapshot): ALMessage {
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateSnapshot, snapshot.group.groupId, 'snapshot'),
        'room',
        AppTopics.groupStateSnapshot,
        snapshot,
        { groupRef: snapshot.group }
    );
}

function topologyMessage(topology: RallarOverlayTopologySnapshot, messageId: string): ALMessage {
    const message = newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.overlayTopology, topology.groupRef.groupId, messageId),
        'room',
        AppTopics.overlayTopology,
        topology,
        { groupRef: topology.groupRef }
    );
    return { ...message, id: { ...message.id, msgId: messageId } };
}

function deltaMessage(predecessor: GroupSnapshot, resulting: GroupSnapshot): ALMessage {
    const envelope = {
        ...createGroupStateDeltaEnvelope(resulting, predecessor.causalRevision),
        members: resulting.members,
        sessions: resulting.activeSessions,
        removedSessionIds: predecessor.activeSessions
            .map((session) => session.sessionId)
            .filter((sessionId) => !resulting.activeSessions.some((session) => session.sessionId === sessionId))
    };
    return newALBroadcastMessage(
        'server-1',
        newALEventRoute(AppTopics.groupStateEvent, resulting.group.groupId, envelope.event.eventId),
        'all',
        AppTopics.groupStateEvent,
        envelope
    );
}
