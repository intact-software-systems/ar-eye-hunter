import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import type {
    GroupMutationComputed,
    GroupMutationComputedWrite
} from '@shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts';
import { toGroupMutationAttemptFacts } from '@shared-server/rallar-system/group-state/mutation/to-group-mutation-attempt-facts.ts';
import { PUBLICATION_GRANTS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';
import { groupStatePublicationGrantStorageKey } from '@shared-server/rallar-system/group-state/persistence/publication/group-publication-grant-storage-key.ts';
import type {
    GroupPublicationGrant,
    GroupPublicationTopicGrants
} from '@shared/api/group-publication/group-publication-grants.ts';
import type { GrantGroupPublicationRequest } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import type { GroupBarrierRepository } from '../group-state-concurrency-test-runtime.ts';
import { createTestAuthSession } from '../group-state-test-runtime.ts';
import { createService } from '../presence/group-presence-test-runtime.ts';
import { groupRef, SCOPE } from './group-mutation-test-runtime.ts';

export const GRANT_ROOM = 'grant-room';

export type PublicationOperation = 'grantGroupPublication' | 'revokeGroupPublication';

export interface PublicationIntent {
    readonly topicId: string;
    readonly publish: boolean;
    readonly subscribe: boolean;
}

export interface PublicationDescriptorInput extends PublicationIntent {
    readonly operation: PublicationOperation;
    readonly actorPrincipalId: string;
    readonly targetPrincipalId: string;
    readonly requestId: string;
    readonly groupId?: string;
}

/**
 * alice owns the room; bob and erin are members, carol and dave admins, sam a spectator, lee has left and ivy is
 * invited. The room expires at `expiresAtEpochMs` when one is named.
 */
export async function seedGrantRoom(
    runtime: GroupBarrierRepository,
    expiresAtEpochMs?: number
): Promise<void> {
    const service = createService(runtime, 1_000);
    await service.createGroup(SCOPE, {
        groupId: GRANT_ROOM,
        displayName: GRANT_ROOM,
        kind: 'room',
        joinMode: 'open',
        maxMembers: 10,
        maxSpectators: 2,
        createdByPrincipalId: 'alice',
        ...(expiresAtEpochMs === undefined ? {} : { expiresAtEpochMs }),
        requestId: 'seed-grant-room'
    });
    for (const principalId of ['bob', 'carol', 'dave', 'erin', 'lee']) {
        await service.joinGroup(SCOPE, GRANT_ROOM, { actorPrincipalId: principalId, requestId: `join-${principalId}` });
    }
    await service.joinGroup(SCOPE, GRANT_ROOM, {
        actorPrincipalId: 'sam',
        participation: 'spectator',
        requestId: 'watch-sam'
    });
    for (const principalId of ['carol', 'dave']) {
        await service.setGroupMemberRole(SCOPE, GRANT_ROOM, principalId, {
            role: 'admin',
            actorPrincipalId: 'alice',
            requestId: `promote-${principalId}`
        });
    }
    await service.upsertMember(SCOPE, GRANT_ROOM, 'lee', {
        status: 'left',
        actorPrincipalId: 'lee',
        requestId: 'leave-lee'
    });
    await service.createGroupInvite(SCOPE, GRANT_ROOM, 'ivy', { actorPrincipalId: 'alice', requestId: 'invite-ivy' });
}

export function toPublicationRequest(input: PublicationDescriptorInput): GrantGroupPublicationRequest {
    return {
        topicId: input.topicId,
        publish: input.publish,
        subscribe: input.subscribe,
        actorPrincipalId: input.actorPrincipalId,
        requestId: input.requestId
    };
}

export function publicationDescriptor(input: PublicationDescriptorInput): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: input.operation,
        scope: SCOPE,
        groupId: input.groupId ?? GRANT_ROOM,
        targetPrincipalId: input.targetPrincipalId,
        request: toPublicationRequest(input)
    });
}

/** The read and compute phases of one attempt of a publication command, without its write. */
export async function computePublicationMutation(
    runtime: GroupBarrierRepository,
    input: PublicationDescriptorInput,
    nowEpochMs = 3_000
) {
    return await computeDescriptorMutation(runtime, input.actorPrincipalId, publicationDescriptor(input), nowEpochMs);
}

/** The read and compute phases of one attempt of any command, without its write. */
export async function computeDescriptorMutation(
    runtime: GroupBarrierRepository,
    actorPrincipalId: string,
    descriptor: GroupMutationDescriptor,
    nowEpochMs = 3_000
) {
    const service = createService(runtime, nowEpochMs);
    const session = createTestAuthSession(actorPrincipalId);
    await new AuthSessionRepository(runtime).putSession(session);
    const ingress = await service.captureMutationIngress(descriptor, session);
    const command = {
        ...ingress,
        facts: toGroupMutationAttemptFacts({
            ingressFacts: ingress.facts,
            attemptCount: 1,
            laneNowEpochMs: nowEpochMs,
            traceId: 'trace-group-publication-grant'
        })
    };
    const read = await service.read(command);
    return { service, command, read, computed: service.compute(command, read) };
}

export async function applyPublicationMutation(
    runtime: GroupBarrierRepository,
    input: PublicationDescriptorInput,
    attemptCount = 1
) {
    const service = createService(runtime, 3_000, attemptCount);
    const request = toPublicationRequest(input);
    return input.operation === 'grantGroupPublication'
        ? await service.grantGroupPublication(SCOPE, input.groupId ?? GRANT_ROOM, input.targetPrincipalId, request)
        : await service.revokeGroupPublication(SCOPE, input.groupId ?? GRANT_ROOM, input.targetPrincipalId, request);
}

export async function readGrantRow(
    runtime: GroupBarrierRepository,
    principalId: string
): Promise<GroupPublicationGrant | undefined> {
    const entry = await runtime.findEntry(
        PUBLICATION_GRANTS_NAMESPACE,
        groupStatePublicationGrantStorageKey(groupRef(GRANT_ROOM), principalId)
    );
    return entry === undefined ? undefined : JSON.parse(entry.value) as GroupPublicationGrant;
}

export async function writeGrantRow(
    runtime: GroupBarrierRepository,
    principalId: string,
    topics: GroupPublicationTopicGrants
): Promise<void> {
    const grant: GroupPublicationGrant = {
        ...groupRef(GRANT_ROOM),
        principalId,
        topics,
        updated: {
            atEpochMs: 1_500,
            actor: { kind: 'principal', principalId: 'alice' },
            reason: null,
            traceId: null,
            requestId: `grant-${principalId}-seed`
        }
    };
    await runtime.upsert(
        PUBLICATION_GRANTS_NAMESPACE,
        groupStatePublicationGrantStorageKey(grant, principalId),
        JSON.stringify(grant),
        NEVER_EXPIRE_AT_TIMESTAMP
    );
}

export function toTopicGrants(count: number): GroupPublicationTopicGrants {
    return Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
            `room.topic-${String(index).padStart(2, '0')}`,
            { publish: true, subscribe: false }
        ])
    );
}

export function requireWrite(computed: GroupMutationComputed): GroupMutationComputedWrite {
    if (computed.outcome !== 'write') {
        throw new Error(`Expected a write, received ${computed.outcome}`);
    }
    return computed;
}
