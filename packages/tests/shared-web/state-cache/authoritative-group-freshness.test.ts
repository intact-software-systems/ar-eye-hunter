import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import {
    acceptAuthoritativeGroupSessionLeaseAdvance,
    acceptAuthoritativeGroupStateSnapshot
} from '@shared-web/browser/state-cache/state-cache-snapshot-adoption.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import {
    findGroupStateSnapshotByRef,
    onGroupStateSnapshotChange,
    refreshGroupStateSnapshotIfUnchanged,
    replaceGroupStateSnapshotIfUnchanged,
    setGroupStateSnapshot,
    waitForGroupStateSnapshotChangesIdle
} from '@shared/repository/group-state-snapshots-repository.ts';

import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import { createWebRtcGroupManager } from './browser-state-cache-lifecycle-fixtures.ts';

const room = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };

describe('authoritative group observation freshness', () => {
    it('emits only truthful Refreshed and preserves content without downstream topology work', async () => {
        const snapshot = seedObservation();
        const manager = createWebRtcGroupManager();
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager,
            clientData: { clientId: 'sender', sessionId: 'sender', isOnline: true },
            clientSnapshots: [],
            groupSnapshots: [snapshot],
            options: { scope: room }
        });
        const changedGroups: GroupSnapshot[] = [];
        onTestFinished(browserStateCacheLifecycle.onChange((change) => {
            changedGroups.push(...change.groups);
        }));
        const events: ObservableValueEventType[] = [];
        onTestFinished(onGroupStateSnapshotChange((change) => {
            events.push(change.kind);
        }));
        manager.acceptGroupUpdate.mockClear();
        manager.ensureAllGroupsConnected.mockClear();
        vi.setSystemTime(51_000);

        expect(await acceptAuthoritativeGroupStateSnapshot(structuredClone(snapshot), room)).toBe(false);
        await waitForGroupStateSnapshotChangesIdle();

        expect(events).toEqual([ObservableValueEventType.Refreshed]);
        expect(changedGroups).toEqual([]);
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(manager.ensureAllGroupsConnected).not.toHaveBeenCalled();
        vi.setSystemTime(62_000);
        expect(findGroupStateSnapshotByRef(room)).toBe(snapshot);
        expect(snapshot.causalRevision).toEqual({ groupRevision: 2, presenceRevision: 2 });
    });

    it.each(['wrong-scope', 'stale', 'incomparable', 'lease-change', 'liveness-reduction'] as const)(
        'does not renew an observation after %s',
        async (kind) => {
            const snapshot = seedObservation();
            const incoming = changedObservation(snapshot, kind);
            vi.setSystemTime(51_000);
            if (kind === 'incomparable') {
                await expect(acceptAuthoritativeGroupStateSnapshot(incoming, room)).rejects.toThrow('incomparable');
            }
            else {
                expect(await acceptAuthoritativeGroupStateSnapshot(incoming, room)).toBe(false);
            }
            vi.setSystemTime(62_000);
            expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
        }
    );

    it('does not renew after the acquisition owner becomes obsolete during adoption', async () => {
        const snapshot = seedObservation();
        vi.setSystemTime(51_000);
        let current = true;
        const adopting = acceptAuthoritativeGroupStateSnapshot(snapshot, room, {
            assertCanMutate: () => {
                if (!current) {
                    throw new DOMException('obsolete acquisition', 'AbortError');
                }
            }
        });
        current = false;
        await expect(adopting).rejects.toMatchObject({ name: 'AbortError' });
        vi.setSystemTime(62_000);
        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
    });

    it('fences replaced and expired observations without reviving them', () => {
        const snapshot = seedObservation();
        vi.setSystemTime(11_000);
        const replacement = structuredClone(snapshot);
        expect(replaceGroupStateSnapshotIfUnchanged(snapshot, replacement)).toBe(true);
        vi.setSystemTime(51_000);
        expect(refreshGroupStateSnapshotIfUnchanged(snapshot, snapshot)).toBe(false);
        vi.setSystemTime(72_000);
        expect(refreshGroupStateSnapshotIfUnchanged(replacement, replacement)).toBe(false);
        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
    });

    it('does not add a Refreshed event to an actual revision advance', async () => {
        const snapshot = seedObservation();
        await waitForGroupStateSnapshotChangesIdle();
        const events: ObservableValueEventType[] = [];
        onTestFinished(onGroupStateSnapshotChange((change) => {
            events.push(change.kind);
        }));
        const advanced = { ...snapshot, causalRevision: { groupRevision: 3, presenceRevision: 2 }, group: { ...snapshot.group, snapshotVersion: 3 } };
        vi.setSystemTime(51_000);
        expect(await acceptAuthoritativeGroupStateSnapshot(advanced, room)).toBe(true);
        await waitForGroupStateSnapshotChangesIdle();
        expect(events).toEqual([ObservableValueEventType.Updated]);
    });
});

describe('guarded authoritative session lease acquisition', () => {
    it('adopts actual acquired leases with one Updated and an unchanged causal tuple', async () => {
        const expected = seedObservation();
        const manager = createWebRtcGroupManager();
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager,
            clientData: { clientId: 'sender', sessionId: 'sender', isOnline: true },
            clientSnapshots: [],
            groupSnapshots: [expected],
            options: { scope: room }
        });
        const changedGroups: GroupSnapshot[] = [];
        onTestFinished(browserStateCacheLifecycle.onChange((change) => {
            changedGroups.push(...change.groups);
        }));
        await waitForGroupStateSnapshotChangesIdle();
        const acquired = withAdvancedLeases(expected);
        const events: ObservableValueEventType[] = [];
        onTestFinished(onGroupStateSnapshotChange((change) => {
            events.push(change.kind);
        }));
        vi.setSystemTime(51_000);
        expect(acceptAuthoritativeGroupSessionLeaseAdvance({ expected, acquired, scope: room, assertCanMutate: () => {} })).toBe(true);
        await waitForGroupStateSnapshotChangesIdle();
        expect(events).toEqual([ObservableValueEventType.Updated]);
        expect(changedGroups).toEqual([acquired]);
        vi.setSystemTime(62_000);
        expect(findGroupStateSnapshotByRef(room)).toBe(acquired);
        expect(acquired.causalRevision).toEqual({ groupRevision: 2, presenceRevision: 2 });
        expect(acquired.activeSessions.map((session) => [session.lastHeartbeatAtEpochMs, session.expiresAtEpochMs]))
            .toEqual([[50_000, 350_000], [50_000, 350_000]]);
    });

    it.each(
        [
            'unchanged',
            'older',
            'mixed-regression',
            'wrong-scope',
            'member',
            'generation',
            'session',
            'reordered',
            'liveness-reduction',
            'stale-revision'
        ] as const
    )(
        'does not earn freshness from %s acquisition',
        async (kind) => {
            const expected = seedObservation();
            const advanced = withAdvancedLeases(expected);
            const acquired = rejectedLeaseObservation(expected, advanced, kind);
            vi.setSystemTime(51_000);
            expect(acceptAuthoritativeGroupSessionLeaseAdvance({ expected, acquired, scope: room, assertCanMutate: () => {} })).toBe(false);
            expect(findGroupStateSnapshotByRef(room)).toBe(expected);
            vi.setSystemTime(62_000);
            expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
        }
    );

    it.each(['obsolete', 'replaced', 'expired'] as const)('fences an %s acquisition before the synchronous write', (kind) => {
        const expected = seedObservation();
        const acquired = withAdvancedLeases(expected);
        vi.setSystemTime(51_000);
        const controller = new AbortController();
        if (kind === 'obsolete') {
            controller.abort();
        }
        const replacement = structuredClone(expected);
        if (kind === 'replaced') {
            replaceGroupStateSnapshotIfUnchanged(expected, replacement);
        }
        if (kind === 'expired') {
            vi.setSystemTime(62_000);
        }
        const accept = () =>
            acceptAuthoritativeGroupSessionLeaseAdvance({
                expected,
                acquired,
                scope: room,
                assertCanMutate: () => controller.signal.throwIfAborted()
            });
        if (kind === 'obsolete') {
            expect(accept).toThrow();
        }
        else {
            expect(accept()).toBe(false);
        }
        expect(findGroupStateSnapshotByRef(room)).toBe(kind === 'expired' ? undefined : kind === 'replaced' ? replacement : expected);
    });

    it('does not grant lease advancement to the unguarded authoritative delta adoption path', async () => {
        const expected = seedObservation();
        vi.setSystemTime(51_000);
        expect(await acceptAuthoritativeGroupStateSnapshot(withAdvancedLeases(expected), room)).toBe(false);
        expect(findGroupStateSnapshotByRef(room)).toBe(expected);
        vi.setSystemTime(62_000);
        expect(findGroupStateSnapshotByRef(room)).toBeUndefined();
    });
});

function withAdvancedLeases(snapshot: GroupSnapshot): GroupSnapshot {
    return {
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, lastHeartbeatAtEpochMs: 50_000, expiresAtEpochMs: 350_000 }))
    };
}

function rejectedLeaseObservation(expected: GroupSnapshot, advanced: GroupSnapshot, kind: string): GroupSnapshot {
    switch (kind) {
        case 'unchanged':
            return expected;
        case 'older':
            return { ...advanced, activeSessions: advanced.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: 299_000 })) };
        case 'mixed-regression':
            return {
                ...advanced,
                activeSessions: advanced.activeSessions.map((session, index) => index === 1 ? { ...session, expiresAtEpochMs: 299_000 } : session)
            };
        case 'wrong-scope':
            return { ...advanced, group: { ...advanced.group, workspaceId: 'wrong' } };
        case 'member':
            return { ...advanced, members: advanced.members.map((member) => ({ ...member, role: 'owner' })) };
        case 'generation':
            return { ...advanced, activeSessions: advanced.activeSessions.map((session) => ({ ...session, generationVersion: 2 })) };
        case 'session':
            return { ...advanced, activeSessions: advanced.activeSessions.map((session) => ({ ...session, sessionId: 'replacement' })) };
        case 'reordered':
            return { ...advanced, activeSessions: [...advanced.activeSessions].reverse() };
        case 'liveness-reduction':
            return { ...advanced, activeSessions: [], onlineMemberCount: 0 };
        case 'stale-revision':
            return { ...advanced, causalRevision: { groupRevision: 1, presenceRevision: 2 } };
        default:
            throw new Error(`Unsupported lease acquisition ${kind}`);
    }
}

function seedObservation(): GroupSnapshot {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    configureTestCacheRepositories();
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const original = createGroupSnapshotFixture({ ...room, sessionIds: ['sender', 'receiver'] });
    const snapshot = {
        ...original,
        group: { ...original.group, snapshotVersion: 2 },
        causalRevision: { groupRevision: 2, presenceRevision: 2 },
        activeSessions: original.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: 300_000 }))
    };
    setGroupStateSnapshot(snapshot);
    return snapshot;
}

function changedObservation(snapshot: GroupSnapshot, kind: string): GroupSnapshot {
    switch (kind) {
        case 'wrong-scope':
            return { ...snapshot, group: { ...snapshot.group, workspaceId: 'wrong' } };
        case 'stale':
            return { ...snapshot, causalRevision: { groupRevision: 1, presenceRevision: 2 } };
        case 'incomparable':
            return { ...snapshot, causalRevision: { groupRevision: 1, presenceRevision: 3 } };
        case 'lease-change':
            return { ...snapshot, activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: 400_000 })) };
        case 'liveness-reduction':
            return { ...snapshot, activeSessions: [], onlineMemberCount: 0 };
        default:
            throw new Error(`Unsupported observation ${kind}`);
    }
}
