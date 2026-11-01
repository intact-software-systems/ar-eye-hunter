import { mutationDescriptor, toGroupMutationEventId } from '../group-state/group-mutation-authority.ts';
import {
    toAggregateMutationCommand,
    toMembershipMutationCommand
} from '../group-state/group-mutation-command.ts';
import type { GroupMutationCommand, GroupMutationFacts } from '../group-state/mutation/group-mutation-contracts.ts';
import type { NewGroupCohortAdmissionInput } from '../group-state/mutation/membership/compute-new-group-cohort-admission.ts';
import { readGroupMutation } from '../group-state/mutation/read/read-group-mutation.ts';
import type { GroupStateRepository } from '../group-state/persistence/group-state-repository.ts';
import { computeSha256CanonicalJson } from '../protocol/canonical-json.ts';
import { computeMutationCommandDigest, decodeJsonWireValue } from '../protocol/json-wire-identity.ts';
import type { MatchmakingCommand } from './matchmaking-command.ts';
import type { MatchmakingActor, MatchmakingProposal } from './matchmaking-pool.ts';

export interface MatchmakingAdmissionReadInput {
    readonly groups: GroupStateRepository;
    readonly proposal: MatchmakingProposal;
    readonly command: MatchmakingCommand;
    readonly nowEpochMs: number;
    readonly attemptCount: number;
    readonly traceId: string;
    readonly finishedRetentionMs: number;
}

/** Consent comes from the fenced matchmaking cohort; group state still owns creation and admission policy. */
export async function readMatchmakingAdmission(
    input: MatchmakingAdmissionReadInput
): Promise<NewGroupCohortAdmissionInput> {
    const leader = input.proposal.participants[0]!;
    const create = toMatchmakingCreateCommand(input.proposal, leader);
    const creation = {
        command: create,
        facts: admissionFacts(input, create),
        read: (await readGroupMutation(input.groups, create, leader.sessionId)).read
    };
    const participants = await Promise.all(
        input.proposal.participants.slice(1).map(async (actor) => {
            const command = toMatchmakingJoinCommand(input.proposal, actor);
            return {
                command,
                facts: admissionFacts(input, command),
                read: (await readGroupMutation(input.groups, command, actor.sessionId)).read
            };
        })
    );
    return { creation, participants };
}

function toMatchmakingCreateCommand(proposal: MatchmakingProposal, leader: MatchmakingActor): GroupMutationCommand {
    const { roomRef } = proposal;
    return toAggregateMutationCommand(
        mutationDescriptor({
            operation: 'createGroup',
            scope: roomRef,
            groupId: roomRef.groupId,
            request: {
                requestId: `match-create:${roomRef.groupId}`,
                groupId: roomRef.groupId,
                displayName: 'Matched room',
                kind: 'room',
                joinMode: 'open',
                directoryListing: 'unlisted',
                maxMembers: proposal.participants.length,
                retention: { mode: 'temporary' },
                createdByPrincipalId: leader.principalId,
                actorPrincipalId: leader.principalId,
                actorSessionId: leader.sessionId
            }
        }),
        () => roomRef.groupId
    );
}

function toMatchmakingJoinCommand(
    proposal: MatchmakingProposal,
    actor: MatchmakingActor
): Extract<GroupMutationCommand, { operation: 'joinGroup' | 'acceptGroupInvite'; }> {
    const { roomRef } = proposal;
    const command = toMembershipMutationCommand(
        mutationDescriptor({
            operation: 'joinGroup',
            scope: roomRef,
            groupId: roomRef.groupId,
            request: {
                requestId: `match-join:${
                    computeSha256CanonicalJson({ roomRef, principalId: actor.principalId }).slice(0, 32)
                }`,
                actorPrincipalId: actor.principalId,
                actorSessionId: actor.sessionId,
                participation: 'player'
            }
        }),
        () => roomRef.groupId
    );
    if (command.operation !== 'joinGroup') {
        throw new TypeError('Matchmaking requires an ordinary player join');
    }
    return command;
}

function admissionFacts(input: MatchmakingAdmissionReadInput, command: GroupMutationCommand): GroupMutationFacts {
    const { capturedAtEpochMs, serviceId } = input.command;
    if (
        capturedAtEpochMs === null || serviceId === null || command.input.actorPrincipalId === null ||
        command.input.actorSessionId === null
    ) {
        throw new TypeError('Matchmaking admission requires captured facts and consenting authority');
    }
    const commandHash = computeMutationCommandDigest(decodeJsonWireValue(command, 'Matchmaking group command'));
    return {
        nowEpochMs: capturedAtEpochMs,
        expireAtEpochMs: capturedAtEpochMs + input.finishedRetentionMs,
        serviceId,
        commandHash,
        eventId: toGroupMutationEventId(commandHash, capturedAtEpochMs),
        resolvedJoinCode: null,
        joinCodeVerifier: null,
        internalAuthority: 'none',
        capacity: { defaultMaxMembers: input.proposal.participants.length },
        authenticatedAuthority: {
            principalId: command.input.actorPrincipalId,
            sessionId: command.input.actorSessionId
        },
        attemptAtEpochMs: input.nowEpochMs,
        attemptCount: input.attemptCount,
        traceId: input.traceId
    };
}
