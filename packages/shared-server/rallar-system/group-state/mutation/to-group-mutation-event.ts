import type {
    Group,
    GroupEvent,
    GroupEventType,
    GroupMember,
    GroupStateCausalRevision
} from '@shared/api/group-types.ts';
import type { MutationActor } from '@shared/api/mutation-actor.ts';

import type {
    GroupMutationCommand,
    GroupMutationFacts,
    GroupPublicationGrantEffect,
    GroupPublicationGrantOperation
} from './group-mutation-contracts.ts';
import { GroupMutationRejectedError } from './group-mutation-contracts.ts';

export interface GroupMutationEventInput {
    readonly eventType: GroupEventType;
    readonly group: Group;
    readonly causalRevision: GroupStateCausalRevision;
    readonly command: GroupMutationCommand;
    readonly facts: GroupMutationFacts;
    readonly members: readonly GroupMember[];
    readonly publicationGrantEffects: readonly GroupPublicationGrantEffect[];
}

export function toGroupMutationActor(
    command: GroupMutationCommand,
    facts: GroupMutationFacts,
    defaultPrincipalId: string | undefined
): MutationActor {
    const principalId = command.input.actorPrincipalId ?? defaultPrincipalId;
    if (command.input.actorSessionId !== null) {
        if (!principalId) {
            throw new GroupMutationRejectedError('A session actor requires a principal identity.');
        }
        return {
            kind: 'session',
            sessionId: command.input.actorSessionId,
            principalId
        };
    }
    if (principalId) {
        return { kind: 'principal', principalId };
    }
    return { kind: 'service', serviceId: facts.serviceId };
}

export function toGroupMutationEvent(input: GroupMutationEventInput): GroupEvent {
    const { causalRevision, command, eventType, facts, group } = input;
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        eventId: facts.eventId,
        eventType,
        snapshotVersion: group.snapshotVersion,
        causalRevision,
        occurredAtEpochMs: facts.nowEpochMs,
        actor: toGroupMutationActor(command, facts, undefined),
        reason: command.input.reason,
        traceId: facts.traceId,
        requestId: command.requestId,
        payload: toGroupEventPayload(input)
    };
}

// The actor is whoever issued the command, so a member event must name the
// member it is about itself: a manager's grant emits member-joined with the
// manager as actor and the admitted member only here.
function toGroupEventPayload(
    { eventType, members, command, publicationGrantEffects }: GroupMutationEventInput
): GroupEvent['payload'] {
    if (command.operation === 'reconfigureGroup' || command.operation === 'resetGroupFormation') {
        return { topologyReplanOrigin: 'commanded' };
    }
    if (command.operation === 'grantGroupPublication' || command.operation === 'revokeGroupPublication') {
        return toPublicationGrantChangedPayload(command, publicationGrantEffects);
    }
    if (eventType === 'ownership-transferred') {
        const nextOwner = members.find((member) => member.role === 'owner');
        const previousOwner = members.find((member) => member.role !== 'owner');
        return {
            ...(previousOwner ? { fromPrincipalId: previousOwner.principalId } : {}),
            ...(nextOwner ? { toPrincipalId: nextOwner.principalId } : {})
        };
    }
    if (eventType.startsWith('member-') && members.length === 1) {
        return { principalId: members[0].principalId };
    }
    return {};
}

/** The topic's permissions after the write; a deleted row leaves the principal holding neither. */
function toPublicationGrantChangedPayload(
    command: Extract<GroupMutationCommand, { operation: GroupPublicationGrantOperation; }>,
    effects: readonly GroupPublicationGrantEffect[]
): GroupEvent['payload'] {
    const effect = effects.find((candidate) => candidate.value.principalId === command.targetPrincipalId);
    const permissions = effect === undefined || effect.operation === 'delete'
        ? undefined
        : effect.value.topics[command.input.topicId];
    return {
        principalId: command.targetPrincipalId,
        topicId: command.input.topicId,
        permissions: { publish: permissions?.publish ?? false, subscribe: permissions?.subscribe ?? false }
    };
}
