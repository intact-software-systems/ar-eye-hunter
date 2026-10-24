import { expect } from 'vitest';

import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type {
    GroupMutationDescriptor,
    GroupMutationIngress,
    GroupStateService
} from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { GroupMutationComputed, GroupMutationComputedWrite } from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { GroupRetentionService } from '@shared-server/rallar-system/group-state/retention/group-retention-service.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../../queuebox/resource-inbox-test-storage.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';

export const RETENTION_REF = { applicationId: 'retention-app', workspaceId: 'retention-workspace', groupId: 'temporary-room' };

export interface RetentionDatabaseFixture {
    readonly storage: ResourceInboxTestStorage;
    readonly runtime: PSqlRuntimeStateRepository;
    readonly repository: GroupStateRepository;
    readonly mutations: GroupStateService;
    readonly retention: GroupRetentionService;
    readonly owner: IssuedAuthSession;
    nowEpochMs: number;
}

export async function createRetentionDatabaseFixture(): Promise<RetentionDatabaseFixture> {
    const storage = await createResourceInboxTestStorage('group_retention', 4);
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const events = new PSqlGroupStateEventRepository(storage.sql);
    const repository = new GroupStateRepository(runtime, events);
    const clock = { nowEpochMs: Date.now() };
    const config = { serviceId: 'retention-test', now: () => clock.nowEpochMs };
    const mutations = createGroupStateService({
        runtimeRepository: runtime,
        groupStateEventStore: events,
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null,
        ...config
    });
    const owner = createTestAuthSession('owner');
    await new AuthSessionRepository(runtime).putSession(owner);
    const retention = new GroupRetentionService({ repository, groupOwnedAppData: { read: async () => [] } }, config);
    return Object.assign(clock, { storage, runtime, repository, mutations, retention, owner });
}

export async function seedRetentionRoom(fixture: RetentionDatabaseFixture): Promise<void> {
    const { computed } = await prepareMutation(
        fixture,
        mutationDescriptor({
            operation: 'createGroup',
            scope: RETENTION_REF,
            groupId: RETENTION_REF.groupId,
            request: {
                requestId: 'create-retention',
                groupId: RETENTION_REF.groupId,
                displayName: 'Retained room',
                kind: 'room',
                joinMode: 'open',
                createdByPrincipalId: 'owner',
                actorPrincipalId: 'owner',
                retention: { mode: 'temporary', reconnectGraceMs: 1_000 }
            }
        })
    );
    await commitMutation(fixture, requireMutationWrite(computed));
}

export async function prepareMutation(fixture: RetentionDatabaseFixture, descriptor: GroupMutationDescriptor) {
    const ingress = await fixture.mutations.captureMutationIngress(descriptor, fixture.owner);
    return { ingress, computed: await retryMutation(fixture, ingress) };
}

export async function retryMutation(fixture: RetentionDatabaseFixture, ingress: GroupMutationIngress): Promise<GroupMutationComputed> {
    const command = { ...ingress, facts: toGroupMutationAttemptFacts(ingress.facts, 1, fixture.nowEpochMs) };
    const read = await fixture.mutations.read(command);
    const computed = fixture.mutations.compute(command, read);
    expect(fixture.mutations.validate(command, read, computed)).toEqual([]);
    return computed;
}

export function requireMutationWrite(computed: GroupMutationComputed): GroupMutationComputedWrite {
    if (computed.outcome !== 'write') {
        throw new Error(`Expected group write, received ${computed.outcome}`);
    }
    return computed;
}

export async function commitMutation(fixture: RetentionDatabaseFixture, computed: GroupMutationComputedWrite): Promise<void> {
    await fixture.storage.sql.begin((transaction) => fixture.mutations.write(transaction, computed));
}

export async function prepareRetention(fixture: RetentionDatabaseFixture, requestId: string) {
    const ingress = fixture.retention.capture({ groupRef: RETENTION_REF, requestId, observedAtEpochMs: fixture.nowEpochMs });
    const read = await fixture.retention.read(ingress, 1);
    const computed = fixture.retention.compute(read);
    expect(fixture.retention.validate(read, computed)).toEqual([]);
    return { ingress, computed };
}

export async function commitRetention(fixture: RetentionDatabaseFixture, computed: GroupRetentionService.Computed): Promise<void> {
    await fixture.storage.sql.begin((transaction) => fixture.retention.write(transaction, computed));
}
