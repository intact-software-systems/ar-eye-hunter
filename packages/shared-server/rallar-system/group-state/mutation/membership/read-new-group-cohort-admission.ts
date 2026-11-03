import type { GroupRef } from '@shared/api/group-types.ts';
import { computeMutationCommandDigest, decodeJsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { mutationDescriptor, toGroupMutationEventId } from '../../group-mutation-authority.ts';
import {
    toAggregateMutationCommand,
    toMembershipMutationCommand
} from '../../group-mutation-command.ts';
import type { GroupStateRepository } from '../../persistence/group-state-repository.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../group-mutation-contracts.ts';
import { readGroupMutation } from '../read/read-group-mutation.ts';
import type { NewGroupCohortAdmissionInput } from './compute-new-group-cohort-admission.ts';

export interface NewGroupCohortMember {
    readonly principalId: string;
    readonly sessionId: string;
    readonly requestId: string;
}

export interface NewGroupCohortAdmissionReadInput {
    readonly groups: GroupStateRepository;
    readonly roomRef: GroupRef;
    readonly displayName: string;
    readonly participants: readonly NewGroupCohortMember[];
    readonly maxSpectators: number | null;
    readonly capturedAtEpochMs: number;
    readonly serviceId: string;
    readonly nowEpochMs: number;
    readonly attemptCount: number;
    readonly traceId: string;
    readonly finishedRetentionMs: number;
}

/** Consent comes from the caller’s fenced cohort; group state still owns creation and admission policy. */
export async function readNewGroupCohortAdmission(
    input: NewGroupCohortAdmissionReadInput
): Promise<NewGroupCohortAdmissionInput> {
    const leader = input.participants[0];
    if (!leader || new Set(input.participants.map((actor) => actor.principalId)).size !== input.participants.length) {
        throw new TypeError('Cohort admission requires distinct consenting accounts');
    }
    const create = toCohortCreateCommand(input, leader);
    const creation = {
        command: create,
        facts: admissionFacts(input, create),
        read: (await readGroupMutation(input.groups, create, leader.sessionId)).read
    };
    const participants = await Promise.all(
        input.participants.slice(1).map(async (actor) => {
            const command = toCohortJoinCommand(input, actor);
            return {
                command,
                facts: admissionFacts(input, command),
                read: (await readGroupMutation(input.groups, command, actor.sessionId)).read
            };
        })
    );
    return { creation, participants };
}

function toCohortCreateCommand(
    proposal: NewGroupCohortAdmissionReadInput,
    leader: NewGroupCohortMember
): GroupMutationCommand {
    const { roomRef } = proposal;
    return toAggregateMutationCommand(
        mutationDescriptor({
            operation: 'createGroup',
            scope: roomRef,
            groupId: roomRef.groupId,
            request: {
                requestId: leader.requestId,
                groupId: roomRef.groupId,
                displayName: proposal.displayName,
                kind: 'room',
                joinMode: 'open',
                directoryListing: 'unlisted',
                maxMembers: proposal.participants.length,
                ...(proposal.maxSpectators === null ? {} : { maxSpectators: proposal.maxSpectators }),
                retention: { mode: 'temporary' },
                createdByPrincipalId: leader.principalId,
                actorPrincipalId: leader.principalId,
                actorSessionId: leader.sessionId
            }
        }),
        () => roomRef.groupId
    );
}

function toCohortJoinCommand(
    proposal: NewGroupCohortAdmissionReadInput,
    actor: NewGroupCohortMember
): Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }> {
    const { roomRef } = proposal;
    const command = toMembershipMutationCommand(
        mutationDescriptor({
            operation: 'joinGroup',
            scope: roomRef,
            groupId: roomRef.groupId,
            request: {
                requestId: actor.requestId,
                actorPrincipalId: actor.principalId,
                actorSessionId: actor.sessionId,
                participation: 'player'
            }
        }),
        () => roomRef.groupId
    );
    if (command.operation !== 'joinGroup') {
        throw new TypeError('Cohort requires an ordinary player join');
    }
    return command;
}

function admissionFacts(input: NewGroupCohortAdmissionReadInput, command: GroupMutationCommand): GroupMutationFacts {
    const { capturedAtEpochMs, serviceId } = input;
    if (
        command.input.actorPrincipalId === null ||
        command.input.actorSessionId === null
    ) {
        throw new TypeError('Cohort admission requires captured facts and consenting authority');
    }
    const commandHash = computeMutationCommandDigest(decodeJsonWireValue(command, 'Cohort group command'));
    return {
        nowEpochMs: capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + input.finishedRetentionMs,
        serviceId,
        commandHash,
        eventId: toGroupMutationEventId(commandHash, capturedAtEpochMs),
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        capacity: { defaultMaxMembers: input.participants.length },
        authenticatedAuthority: {
            principalId: command.input.actorPrincipalId,
            sessionId: command.input.actorSessionId
        },
        attemptAtEpochMs: input.nowEpochMs,
        attemptCount: input.attemptCount,
        traceId: input.traceId
    };
}
