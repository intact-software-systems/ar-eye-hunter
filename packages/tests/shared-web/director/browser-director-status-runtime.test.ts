import { describe, expect, it } from 'vitest';

import { BrowserDirectorStatusRuntime } from '@shared-web/browser/director/browser-director-status-runtime.ts';
import type { RallarDirectorStatus } from '@shared-web/browser/director/rallar-director-facade.ts';
import { RoomStateStore } from '@shared-web/browser/rooms/room-state-store.ts';
import type { RallarStateCacheReadPort } from '@shared-web/browser/state-cache/rallar-state-store.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { RepositoryToken } from '@shared/cache/RepositoryToken.ts';

import { createGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';

const scope = { applicationId: 'arena', workspaceId: 'default' };
const roomRef = { ...scope, groupId: 'room' };
const session: AuthSession = {
    clientId: 'hunter',
    sessionId: 'hunter',
    username: 'hunter',
    accessToken: 'fixture-token',
    expiresAtEpochMs: 60_000
};
const snapshotsToken = new RepositoryToken<readonly GroupSnapshot[]>('director-test-snapshots', () => []);

class DirectorStatusCache implements RallarStateCacheReadPort {
    readonly repositories = new RepositoryManager();
    fault: Error | undefined;

    readGroupSnapshots(): readonly GroupSnapshot[] {
        if (this.fault) {
            throw this.fault;
        }
        return this.repositories.require(snapshotsToken);
    }

    findGroupSnapshotByRef(): GroupSnapshot | undefined {
        return this.readGroupSnapshots()[0];
    }

    findFirstGroupRefForSession() {
        return this.readGroupSnapshots()[0]?.group;
    }

    wasGroupSnapshotObserved(): boolean {
        return this.readGroupSnapshots().length > 0;
    }
    readClientSnapshots() {
        return [];
    }
    findClientSnapshot() {
        return undefined;
    }
    onCacheChange() {
        return () => {};
    }
}

describe('director status observation before connection', () => {
    it.each([undefined, session])('reads absent appointment with an unconfigured cache and session %j', (restoredSession) => {
        const cache = new DirectorStatusCache();
        const status = createStatusRuntime(cache, restoredSession);
        expect(status.read(undefined, { now: 123 })).toEqual({
            roomRef: undefined,
            roomId: undefined,
            appointment: undefined,
            role: 'none',
            state: 'none',
            isDirector: false,
            isFresh: false,
            active: false,
            freshness: 'none',
            lastHeartbeatAtEpochMs: undefined,
            nowEpochMs: 123
        });
        expect(cache.repositories.size()).toBe(0);
        expect(status.read(roomRef, { now: 123 })).toMatchObject({ roomRef, roomId: 'room', state: 'none' });
    });

    it('subscribes before connection and observes a configured appointment until unsubscribe', () => {
        const cache = new DirectorStatusCache();
        const status = createStatusRuntime(cache, session);
        const observations: RallarDirectorStatus[] = [];
        const unsubscribe = status.onStatus((current) => {
            observations.push(current);
        });
        expect(observations.map((current) => current.state)).toEqual(['none']);
        cache.repositories.set(snapshotsToken, [createAppointmentSnapshot()]);
        status.emit();
        expect(observations.at(-1)?.appointment?.sessionId).toBe('hunter');
        unsubscribe();
        cache.repositories.set(snapshotsToken, []);
        status.emit();
        expect(observations.map((current) => current.appointment?.sessionId)).toEqual([undefined, 'hunter']);
    });

    it('does not deliver an obsolete appointment after a listener publishes its removal', () => {
        const cache = new DirectorStatusCache();
        const status = createStatusRuntime(cache, session);
        status.onStatus((current) => {
            if (current.appointment) {
                cache.repositories.set(snapshotsToken, []);
                status.emit();
            }
        });
        const observed: string[] = [];
        status.onStatus((current) => {
            observed.push(current.state);
        });
        cache.repositories.set(snapshotsToken, [createAppointmentSnapshot()]);
        status.emit();
        expect(observed).toEqual(['none', 'none']);
        expect(status.read().state).toBe('none');
    });

    it('keeps a renewed status subscription active after its old handle unsubscribes', () => {
        const cache = new DirectorStatusCache();
        const status = createStatusRuntime(cache, session);
        const observed: string[] = [];
        const listener = (current: RallarDirectorStatus): void => {
            observed.push(current.state);
        };
        const previous = status.onStatus(listener);
        const current = status.onStatus(listener);
        previous();
        cache.repositories.set(snapshotsToken, [createAppointmentSnapshot()]);
        status.emit();
        current();
        cache.repositories.set(snapshotsToken, []);
        status.emit();
        expect(observed).toEqual(['none', 'none', 'fresh']);
    });

    it('propagates unexpected cache faults without retaining a failed subscription', () => {
        const cache = new DirectorStatusCache();
        cache.fault = new Error('cache corrupted');
        const status = createStatusRuntime(cache, session);
        expect(() => status.emit()).not.toThrow();
        const observations: RallarDirectorStatus[] = [];
        expect(() => status.read()).toThrow(cache.fault);
        expect(() =>
            status.onStatus((current) => {
                observations.push(current);
            })
        ).toThrow(cache.fault);
        cache.fault = undefined;
        cache.repositories.set(snapshotsToken, [createAppointmentSnapshot()]);
        status.emit();
        expect(observations).toEqual([]);
    });

    it('uses its injected clock while preserving explicit status and heartbeat times', () => {
        const cache = new DirectorStatusCache();
        cache.repositories.set(snapshotsToken, [createAppointmentSnapshot()]);
        const status = createStatusRuntime(cache, session);
        expect(status.read().nowEpochMs).toBe(1_234);
        expect(status.read(undefined, { now: 2_345 }).nowEpochMs).toBe(2_345);
        const appointment = status.read().appointment;
        if (!appointment) {
            throw new Error('Fixture appointment missing');
        }
        status.recordHeartbeat(roomRef, appointment);
        expect(status.read().lastHeartbeatAtEpochMs).toBe(1_234);
        status.recordHeartbeat(roomRef, appointment, 3_456);
        expect(status.read().lastHeartbeatAtEpochMs).toBe(3_456);
    });

    it('preserves current and explicit room appointment freshness, heartbeat and inactive evidence', () => {
        const cache = new DirectorStatusCache();
        const snapshot = createAppointmentSnapshot();
        cache.repositories.set(snapshotsToken, [snapshot]);
        const status = createStatusRuntime(cache, session);
        expect(status.read(undefined, { now: 1_050 })).toMatchObject({ roomId: 'room', state: 'fresh', active: true, isDirector: true });
        expect(status.read(roomRef, { now: 7_000 })).toMatchObject({ state: 'stale', isFresh: false });
        const appointment = status.read(roomRef).appointment;
        if (!appointment) {
            throw new Error('Fixture appointment missing');
        }
        status.recordHeartbeat(roomRef, appointment, 7_000);
        expect(status.read(roomRef, { now: 7_001 })).toMatchObject({ state: 'fresh', lastHeartbeatAtEpochMs: 7_000 });
        status.removeHeartbeat(roomRef);
        cache.repositories.set(snapshotsToken, [{ ...snapshot, activeSessions: [] }]);
        expect(status.read(roomRef, { now: 1_050 })).toMatchObject({ state: 'inactive', active: false, isFresh: false });
    });
});

function createStatusRuntime(cache: DirectorStatusCache, restoredSession: AuthSession | undefined): BrowserDirectorStatusRuntime {
    const roomStateStore = new RoomStateStore({
        runtime: {
            currentRoomRef: () => undefined,
            setCurrentRoom: () => {},
            clearCurrentRoomIfMatches: () => {},
            readDefaultScope: () => scope,
            resolveOperationScope: () => scope
        },
        readSession: () => restoredSession,
        stateCache: cache
    });
    return new BrowserDirectorStatusRuntime({
        roomStateStore,
        nowMs: () => 1_234,
        readSession: () => restoredSession,
        resolveDefaultRoom: () => undefined
    });
}

function createAppointmentSnapshot(): GroupSnapshot {
    const snapshot = createGroupSnapshotFixture({ ...roomRef, sessionIds: ['hunter'] });
    return {
        ...snapshot,
        group: {
            ...snapshot.group,
            metadata: {
                rallarDirector: {
                    version: 1,
                    mode: 'appointed-spa',
                    sessionId: 'hunter',
                    principalId: 'hunter',
                    epoch: 1,
                    appointedAtEpochMs: 1_000,
                    heartbeatTtlMs: 5_000
                }
            }
        }
    };
}
