import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor, GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import type { GroupCohortAdmissionParticipant } from '@shared-server/rallar-system/group-state/mutation/membership/compute-group-cohort-admission.ts';
import { computeGroupMutation, type GroupMutationInput } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../../queuebox/resource-inbox-test-storage.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';

export interface GroupMoveTestDatabase {
    readonly storage: ResourceInboxTestStorage;
    readonly repository: GroupStateRepository;
    readonly runtime: PSqlRuntimeStateRepository;
    readonly auth: AuthSessionRepository;
    readonly service: GroupStateService;
    readonly nowEpochMs: number;
    prepare(descriptor: GroupMutationDescriptor, principalId: string): Promise<GroupMutationInput>;
    join(principalId: string): Promise<GroupCohortAdmissionParticipant>;
}

export const DESTINATION = { applicationId: 'move-test', workspaceId: 'default', groupId: 'destination' };

export async function createGroupMoveTestDatabase(): Promise<GroupMoveTestDatabase> {
    const storage = await createResourceInboxTestStorage('group_move_admission', 4);
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const events = new PSqlGroupStateEventRepository(storage.sql);
    const repository = new GroupStateRepository(runtime, events);
    const auth = new AuthSessionRepository(runtime);
    const nowEpochMs = Date.now();
    const service = createGroupStateService({
        runtimeRepository: runtime,
        groupStateEventStore: events,
        finishedRetentionMs: TEST_APP_INBOX_FINISHED_RETENTION_MS,
        serviceId: 'group-move-test',
        now: () => nowEpochMs,
        readPlannedLayoutRow: async () => null,
        readAcceptedLayoutRow: async () => null
    });
    async function prepare(descriptor: GroupMutationDescriptor, principalId: string): Promise<GroupMutationInput> {
        const session = createTestAuthSession(principalId);
        await auth.putSession(session);
        const ingress = await service.captureMutationIngress(descriptor, session);
        const command = {
            ...ingress,
            facts: toGroupMutationAttemptFacts({ ingressFacts: ingress.facts, attemptCount: 1, laneNowEpochMs: nowEpochMs, traceId: 'trace-move-transaction' })
        };
        return { command: command.command, facts: command.facts, read: await service.read(command) };
    }
    await seedDestination(storage, prepare);
    async function join(principalId: string): Promise<GroupCohortAdmissionParticipant> {
        const prepared = await prepare(
            mutationDescriptor({
                operation: 'joinGroup',
                scope: DESTINATION,
                groupId: DESTINATION.groupId,
                request: { requestId: `move-${principalId}`, actorPrincipalId: principalId, participation: 'player' }
            }),
            principalId
        );
        if (prepared.command.operation !== 'joinGroup') {
            throw new Error('Expected the participant join');
        }
        return { ...prepared, command: prepared.command };
    }
    return { storage, repository, runtime, auth, service, join, prepare, nowEpochMs };
}

async function seedDestination(
    storage: ResourceInboxTestStorage,
    prepare: GroupMoveTestDatabase['prepare']
): Promise<void> {
    const create = await prepare(
        mutationDescriptor({
            operation: 'createGroup',
            scope: DESTINATION,
            groupId: DESTINATION.groupId,
            request: {
                requestId: 'create',
                groupId: DESTINATION.groupId,
                displayName: 'Destination',
                kind: 'room',
                joinMode: 'open',
                maxMembers: 3,
                createdByPrincipalId: 'alice'
            }
        }),
        'alice'
    );
    const created = computeGroupMutation(create);
    if (created.outcome !== 'write') {
        throw new Error('Expected a created destination');
    }
    await storage.sql.begin((transaction) => writeGroupMutation(transaction, created));
}
