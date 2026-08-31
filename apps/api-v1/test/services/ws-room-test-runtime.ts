import assert from 'node:assert/strict';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import {
    createCachedGroupStateService,
    type CachedGroupStateService
} from '@shared-server/rallar-system/group-state/snapshot/cached-group-state-service.ts';
import { GroupStateSnapshotReadThroughCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-snapshot-read-through-cache.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { RepositoryManager } from '@shared/cache/RepositoryManager.ts';
import { configureSharedStateRepositories } from '@shared/repository/configure-shared-state-repositories.ts';

import { FakeRuntimeStateRepository } from '../../../../packages/tests/shared-server/runtime-state/test-support/fake-runtime-state-repository.ts';

interface RoomStateReadCounts {
    snapshots: number;
    revisions: number;
}

export interface RoomStateTestRuntime {
    readonly runtimeRepository: FakeRuntimeStateRepository;
    readonly repository: GroupStateRepository;
    readonly groupStateService: CachedGroupStateService;
    readonly cache: GroupStateSnapshotReadThroughCache;
    readonly manager: RepositoryManager;
    readonly reads: RoomStateReadCounts;
}

export function createRoomStateTestRuntime(
    runtimeRepository = new FakeRuntimeStateRepository()
): RoomStateTestRuntime {
    const repository = new GroupStateRepository(runtimeRepository, runtimeRepository.groupStateEventStore);
    const manager = new RepositoryManager();
    configureSharedStateRepositories({
        clientSnapshots: { ttlMs: 60_000 },
        groupSnapshots: { ttlMs: 60_000 }
    }, manager);
    const durable = createGroupStateService({
        runtimeRepository,
        groupStateEventStore: runtimeRepository.groupStateEventStore,
        authSessionRepository: new AuthSessionRepository(runtimeRepository),
        serviceId: 'ws-room-test',
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    const reads = { snapshots: 0, revisions: 0 };
    const cache = new GroupStateSnapshotReadThroughCache({ groupsRepository: repository, manager });
    const service = createCachedGroupStateService({
        durable: {
            ...durable,
            readSnapshot: (ref) => {
                reads.snapshots += 1;
                return durable.readSnapshot(ref);
            },
            readCausalRevision: (ref) => {
                reads.revisions += 1;
                return durable.readCausalRevision(ref);
            }
        },
        cache
    });
    return { runtimeRepository, repository, groupStateService: service, cache, manager, reads };
}

export async function putRoomSnapshot(
    repository: GroupStateRepository,
    snapshot: GroupSnapshot
): Promise<void> {
    await repository.putGroup(snapshot.group);
    for (const member of snapshot.members) {
        await repository.putMember(member);
    }
    for (const session of snapshot.activeSessions) {
        await repository.putPresenceSession(session);
    }
    const current = await repository.findPresenceSummaryEntry(snapshot.group);
    const summary = {
        applicationId: snapshot.group.applicationId,
        workspaceId: snapshot.group.workspaceId,
        groupId: snapshot.group.groupId,
        causalRevision: snapshot.causalRevision,
        activePrincipalIds: snapshot.activeSessions.map((session) => session.principalId),
        activeSessionIds: snapshot.activeSessions.map((session) => session.sessionId),
        activeSessions: snapshot.activeSessions,
        activePrincipalCount: snapshot.onlineMemberCount,
        activeSessionCount: snapshot.activeSessions.length,
        computedAtEpochMs: snapshot.group.updated.atEpochMs
    };
    const result = current
        ? await repository.updatePresenceSummary(summary, current.entry.revision)
        : await repository.insertPresenceSummary(summary);
    assert.equal(result.status, 'applied');
}
