import { describe, expect, it } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor, GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { GroupStateRepositoryInvariantCorruptionError } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PUBLICATION_GRANTS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStatePublicationGrantStorageKey } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-storage-key.ts';
import {
    readGroupStateAuthorityBatch,
    readGroupStateSnapshotVersions
} from '@shared-server/rallar-system/group-state/persistence/read-group-state-authority.ts';
import { GroupStateCurrentSnapshotCache } from '@shared-server/rallar-system/group-state/snapshot/group-state-current-snapshot-cache.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { GroupPublicationGrant } from '@shared/api/group-publication/group-publication-grants.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import {
    recordPostgresStatements,
    type PostgresStatementLog
} from '../../../integration/postgres/test-support/record-postgres-statements.ts';
import { createResourceInboxTestStorage, type ResourceInboxTestBackend } from '../../../queuebox/resource-inbox-test-storage.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';

const REF: GroupRef = { applicationId: 'grant-app', workspaceId: 'grant-workspace', groupId: 'grant-room' };

interface GrantSqlFixture {
    readonly sql: PSqlSql;
    readonly runtime: PSqlRuntimeStateRepository;
    readonly repository: GroupStateRepository;
    readonly mutations: GroupStateService;
    readonly nowEpochMs: number;
}

describe.each(['memory', 'postgres'] as const)('group publication grant rows (%s)', (backend) => {
    const sqlIt = backend === 'postgres' && process.env.RALLAR_POSTGRES_INTEGRATION !== '1' ? it.skip : it;

    sqlIt('the snapshot version probe changes when a grant row is written', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            const [before] = await readGroupStateSnapshotVersions(fixture.runtime, [REF], fixture.nowEpochMs);
            await writeGrantRow(fixture, grantFor('bob'));
            const [after] = await readGroupStateSnapshotVersions(fixture.runtime, [REF], fixture.nowEpochMs);

            expect(before).toBeDefined();
            expect(after).not.toEqual(before);
        });
    }, 30_000);

    sqlIt('the authority batch returns the grant rows in the same statement', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await writeGrantRow(fixture, grantFor('bob'));
            const log: PostgresStatementLog = { statements: [], transactions: 0 };
            const observed = new PSqlRuntimeStateRepository(recordPostgresStatements(fixture.sql, log, null));

            const batch = await readGroupStateAuthorityBatch(observed, REF, fixture.nowEpochMs);

            expect(log.statements).toHaveLength(1);
            expect(batch.publicationGrants.map((entry) => entry.value)).toEqual([grantFor('bob')]);
            expect(batch.publicationGrants[0]?.value.principalId).toBe('bob');
        });
    }, 30_000);

    sqlIt('a corrupt grant row fails the current snapshot read closed', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await writeGrantRow(fixture, { ...grantFor('bob'), topics: {} });
            const current = new GroupStateCurrentSnapshotCache({
                repository: fixture.repository,
                versionReader: fixture.runtime,
                nowEpochMs: () => fixture.nowEpochMs,
                maxEntries: 4
            });

            await expect(current.readSnapshot(REF)).rejects.toBeInstanceOf(GroupStateRepositoryInvariantCorruptionError);
        });
    }, 30_000);

    sqlIt('leave deletes the grant row in the membership batch', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await writeGrantRow(fixture, grantFor('bob'));
            const before = await requireSnapshot(fixture);

            await runMutation(fixture, 'bob', upsertDescriptor('bob', 'bob', 'left'));

            const after = await requireSnapshot(fixture);
            expect(after.members.find((member) => member.principalId === 'bob')?.status).toBe('left');
            expect(after.group.rosterVersion).toBe(before.group.rosterVersion + 1);
            expect(await findGrantRow(fixture, 'bob')).toBeUndefined();
        });
    }, 30_000);

    sqlIt('remove and ban delete the row', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await runMutation(fixture, 'carol', joinDescriptor('carol'));
            await writeGrantRow(fixture, grantFor('bob'));
            await writeGrantRow(fixture, grantFor('carol'));

            await runMutation(fixture, 'alice', governDescriptor('removeGroupMember', 'bob'));
            await runMutation(fixture, 'alice', governDescriptor('banGroupMember', 'carol'));

            expect(await findGrantRow(fixture, 'bob')).toBeUndefined();
            expect(await findGrantRow(fixture, 'carol')).toBeUndefined();
        });
    }, 30_000);

    sqlIt('an admin upsert to left or removed deletes the row', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await runMutation(fixture, 'carol', joinDescriptor('carol'));
            await writeGrantRow(fixture, grantFor('bob'));
            await writeGrantRow(fixture, grantFor('carol'));

            await runMutation(fixture, 'alice', upsertDescriptor('alice', 'bob', 'left'));
            await runMutation(fixture, 'alice', upsertDescriptor('alice', 'carol', 'removed'));

            const members = (await requireSnapshot(fixture)).members;
            expect(members.find((member) => member.principalId === 'bob')?.status).toBe('left');
            expect(members.find((member) => member.principalId === 'carol')?.status).toBe('removed');
            expect(await findGrantRow(fixture, 'bob')).toBeUndefined();
            expect(await findGrantRow(fixture, 'carol')).toBeUndefined();
        });
    }, 30_000);

    sqlIt('unban then rejoin finds no grant row', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await writeGrantRow(fixture, grantFor('bob'));

            await runMutation(fixture, 'alice', governDescriptor('banGroupMember', 'bob'));
            await runMutation(fixture, 'alice', governDescriptor('unbanGroupMember', 'bob'));
            await runMutation(fixture, 'bob', joinDescriptor('bob', 'rejoin'));

            const snapshot = await requireSnapshot(fixture);
            expect(snapshot.members.find((member) => member.principalId === 'bob')?.status).toBe('active');
            expect(await findGrantRow(fixture, 'bob')).toBeUndefined();
        });
    }, 30_000);

    sqlIt('grant inserts, a second grant updates and a full revoke deletes the row through the write', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            const before = await requireSnapshot(fixture);

            await runMutation(fixture, 'alice', publicationDescriptor('grantGroupPublication', 'publish', 'grant-bob-feed-publish-01'));
            await runMutation(fixture, 'alice', publicationDescriptor('grantGroupPublication', 'subscribe', 'grant-bob-feed-subscribe-01'));
            expect((await findGrantRow(fixture, 'bob'))?.value.topics).toEqual({
                'room.feed': { publish: true, subscribe: true }
            });
            await runMutation(fixture, 'alice', publicationDescriptor('revokeGroupPublication', 'both', 'revoke-bob-feed-both-0001'));

            const after = await requireSnapshot(fixture);
            const events = await fixture.repository.listEvents(REF);
            expect(await findGrantRow(fixture, 'bob')).toBeUndefined();
            expect(after.group.snapshotVersion).toBe(before.group.snapshotVersion + 3);
            expect(after.group.rosterVersion).toBe(before.group.rosterVersion);
            expect(after.group.metadataVersion).toBe(before.group.metadataVersion);
            expect(events.filter((event) => event.eventType === 'publication-grant-changed')).toHaveLength(3);
        });
    }, 30_000);

    sqlIt('archive keeps the grant row', async () => {
        await withGrantSql(backend, async (fixture) => {
            await seedRoomWithBob(fixture);
            await writeGrantRow(fixture, grantFor('bob'));

            await runMutation(
                fixture,
                'alice',
                mutationDescriptor({
                    operation: 'updateGroup',
                    scope: REF,
                    groupId: REF.groupId,
                    request: { status: 'archived', actorPrincipalId: 'alice', requestId: 'archive-grant-room-000001' }
                })
            );

            expect((await requireSnapshot(fixture)).group.status).toBe('archived');
            expect((await findGrantRow(fixture, 'bob'))?.value).toEqual(grantFor('bob'));
        });
    }, 30_000);
});

function grantFor(principalId: string): GroupPublicationGrant {
    return {
        ...REF,
        principalId,
        topics: { 'room.feed': { publish: true, subscribe: true } },
        updated: {
            atEpochMs: 1_000,
            actor: { kind: 'principal', principalId: 'alice' },
            reason: null,
            traceId: null,
            requestId: `grant-${principalId}-feed-0000001`
        }
    };
}

async function writeGrantRow(fixture: GrantSqlFixture, grant: GroupPublicationGrant): Promise<void> {
    await fixture.runtime.upsert(
        PUBLICATION_GRANTS_NAMESPACE,
        groupStatePublicationGrantStorageKey(grant, grant.principalId),
        JSON.stringify(grant),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
}

async function findGrantRow(fixture: GrantSqlFixture, principalId: string) {
    const entry = await fixture.runtime.findEntry(
        PUBLICATION_GRANTS_NAMESPACE,
        groupStatePublicationGrantStorageKey(REF, principalId)
    );
    return entry === undefined ? undefined : { entry, value: JSON.parse(entry.value) as GroupPublicationGrant };
}

async function requireSnapshot(fixture: GrantSqlFixture) {
    const snapshot = await fixture.repository.readSnapshot(REF);
    if (snapshot === undefined) {
        throw new Error('Grant room snapshot is missing');
    }
    return snapshot;
}

async function seedRoomWithBob(fixture: GrantSqlFixture): Promise<void> {
    await runMutation(
        fixture,
        'alice',
        mutationDescriptor({
            operation: 'createGroup',
            scope: REF,
            groupId: REF.groupId,
            request: {
                groupId: REF.groupId,
                displayName: 'Grant room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'alice',
                actorPrincipalId: 'alice',
                requestId: 'create-grant-room-000001'
            }
        })
    );
    await runMutation(fixture, 'bob', joinDescriptor('bob'));
}

function joinDescriptor(principalId: string, label = 'join'): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: 'joinGroup',
        scope: REF,
        groupId: REF.groupId,
        request: { actorPrincipalId: principalId, requestId: `${label}-${principalId}-grant-room-0001` }
    });
}

function upsertDescriptor(
    actorPrincipalId: string,
    targetPrincipalId: string,
    status: 'left' | 'removed'
): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: 'upsertMember',
        scope: REF,
        groupId: REF.groupId,
        targetPrincipalId,
        request: { status, actorPrincipalId, requestId: `upsert-${actorPrincipalId}-${targetPrincipalId}-${status}-01` }
    });
}

function governDescriptor(
    operation: 'removeGroupMember' | 'banGroupMember' | 'unbanGroupMember',
    targetPrincipalId: string
): GroupMutationDescriptor {
    return mutationDescriptor({
        operation,
        scope: REF,
        groupId: REF.groupId,
        targetPrincipalId,
        request: { actorPrincipalId: 'alice', requestId: `${operation}-${targetPrincipalId}-grant-0001` }
    });
}

function publicationDescriptor(
    operation: 'grantGroupPublication' | 'revokeGroupPublication',
    permissions: 'publish' | 'subscribe' | 'both',
    requestId: string
): GroupMutationDescriptor {
    return mutationDescriptor({
        operation,
        scope: REF,
        groupId: REF.groupId,
        targetPrincipalId: 'bob',
        request: {
            topicId: 'room.feed',
            publish: permissions !== 'subscribe',
            subscribe: permissions !== 'publish',
            actorPrincipalId: 'alice',
            requestId
        }
    });
}

async function runMutation(
    fixture: GrantSqlFixture,
    principalId: string,
    descriptor: GroupMutationDescriptor
): Promise<void> {
    const session = createTestAuthSession(principalId);
    await new AuthSessionRepository(fixture.runtime).putSession(session);
    const ingress = await fixture.mutations.captureMutationIngress(descriptor, session);
    const command = {
        ...ingress,
        facts: toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: 1,
            laneNowEpochMs: fixture.nowEpochMs,
            traceId: 'trace-group-publication-grant-sql'
        })
    };
    const read = await fixture.mutations.read(command);
    const computed = fixture.mutations.compute(command, read);
    expect(fixture.mutations.validate(command, read, computed)).toEqual([]);
    if (computed.outcome !== 'write') {
        throw new Error(`Expected a ${descriptor.operation} write, received ${computed.outcome}`);
    }
    await fixture.sql.begin((transaction) => fixture.mutations.write(transaction, computed));
}

async function withGrantSql(
    backend: ResourceInboxTestBackend,
    run: (fixture: GrantSqlFixture) => Promise<void>
): Promise<void> {
    const storage = await createResourceInboxTestStorage('publication_grants', 2, backend);
    try {
        const runtime = new PSqlRuntimeStateRepository(storage.sql);
        const events = new PSqlGroupStateEventRepository(storage.sql);
        const mutations = createGroupStateService({
            runtimeRepository: runtime,
            groupStateEventStore: events,
            finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
            readPlannedLayoutRow: async () => null,
            readAcceptedLayoutRow: async () => null,
            serviceId: 'grant-sql-test',
            now: () => Date.now()
        });
        await run({
            sql: storage.sql,
            runtime,
            repository: new GroupStateRepository(runtime, events),
            mutations,
            nowEpochMs: Date.now()
        });
    }
    finally {
        await storage.close();
    }
}
