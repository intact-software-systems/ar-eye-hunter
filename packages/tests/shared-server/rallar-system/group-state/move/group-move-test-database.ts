import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { createGroupStateService } from '@shared-server/rallar-system/group-state/group-state-service.ts';
import { type GroupMoveAdmissionParticipant } from '@shared-server/rallar-system/group-state/move/compute-group-move-admission.ts';
import { computeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { writeGroupMutation } from '@shared-server/rallar-system/group-state/mutation/write/write-group-mutation.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/group-state/persistence/group-state-repository.ts';
import { PSqlGroupStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-group-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';

import { createResourceInboxTestStorage } from '../../../queuebox/resource-inbox-test-storage.ts';
import { TEST_APP_INBOX_FINISHED_RETENTION_MS } from '../../app-inbox/test-support/test-app-inbox-finished-retention.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';

export const DESTINATION = { applicationId: 'move-test', workspaceId: 'default', groupId: 'destination' };

export async function createGroupMoveTestDatabase() {
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
    async function prepare(descriptor: GroupMutationDescriptor, principalId: string) {
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
    async function join(principalId: string): Promise<GroupMoveAdmissionParticipant> {
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
    storage: Awaited<ReturnType<typeof createResourceInboxTestStorage>>,
    prepare: Awaited<ReturnType<typeof createGroupMoveTestDatabase>>['prepare']
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
